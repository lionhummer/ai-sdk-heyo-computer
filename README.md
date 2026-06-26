# ai-sdk-heyo-computer

Run agent-generated commands and code in isolated [Heyo](https://heyo.computer) microVM sandboxes, straight from the [Vercel AI SDK](https://ai-sdk.dev) (`ai@7`).

`HeyoSandbox` implements the AI SDK's `Experimental_SandboxSession` contract, so you can pass it to `experimental_sandbox` — or use the batteries-included tool set with any agent loop. It's a thin wrapper over the official [`@heyocomputer/sdk`](https://www.npmjs.com/package/@heyocomputer/sdk): pure HTTP, no binary, runs anywhere (including serverless).

## Install

```bash
npm install ai-sdk-heyo-computer ai
```

ESM-only, Node ≥ 20. Set `HEYO_API_KEY` (from your Heyo dashboard); it's picked up automatically.

## Quick start

```ts
import { generateText } from 'ai';
import { createHeyoSandbox, createHeyoTools } from 'ai-sdk-heyo-computer';

await using sandbox = await createHeyoSandbox({ image: 'ubuntu:24.04', ttlSeconds: 3600 });

const result = await generateText({
  model: 'anthropic/claude-sonnet-4-6',
  tools: createHeyoTools(sandbox),
  prompt: 'Write /workspace/app.py that prints the 50th prime, run it, and tell me the output.',
});

console.log(result.text);
// `await using` deletes the sandbox on scope exit (or call sandbox.delete()).
```

## Tools

`createHeyoTools(sandbox)` returns an AI SDK `ToolSet` whose names mirror Anthropic's built-in tools, so models invoke them reliably:

| Tool | What it does |
|------|--------------|
| `bash` | Run a shell command; returns `exitCode`, `stdout`, `stderr`. |
| `str_replace_based_edit_tool` | View / create / `str_replace` / `insert` files. |
| `exposePort` | Bind a port and return a public URL. |

```ts
createHeyoTools(sandbox, {
  prefix: 'heyo',            // -> heyoBash, ... (leave unset to keep canonical names)
  include: ['bash'],         // only generate some tools
  commandTimeoutMs: 60_000,  // default timeout for bash
});
```

## Pass directly to the AI SDK

`HeyoSandbox` satisfies `Experimental_SandboxSession`, so the SDK can drive it via `experimental_sandbox`:

```ts
const result = await generateText({
  model: 'anthropic/claude-sonnet-4-6',
  experimental_sandbox: sandbox,
  tools: { /* your tools call experimental_sandbox.run(...) / readTextFile / writeTextFile */ },
  prompt: '…',
});
```

## Connecting

Every factory accepts the same connection options:

| Option | Default | Notes |
|--------|---------|-------|
| `apiKey` | `process.env.HEYO_API_KEY` | Sent as `Authorization: Bearer`. Omit for an unauthenticated local daemon. |
| `baseUrl` | `https://server.heyo.computer` | Point at a self-hosted `heyvm --api` server to run anywhere. |
| `timeoutMs` | `60000` | Per-request timeout. |
| `fetch` | global `fetch` | Custom fetch implementation. |
| `webSocket` | global `WebSocket` | For `sandbox.shell()` on Node < 22. |

The cloud and a local `heyvm --api` server speak the same HTTP API, so the entire surface works against either — just change `baseUrl`:

```ts
const sandbox = await createHeyoSandbox({
  baseUrl: 'http://localhost:3000', // self-hosted heyvm --api
  image: 'ubuntu:24.04',
});
```

## Factories

```ts
import {
  createHeyoSandbox,      // create a fresh sandbox
  connectHeyoSandbox,     // attach to an existing one by id (lazy)
  getOrCreateHeyoSandbox, // durable workspace: reuse by name, else create
  listHeyoSandboxes,      // list deployed sandboxes
  listHeyoImages,         // discover public images
} from 'ai-sdk-heyo-computer';

// Durable workspace reused across processes (same name ⇒ same sandbox):
const sandbox = await getOrCreateHeyoSandbox({ name: 'agent-workspace', image: 'ubuntu:24.04' });
```

## Sandbox API

`HeyoSandbox` covers the AI SDK contract plus the full sandbox lifecycle:

- **Commands:** `run(opts)`, `exec(opts)` (adds `timeoutMs`), `spawn(opts)`, `shell(opts)` (interactive PTY)
- **Files:** `readTextFile` / `readBinaryFile` / `readFile`, `writeTextFile` / `writeBinaryFile` / `writeFile`
- **Networking:** `exposePort(port, { private })`, `getHost(port)`
- **Lifecycle:** `stop`, `start`, `restart`, `delete`, `setTimeout(ttl)`, `resize(size)`, `checkpoint`, `restore`
- **Info:** `info`, `getInfo()` / `refresh()`, `waitForReady(ms)`
- **Images/mounts:** `snapshotToImage(name)`, `replaceMount(archiveId, path)`
- **Escape hatch:** `sandbox.raw` — the underlying `@heyocomputer/sdk` `Sandbox`

Files default to the `/workspace` mount; pass `mountPath` on a file call or `createHeyoSandbox({ mountPath })` to change it.

## Best-of-N

```ts
import { createHeyoSandboxPool, createHeyoTools } from 'ai-sdk-heyo-computer';
import { generateText, stepCountIs } from 'ai';

await using pool = await createHeyoSandboxPool({ size: 3, image: 'ubuntu:24.04' });

const { result, index } = await pool.best(
  (sandbox) =>
    generateText({ model: 'anthropic/claude-sonnet-4-6', tools: createHeyoTools(sandbox), stopWhen: stepCountIs(8), prompt: task }),
  (candidate) => score(candidate),
);
```

## Examples

See [`examples/`](./examples): `basic.ts`, `tools.ts`, `cloud.ts` (self-hosted), `pool.ts`, `harness-agent.ts`.

## License

MIT
