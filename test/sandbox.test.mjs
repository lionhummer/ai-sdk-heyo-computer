import assert from 'node:assert/strict';

import {
  createHeyoSandbox,
  createHeyoTools,
} from '../dist/index.js';

let tests = 0;
let passed = 0;
async function test(name, fn) {
  tests += 1;
  try {
    await fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

const SANDBOX_ID = 'dep-test';

/** A files-backed fake of the Heyo cloud HTTP API. */
function makeFetch() {
  const files = new Map();
  const calls = [];

  const fetchImpl = async (url, init = {}) => {
    const { pathname } = new URL(url);
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, pathname, body });

    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    if (pathname === '/sandbox-deploy' && method === 'POST') {
      return json({ id: SANDBOX_ID, status: 'running' });
    }
    if (pathname === `/sandbox/${SANDBOX_ID}/exec` && method === 'POST') {
      const command = String(body?.command ?? '');
      return json({ stdout: `ran: ${command}\n`, stderr: '', exit_code: 0 });
    }
    if (pathname === `/sandbox/${SANDBOX_ID}/write-file` && method === 'POST') {
      files.set(body.file_path, body.content);
      return json({});
    }
    if (pathname === `/sandbox/${SANDBOX_ID}/read-file` && method === 'POST') {
      const content = files.get(body.file_path);
      if (content === undefined) return json({ message: 'not found' }, 404);
      return json({ content });
    }
    if (pathname === '/proxy-endpoints/for-deployed' && method === 'POST') {
      return json({
        subdomain: 'demo',
        hostname: 'demo.heyo.computer',
        url: 'https://demo.heyo.computer',
        port: body.port,
        is_public: true,
      });
    }
    if (pathname === `/deployed-sandboxes/${SANDBOX_ID}` && method === 'DELETE') {
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify({ message: `unhandled ${pathname}` }), {
      status: 500,
    });
  };

  return { fetchImpl, calls };
}

async function newSandbox() {
  const { fetchImpl, calls } = makeFetch();
  const sandbox = await createHeyoSandbox({
    apiKey: 'test-key',
    fetch: fetchImpl,
    waitForReadyMs: 0,
    image: 'ubuntu:24.04',
  });
  return { sandbox, calls };
}

console.log('SDK-backed sandbox tests');

await test('createHeyoSandbox returns a handle with the deployed id', async () => {
  const { sandbox, calls } = await newSandbox();
  assert.equal(sandbox.id, SANDBOX_ID);
  assert.ok(calls.some((c) => c.pathname === '/sandbox-deploy'));
});

await test('run executes a command and maps the result', async () => {
  const { sandbox } = await newSandbox();
  const res = await sandbox.run({ command: 'echo hi' });
  assert.equal(res.exitCode, 0);
  assert.equal(res.stdout, 'ran: echo hi\n');
  assert.equal(res.stderr, '');
});

await test('write then read a text file round-trips', async () => {
  const { sandbox } = await newSandbox();
  await sandbox.writeTextFile({ path: 'note.txt', content: 'hello heyo' });
  const text = await sandbox.readTextFile({ path: 'note.txt' });
  assert.equal(text, 'hello heyo');
});

await test('reading a missing file returns null', async () => {
  const { sandbox } = await newSandbox();
  const text = await sandbox.readTextFile({ path: 'nope.txt' });
  assert.equal(text, null);
});

await test('exposePort returns a public URL', async () => {
  const { sandbox } = await newSandbox();
  const endpoint = await sandbox.exposePort(3000);
  assert.equal(endpoint.url, 'https://demo.heyo.computer');
  assert.equal(endpoint.port, 3000);
});

await test('delete issues a DELETE', async () => {
  const { sandbox, calls } = await newSandbox();
  await sandbox.delete();
  assert.ok(
    calls.some(
      (c) => c.method === 'DELETE' && c.pathname === `/deployed-sandboxes/${SANDBOX_ID}`,
    ),
  );
});

await test('createHeyoTools exposes Anthropic-aligned names', async () => {
  const { sandbox } = await newSandbox();
  const tools = createHeyoTools(sandbox);
  assert.deepEqual(
    Object.keys(tools).sort(),
    ['bash', 'exposePort', 'str_replace_based_edit_tool'],
  );
});

await test('bash tool runs a command', async () => {
  const { sandbox } = await newSandbox();
  const tools = createHeyoTools(sandbox);
  const out = await tools.bash.execute({ command: 'uname -a' }, {});
  assert.equal(out.exitCode, 0);
  assert.match(out.stdout, /uname -a/);
});

await test('editor tool creates then views a file', async () => {
  const { sandbox } = await newSandbox();
  const tools = createHeyoTools(sandbox);
  const editor = tools.str_replace_based_edit_tool;
  const created = await editor.execute(
    { command: 'create', path: 'a.txt', file_text: 'line1\nline2' },
    {},
  );
  assert.match(created.output, /File created/);
  const viewed = await editor.execute({ command: 'view', path: 'a.txt' }, {});
  assert.match(viewed.output, /line1/);
  assert.match(viewed.output, /1\tline1/);
});

await test('editor str_replace edits a unique snippet', async () => {
  const { sandbox } = await newSandbox();
  const tools = createHeyoTools(sandbox);
  const editor = tools.str_replace_based_edit_tool;
  await editor.execute(
    { command: 'create', path: 'b.txt', file_text: 'foo bar baz' },
    {},
  );
  const res = await editor.execute(
    { command: 'str_replace', path: 'b.txt', old_str: 'bar', new_str: 'BAR' },
    {},
  );
  assert.match(res.output, /Replaced 1 occurrence/);
  const text = await sandbox.readTextFile({ path: 'b.txt' });
  assert.equal(text, 'foo BAR baz');
});

console.log(`\n${passed}/${tests} passed`);
if (passed !== tests) process.exit(1);
