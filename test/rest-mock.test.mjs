// Integration test for ai-sdk-heyo-computer.
//
// Spins up an in-process mock of the heyvm HTTP API that actually executes the
// commands it receives (so file I/O, exit codes, env, and working directories
// are exercised for real), then drives the package against it.
//
// Run with: node test/rest-mock.test.mjs   (after `npm run build`)

import http from 'node:http';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { createHeyoSandbox } from '../dist/index.js';

// --- Mock heyvm API server -------------------------------------------------

function startMockServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };

    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      const parts = url.pathname.split('/').filter(Boolean); // ['sandboxes', ':id', 'execute']

      if (url.pathname === '/health') return send(200, { status: 'ok' });

      if (parts[0] === 'sandboxes' && parts.length === 1 && req.method === 'POST') {
        return send(200, {
          id: 'sb-test',
          slug: body.name ?? 'sb-test',
          status: 'running',
          image: body.image,
        });
      }

      if (parts[2] === 'execute' && req.method === 'POST') {
        const result = spawnSync(body.command, body.args ?? [], {
          encoding: 'utf-8',
          maxBuffer: 1024 * 1024 * 16,
        });
        const output = (result.stdout ?? '') + (result.stderr ?? '');
        return send(200, { output, exit_code: result.status ?? 0 });
      }

      if (parts[0] === 'sandboxes' && parts.length === 2 && req.method === 'DELETE') {
        return send(204);
      }

      return send(404, { error: 'not found' });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, apiUrl: `http://127.0.0.1:${port}` });
    });
  });
}

// --- Tiny test harness -----------------------------------------------------

let passed = 0;
let failed = 0;

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ok  - ${name}`);
  } else {
    failed++;
    console.error(`  FAIL - ${name}${detail ? `  (${detail})` : ''}`);
  }
}

async function readStreamToString(stream) {
  const chunks = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

// --- Tests -----------------------------------------------------------------

async function main() {
  const { server, apiUrl } = await startMockServer();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'heyo-it-'));

  const sandbox = await createHeyoSandbox({ apiUrl, image: 'ubuntu:24.04' });
  console.log(`Sandbox: id=${sandbox.id} slug=${sandbox.slug}`);
  console.log(`description: ${sandbox.description}`);

  try {
    // 1. basic run
    const echo = await sandbox.run({ command: 'echo hello' });
    check('run echo stdout', echo.stdout === 'hello\n', JSON.stringify(echo));
    check('run echo exitCode 0', echo.exitCode === 0);

    // 2. non-zero exit code propagation
    const failExit = await sandbox.run({ command: 'exit 7' });
    check('run exit code 7', failExit.exitCode === 7, JSON.stringify(failExit));

    // 3. working directory
    const pwd = await sandbox.run({ command: 'pwd', workingDirectory: tmpDir });
    check('run workingDirectory honored', pwd.stdout.trim().endsWith(path.basename(tmpDir)), pwd.stdout);

    // 4. env
    const env = await sandbox.run({ command: 'echo "$FOO"', env: { FOO: 'bar baz' } });
    check('run env honored', env.stdout === 'bar baz\n', JSON.stringify(env));

    // 5. writeTextFile + readTextFile round-trip
    const textPath = path.join(tmpDir, 'nested', 'hello.txt');
    await sandbox.writeTextFile({ path: textPath, content: 'line1\nline2\nline3\n' });
    const text = await sandbox.readTextFile({ path: textPath });
    check('writeTextFile/readTextFile round-trip', text === 'line1\nline2\nline3\n', JSON.stringify(text));

    // 6. readTextFile with line range
    const range = await sandbox.readTextFile({ path: textPath, startLine: 2, endLine: 2 });
    check('readTextFile line range', range === 'line2', JSON.stringify(range));

    // 7. binary round-trip
    const binPath = path.join(tmpDir, 'data.bin');
    const bytes = new Uint8Array([0, 1, 2, 254, 255, 128]);
    await sandbox.writeBinaryFile({ path: binPath, content: bytes });
    const readBytes = await sandbox.readBinaryFile({ path: binPath });
    check(
      'writeBinaryFile/readBinaryFile round-trip',
      readBytes && Buffer.compare(Buffer.from(readBytes), Buffer.from(bytes)) === 0,
      readBytes ? Array.from(readBytes).join(',') : 'null',
    );

    // 8. readFile (stream) returns content
    const stream = await sandbox.readFile({ path: textPath });
    const streamed = stream ? await readStreamToString(stream) : null;
    check('readFile stream', streamed === 'line1\nline2\nline3\n', JSON.stringify(streamed));

    // 9. missing file -> null
    const missing = await sandbox.readTextFile({ path: path.join(tmpDir, 'nope.txt') });
    check('readTextFile missing -> null', missing === null, JSON.stringify(missing));

    // 10. spawn (blocking emulation)
    const proc = await sandbox.spawn({ command: 'echo spawned' });
    const spawnOut = await readStreamToString(proc.stdout);
    const { exitCode } = await proc.wait();
    await proc.kill();
    check('spawn stdout', spawnOut === 'spawned\n', JSON.stringify(spawnOut));
    check('spawn exitCode', exitCode === 0);
  } finally {
    await sandbox.delete();
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
