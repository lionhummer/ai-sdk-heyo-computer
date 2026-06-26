// Live test against the real `heyvm` binary using the macOS sandbox_exec backend
// (no image pull needed). Proves the CLI transport end-to-end: create, real
// stdout/stderr split, native env, file round-trip, fork, and cleanup.
//
// Skips gracefully if the heyvm binary is not found.
// Run with: node test/cli-live.test.mjs

import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import {
  createHeyoSandbox,
  createHeyoVolume,
  listHeyoVolumes,
  heyoVolumePath,
  removeHeyoVolume,
} from '../dist/index.js';

// Make ~/.local/bin discoverable (default heyvm install location).
process.env.PATH = `${path.join(os.homedir(), '.local', 'bin')}:/usr/local/bin:${process.env.PATH ?? ''}`;

const probe = spawnSync('heyvm', ['--help'], { encoding: 'utf-8' });
if (probe.error) {
  console.log('SKIP: heyvm binary not found on PATH.');
  process.exit(0);
}

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

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'heyo-cli-'));
  const sandbox = await createHeyoSandbox({
    transport: 'cli',
    name: `aisdk-clitest-${Date.now()}`,
    sandboxType: 'shell',
    backendType: 'sandbox_exec',
    noTtl: true,
  });
  console.log(`Live sandbox: ${sandbox.id} (transport: ${sandbox.transport.kind})`);

  let fork;
  try {
    const echo = await sandbox.run({ command: 'echo hello' });
    check('run stdout', echo.stdout === 'hello\n', JSON.stringify(echo));
    check('run exitCode 0', echo.exitCode === 0);

    // The headline win: REAL stdout/stderr separation over the CLI transport.
    const split = await sandbox.run({ command: 'echo out; echo oops >&2; exit 4' });
    check('real stdout split', split.stdout === 'out\n', JSON.stringify(split));
    check('real stderr split', split.stderr === 'oops\n', JSON.stringify(split));
    check('real exit code 4', split.exitCode === 4);

    const env = await sandbox.run({ command: 'echo "$FOO"', env: { FOO: 'bar baz' } });
    check('native env', env.stdout === 'bar baz\n', JSON.stringify(env));

    const filePath = path.join(tmpDir, 'nested', 'note.txt');
    await sandbox.writeTextFile({ path: filePath, content: 'alpha\nbeta\n' });
    const text = await sandbox.readTextFile({ path: filePath });
    check('file round-trip', text === 'alpha\nbeta\n', JSON.stringify(text));

    if (sandbox.transport.capabilities.has('fork')) {
      try {
        fork = await sandbox.fork({ name: `${sandbox.id}-fork` });
        const forkRun = await fork.run({ command: 'echo fork-ok' });
        check('fork run', forkRun.stdout === 'fork-ok\n', JSON.stringify(forkRun));
      } catch (err) {
        // fork requires --project-snapshot (bubblewrap-only); skip elsewhere.
        if (/project-snapshot/.test(String(err?.message))) {
          console.log('  skip - fork (requires --project-snapshot / bubblewrap backend)');
        } else {
          throw err;
        }
      }
    }
    // Named volumes (account/host scoped) — locally safe, self-cleaning.
    const volName = `aisdk_test_vol_${Date.now()}`;
    try {
      const vol = await createHeyoVolume(volName, { mountPath: '/data' });
      check('volume create', vol.name === volName);
      const vols = await listHeyoVolumes();
      check('volume list parsed', vols.some((v) => v.name === volName), JSON.stringify(vols.slice(0, 3)));
      const vpath = await heyoVolumePath(volName);
      check('volume path resolves', vpath.length > 0 && vpath.includes(volName), vpath);
    } finally {
      await removeHeyoVolume(volName, { purge: true }).catch(() => {});
    }
  } finally {
    if (fork) await fork.delete().catch((e) => console.error('fork cleanup:', e.message));
    await sandbox.delete().catch((e) => console.error('cleanup:', e.message));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
