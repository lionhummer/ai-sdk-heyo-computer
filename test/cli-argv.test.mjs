// Verifies the exact `heyvm` argv the CLI transport generates, without spawning
// the binary (dryRun mode). Run with: node test/cli-argv.test.mjs

import {
  createHeyoSandbox,
  createHeyoVolume,
  listHeyoVolumes,
  removeHeyoVolume,
  createHeyoWorktreeSandbox,
  createHeyoTools,
} from '../dist/index.js';

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
const joined = (argv) => argv.join(' ');

async function main() {
  const sandbox = await createHeyoSandbox({
    transport: 'cli',
    dryRun: true,
    cloudUrl: 'https://server.heyo.computer',
    name: 'demo',
    image: 'ubuntu:24.04',
    cloud: true,
    region: 'US',
    sizeClass: 'small',
    cloudPorts: [8080],
    healthPath: '/health',
    envVars: { NODE_ENV: 'production' },
    volumes: ['data'],
    agent: 'claude',
  });

  const calls = sandbox.transport.calls;
  const create = joined(calls[0]);
  check('create subcommand', calls[0][0] === 'create', create);
  check('create --format json', create.includes('--format json'));
  check('create --cloud-url', create.includes('--cloud-url https://server.heyo.computer'));
  check('create --cloud --region US', create.includes('--cloud') && create.includes('--region US'));
  check('create --size-class small', create.includes('--size-class small'));
  check('create cloud --port 8080', create.includes('--port 8080'));
  check('create --health-path', create.includes('--health-path /health'));
  check('create --env NODE_ENV', create.includes('--env NODE_ENV=production'));
  check('create --volume data', create.includes('--volume data'));
  check('create --agent claude', create.includes('--agent claude'));

  await sandbox.run({ command: 'echo hi', workingDirectory: '/workspace', env: { FOO: 'bar' } });
  const exec1 = joined(calls.at(-1));
  check('exec subcommand + id', calls.at(-1)[0] === 'exec' && calls.at(-1)[1] === 'sb-dryrun', exec1);
  check('exec --format json', exec1.includes('--format json'));
  check('exec --env native', exec1.includes('--env FOO=bar'));
  check('exec passes bash -lc with cd', exec1.includes("-- bash -lc cd '/workspace' && echo hi"));

  await sandbox.exec({ command: 'ls', session: 'sess1', timeoutMs: 30000 });
  const exec2 = joined(calls.at(-1));
  check('exec --session', exec2.includes('--session sess1'));
  check('exec --timeout 30s', exec2.includes('--timeout 30s'));

  await sandbox.fork({ name: 'reviewer' });
  const fork = joined(calls.at(-1));
  check('fork argv', fork.startsWith('fork sb-dryrun') && fork.includes('--name reviewer') && fork.includes('--format json'));

  await sandbox.archive({ name: 'snap1' });
  const archive = joined(calls.at(-1));
  check('archive argv', archive.startsWith('archive sb-dryrun') && archive.includes('--name snap1'));

  await sandbox.resize('medium');
  const resize = joined(calls.at(-1));
  check('resize argv', resize === 'resize sb-dryrun --size-class medium --cloud-url https://server.heyo.computer', resize);

  await sandbox.exposePort(3000, { private: true });
  const bind = joined(calls.at(-1));
  check('bind argv', bind.startsWith('bind sb-dryrun 3000') && bind.includes('--format json') && bind.includes('--private'));

  await sandbox.expose();
  check('expose argv', joined(calls.at(-1)).startsWith('expose sb-dryrun'));

  await sandbox.unexpose();
  check('unexpose argv', joined(calls.at(-1)).startsWith('unexpose sb-dryrun'));

  await sandbox.runHost(['git', 'status'], { mountPath: '/workspace' });
  const runHost = joined(calls.at(-1));
  check('run-host argv', runHost.startsWith('run-host sb-dryrun') && runHost.includes('--mount-path /workspace') && runHost.endsWith('-- git status'), runHost);

  await sandbox.update('arch-123', { mountPath: '/workspace' });
  const update = joined(calls.at(-1));
  check('update argv', update.startsWith('update sb-dryrun --archive arch-123') && update.includes('--mount-path /workspace'), update);

  await sandbox.syncPush({ to: 'heyo://ticket', includeMemory: true });
  const sync = joined(calls.at(-1));
  check('sync push argv', sync.startsWith('sync push sb-dryrun') && sync.includes('--to heyo://ticket') && sync.includes('--include-memory'), sync);

  let blocked = false;
  try { await sandbox.syncPush({}); } catch { blocked = true; }
  check('sync push without to/cloud throws', blocked);

  await sandbox.createWebhook('echo {{payload.data}}', { inactive: true });
  const webhook = joined(calls.at(-1));
  check('webhook create argv', webhook.startsWith('webhook create sb-dryrun --command') && webhook.includes('--inactive'), webhook);

  // Volumes (standalone, account/host scoped)
  await createHeyoVolume('data', { transport: 'cli', dryRun: true, from: '/seed', mountPath: '/data' });
  await listHeyoVolumes({ transport: 'cli', dryRun: true });
  await removeHeyoVolume('data', { transport: 'cli', dryRun: true, purge: true });

  // Worktree (detached + deploy)
  const wtLocal = await createHeyoWorktreeSandbox({ branch: 'feat/x', createBranch: true, dryRun: true });
  const wtCall = joined(wtLocal.transport.calls.at(-1));
  check('wt detached argv', wtCall.startsWith('wt feat/x') && wtCall.includes('--create-branch') && wtCall.includes('--detach'), wtCall);

  const wtDeploy = await createHeyoWorktreeSandbox({ branch: 'feat/y', deploy: true, deployRegion: 'EU', deployPorts: [8080], dryRun: true });
  const wtDeployCall = joined(wtDeploy.transport.calls.at(-1));
  check('wt deploy argv', wtDeployCall.includes('--deploy') && wtDeployCall.includes('--deploy-region EU') && wtDeployCall.includes('--deploy-port 8080') && !wtDeployCall.includes('--detach'), wtDeployCall);

  // Login: apiKey establishes a cloud session via `heyvm login --api-key`
  const authed = await createHeyoSandbox({
    transport: 'cli',
    dryRun: true,
    cloudUrl: 'https://server.heyo.computer',
    authUrl: 'https://auth.heyo.computer',
    apiKey: 'heyo_api_secret',
    name: 'authed',
  });
  await authed.transport.login();
  const login = joined(authed.transport.calls.at(-1));
  check('login argv', login.startsWith('login --api-key heyo_api_secret') && login.includes('--cloud-url https://server.heyo.computer') && login.includes('--auth-url https://auth.heyo.computer'), login);

  // Self-hosted cloud: --cloud-url AND --auth-url must reach every subcommand,
  // not just `login` (e.g. pointing the CLI at your own Heyo stack).
  await authed.exec({ command: 'true' });
  const authedExec = joined(authed.transport.calls.at(-1));
  check('self-host exec carries cloud+auth url', authedExec.startsWith('exec') && authedExec.includes('--cloud-url https://server.heyo.computer') && authedExec.includes('--auth-url https://auth.heyo.computer'), authedExec);

  // Tools: env-aware description + expected tool names
  check('description is environment-aware', /Heyo \(heyvm\) microVM sandbox/.test(sandbox.description) && sandbox.description.includes('transport: cli'), sandbox.description);
  const tools = createHeyoTools(sandbox, { prefix: 'heyo' });
  check('createHeyoTools names', typeof tools.heyoRunCommand?.execute === 'function' && typeof tools.heyoReadTextFile?.execute === 'function' && typeof tools.heyoWriteTextFile?.execute === 'function');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
