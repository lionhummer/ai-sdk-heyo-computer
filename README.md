# ai-sdk-heyo-computer

A [Heyo](https://heyo.computer) (`heyvm`) sandbox provider for the [Vercel AI SDK](https://ai-sdk.dev) v7.

It implements the AI SDK's `SandboxSession` contract on top of heyvm, so agents
can run shell commands and generated code inside isolated Heyo microVMs — **local
or in the Heyo cloud**. Drop-in alternative to `@ai-sdk/sandbox-vercel`.

## Install

```bash
npm install ai-sdk-heyo-computer ai
```

You also need the heyvm binary and/or a running API server. See the
[Heyo quickstart](https://docs.heyo.computer/docs/quickstart/):

```bash
curl -fsSL https://heyo.computer/heyvm/install.sh | sh
```

## Two transports (local + cloud)

There are two ways to drive heyvm, exposed as **transports**. Both implement the
same `HeyoSandbox` API, so your code doesn't change when you switch.

| | `rest` (default) | `cli` |
|---|---|---|
| How | HTTP to a `heyvm --api` server | shells out to the `heyvm` binary |
| Runs | any reachable host (incl. self-hosted) | same machine as your Node process |
| Targets | **local** sandboxes on that host | **local AND Heyo cloud** |
| `stdout`/`stderr` | merged into `stdout` | **true split** |
| Features | exec, files, proxy, mounts, lifecycle | **everything** (fork, archive, resize, sessions, …) |

There are **two different server surfaces**, and this is the thing to get right:

- **`heyvm --api`** is the *local sandbox manager* over HTTP. It manages the
  local micro-VMs on whatever host it runs on (msb / apple_virt / firecracker /
  …). You can **self-host** it and point `apiUrl` at it — including a remote box
  — to drive a fleet of local sandboxes over HTTP. It does **not** know about
  Heyo cloud (`dep-*`) sandboxes (`GET /sandboxes` won't list them).
- **The Heyo cloud server** (`server.heyo.computer` by default) is a *separate*
  control plane for deployed (`dep-*`) sandboxes. It is **also self-hostable** —
  it's the same stack `--dev` points at (`localhost:4445` for cloud,
  `localhost:3001` for auth). The CLI transport can target **any** cloud stack
  via `cloudUrl` / `authUrl` (or `dev: true`), so you are *not* limited to
  Heyo's hosted cloud. The `heyvm` **binary** unifies both planes:
  `heyvm exec/list/get/update/resize` resolve an id to whichever plane it lives
  on, using your login session.

So both surfaces are self-hostable: point the **REST** transport (`apiUrl`) at a
`heyvm --api` host for local sandboxes, and/or point the **CLI** transport
(`cloudUrl`/`authUrl`) at a self-hosted (or hosted) cloud stack for deployed
sandboxes + the full feature set.

```ts
// CLI transport against a self-hosted Heyo cloud stack
const sandbox = await createHeyoSandbox({
  transport: 'cli',
  cloudUrl: 'https://heyo.internal.example.com',
  authUrl: 'https://auth.internal.example.com',
  apiKey: process.env.HEYO_API_KEY,
  cloud: true,
});
```

### Cloud auth (sessions)

Cloud `exec`/`get`/`list`/`sh` need a **logged-in session** (stored at
`~/.heyo/token.json`), not just a token. Pass your Heyo dashboard **API key** and
the CLI transport bootstraps that session for you:

```ts
const sandbox = await createHeyoSandbox({
  transport: 'cli',
  cloud: true,
  apiKey: process.env.HEYO_API_KEY, // runs `heyvm login --api-key` for you
});
```

- On the first command the transport runs `heyvm login --api-key <key>` once to
  establish the session; every subsequent `heyvm` call **auto-refreshes** the
  token. If a call ever fails with an auth error, the transport re-logs-in once
  and retries (session refresh). Set `autoLogin: false` to opt out.
- `cliToken` (→ `HEYO_ARCHIVE_TOKEN`) is **only** for the deploy plane
  (`create`/`archive`/`update`). It does **not** authorize cloud
  `exec`/`get`/`list` — use `apiKey` for those.

### Capability matrix

| Capability | `rest` | `cli` |
|---|:---:|:---:|
| `run` / files / `spawn` | ✅ | ✅ |
| `bind` (expose port) | ✅ | ✅ |
| `addMount` | ✅ | ✅ |
| real `stderr` | ❌ | ✅ |
| `cloud` create | ❌ | ✅ |
| `exec` `session` / `timeout` | ❌ | ✅ |
| `fork` / `archive` / `resize` | ❌ | ✅ |
| `expose` / `unexpose` (P2P) | ❌ | ✅ |
| `runHost` / `update` / `syncPush` | ❌ | ✅ |
| webhooks / volumes / worktree | ❌ | ✅ |

Calling a CLI-only method on the REST transport throws `HeyoCapabilityError`.

## Usage

### Local (REST transport, default)

```ts
import { generateText, tool } from 'ai';
import * as z from 'zod';
import { createHeyoSandbox } from 'ai-sdk-heyo-computer';

// Requires: heyvm --api --port 3000
const sandbox = await createHeyoSandbox({
  apiUrl: 'http://localhost:3000',
  image: 'ubuntu:24.04',
  ttlSeconds: 3600,
});

try {
  const result = await generateText({
    model: 'openai/gpt-5.5',
    experimental_sandbox: sandbox,
    tools: {
      runCommand: tool({
        description: 'Run a shell command in the sandbox',
        inputSchema: z.object({ command: z.string() }),
        execute: ({ command }, { experimental_sandbox, abortSignal }) => {
          if (!experimental_sandbox) throw new Error('Sandbox unavailable');
          return experimental_sandbox.run({ command, abortSignal });
        },
      }),
    },
    prompt: 'Run the test suite and summarize the result.',
  });
  console.log(result.text);
} finally {
  await sandbox.delete();
}
```

### Cloud (CLI transport)

```ts
// Requires: heyvm installed + a Heyo cloud account (paid).
// Pass `apiKey` and the transport logs in for you (no manual `heyvm login`).
const sandbox = await createHeyoSandbox({
  transport: 'cli',
  apiKey: process.env.HEYO_API_KEY,
  cloud: true,
  region: 'US',
  sizeClass: 'small',
  image: 'ubuntu:24.04',
  cloudPorts: [8080],
  healthPath: '/health',
});

const out = await sandbox.run({ command: 'python3 --version' });
console.log(out.stdout, out.stderr); // real stderr on the CLI transport
```

### Durable workspace (reuse across runs/machines)

```ts
// Attaches if the slug exists (auto-starts if stopped), else creates.
const sandbox = await getOrCreateHeyoSandbox({
  transport: 'cli',
  slug: `user-${userId}`,
  image: 'ubuntu:24.04',
  noTtl: true,
});
```

### Auto-dispose

```ts
await using sandbox = await createHeyoSandbox({ ttlSeconds: 600 });
// sandbox.delete() runs automatically at end of scope
```

### Batteries-included tools

`createHeyoTools(sandbox)` returns a ready-to-use AI SDK `ToolSet`
(`runCommand`, `readTextFile`, `writeTextFile`, `listFiles`, and `exposePort`
when supported), so you don't have to hand-write tool wrappers:

```ts
import { generateText, stepCountIs } from 'ai';
import { createHeyoSandbox, createHeyoTools } from 'ai-sdk-heyo-computer';

await using sandbox = await createHeyoSandbox({ image: 'ubuntu:24.04' });

const result = await generateText({
  model: 'openai/gpt-5.5',
  tools: createHeyoTools(sandbox),
  stopWhen: stepCountIs(10),
  prompt: 'Write and run a script that prints the 50th prime.',
});
```

The sandbox's `description` is environment-aware (image, working dir, exposed
ports, public hostname, status), so the model gets useful context automatically.

### Best-of-N (pool)

```ts
import { createHeyoSandboxPool, createHeyoTools } from 'ai-sdk-heyo-computer';

await using pool = await createHeyoSandboxPool({ size: 3, image: 'ubuntu:24.04' });
const { result, index } = await pool.best(
  (sandbox) => generateText({ model: 'openai/gpt-5.5', tools: createHeyoTools(sandbox), prompt: task }),
  (candidate) => scoreOf(candidate),
);
```

### Coding-agent harness

Pass a `HeyoSandbox` to the AI SDK's `Experimental_Agent` (tool-loop agent) for a
full coding-agent harness in a durable VM — see [`examples/harness-agent.ts`](examples/harness-agent.ts).

## API

### Factories

- `createHeyoSandbox(options)` — create a sandbox; returns a `HeyoSandbox`.
- `connectHeyoSandbox(idOrSlug, options)` — attach to an existing sandbox.
- `getOrCreateHeyoSandbox({ slug, ... })` — idempotent durable workspace.
- `createTransport(options)` — build a transport directly.

Key options: `transport` (`'rest'`\|`'cli'`), `apiUrl`/`token` (REST),
`bin`/`cloudUrl`/`authUrl`/`dev`/`apiKey`/`autoLogin`/`cliToken`/`dryRun` (CLI),
plus `image`, `sandboxType`,
`backendType`, `ttlSeconds`/`noTtl`, `startCommand`, `workingDirectory`,
`openPorts`, `envVars`, `setupHooks`, `mounts`, and CLI/cloud-only `volumes`,
`memory`, `agent`, `needsNetwork`, `cloud`, `region`, `sizeClass`, `cloudPorts`,
`healthPath`, `privatePorts`.

### `HeyoSandbox`

Implements the AI SDK `SandboxSession` (`run`, `spawn`, `readFile`,
`readBinaryFile`, `readTextFile`, `writeFile`, `writeBinaryFile`,
`writeTextFile`) plus:

- `exec({ command, workingDirectory?, env?, session?, timeoutMs?, abortSignal? })` — like `run`, with CLI-only `session`/`timeoutMs`.
- `exposePort(port, { private? })` → proxy endpoint + best-effort public `url`.
- `addMount({ host_path, sandbox_path, read_only? })`.
- `fork({ name? })` → new `HeyoSandbox` (CLI; needs `--project-snapshot` source).
- `archive({ name?, token? })` → `{ archiveId }` (CLI).
- `resize(sizeClass)` (CLI).
- `expose()` / `unexpose()` — toggle remote P2P shell access (CLI).
- `runHost(args, { mountPath? })` — run a host CLI in the dir backing a mount (CLI).
- `update(archiveId, { mountPath? })` — replace a deployed sandbox's mount from an archive (CLI).
- `syncPush({ to? | cloud?, includeMemory?, noMounts? })` — package + send the sandbox; returns the `heyo://` ticket (CLI).
- `createWebhook(command, { inactive? })` / `listWebhooks()` / `deleteWebhook(id)` — exec webhooks on an exposed sandbox (CLI).
- `stop()` / `start()` / `restart()` / `delete()`.
- `[Symbol.asyncDispose]` for `await using`.

### Tools, pool & worktrees

- `createHeyoTools(sandbox, { prefix?, include?, commandTimeoutMs? })` → AI SDK `ToolSet`.
- `createHeyoSandboxPool({ size, ...createOptions })` / `HeyoSandboxPool` with `.map()`, `.best()`, `.dispose()`.
- `createHeyoWorktreeSandbox({ branch, createBranch?, deploy?, ... })` — git worktree sandbox via `heyvm wt` (experimental, CLI-only).

### Volumes (account/host scoped)

- `createHeyoVolume(name, { from?, mountPath? })`, `listHeyoVolumes()`,
  `heyoVolumePath(name)`, `removeHeyoVolume(name, { purge? })`. Attach to a
  sandbox at creation with the `volumes: ['name']` option.

### Transports & errors

`RestTransport`, `CliTransport`, `HeyoTransport`, `HeyoApiError`,
`HeyoCliError`, `HeyoCapabilityError`.

## How it maps to heyvm

| Need | REST | CLI |
|---|---|---|
| cloud login | — | `heyvm login --api-key <key>` (auto, on `apiKey`) |
| create | `POST /sandboxes` | `heyvm create … --format json` |
| `run` | `POST /sandboxes/:id/execute` | `heyvm exec <id> --format json -- …` |
| files | `base64` over exec | `base64` over exec |
| expose port | `POST /sandboxes/:id/proxy` | `heyvm bind <id> <port> --format json` |
| mounts | `POST /sandboxes/:id/mounts` | `heyvm mount-add …` |
| fork/archive/resize | — | `heyvm fork`/`archive`/`resize` |
| expose/webhook | — | `heyvm expose`/`webhook …` |
| host CLI / update / sync | — | `heyvm run-host`/`update`/`sync push` |
| volumes / worktree | — | `heyvm volume …`/`heyvm wt …` |

File I/O uses `base64` over exec (read side `base64 < path`, works on GNU & BSD)
so arbitrary absolute paths work regardless of mounts.

## Test

```bash
npm test            # builds, runs the REST mock integration + CLI dry-run argv tests
npm run test:cli-live  # drives the REAL heyvm binary (sandbox_exec backend); skips if not installed
```

The dry-run tests assert the exact `heyvm` argv generated by the CLI transport
without spawning anything; the live test verifies real stdout/stderr separation,
env, and file round-trips against the actual binary.

## Caveats

- **REST merges stderr.** On the REST transport `RunResult.stderr` is always
  `""` (heyvm's HTTP execute returns a single `output` field). The CLI transport
  returns real `stderr`.
- **`spawn` is blocking** (heyvm exec runs to completion): streams replay
  captured output, `wait()` resolves immediately, `kill()` is a no-op.
- **`fork`** requires the source sandbox to be created with `--project-snapshot`
  (bubblewrap backend today).
- **Cloud** requires the CLI transport, the `heyvm` binary, and (per Heyo) a paid
  account. Pass `apiKey` and the transport establishes the login session itself
  (the binary then auto-refreshes the token); otherwise run `heyvm login` once.
  `cliToken`/`HEYO_ARCHIVE_TOKEN` only covers the deploy plane, not cloud `exec`.
- **`syncPush`** without `to` (a `heyo://` ticket) or `cloud: true` would block
  waiting for a receiver, so this package requires one of them. Cloud upload may
  return "not yet implemented" on current heyvm.
- **Worktree (`createHeyoWorktreeSandbox`)** is experimental: `heyvm wt` has no
  JSON output (the id is parsed from text) and detached mode is unsupported on
  `apple_virt` (macOS) today — prefer `deploy: true` there.
- **Webhooks** require the sandbox to be `expose()`d (P2P) first.
- The experimental `experimental_sandbox` option in the AI SDK can change in
  patch releases.

## Examples

See [`examples/`](examples/): `basic.ts` (REST + manual tool), `tools.ts`
(`createHeyoTools`), `cloud.ts` (cloud sandbox + exposed port), `pool.ts`
(best-of-N), and `harness-agent.ts` (coding-agent harness on a durable sandbox).

## License

MIT
