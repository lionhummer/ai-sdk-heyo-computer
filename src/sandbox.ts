import {
  NotFoundError,
  Sandbox as CloudSandbox,
  type HeyoClientOptions,
  type PublicImage,
  type SandboxCreateOptions,
  type SandboxDriver,
  type SandboxInfo,
  type SandboxSize,
  type ShellOptions,
  type ShellSession,
  type SnapshotImageInfo,
} from '@heyocomputer/sdk';

import type {
  CreateSandboxOptions,
  HeyoConnectionOptions,
  ReadFileOptions,
  RunResult,
  SandboxProcess,
  SandboxProcessOptions,
  SandboxSession,
  WriteFileOptions,
} from './types.js';

function clientOptions(options: HeyoConnectionOptions): HeyoClientOptions {
  return {
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetch,
    webSocketImpl: options.webSocket,
  };
}

function createOptions(options: CreateSandboxOptions): SandboxCreateOptions {
  return {
    name: options.name,
    image: options.image,
    region: options.region,
    driver: options.driver,
    sizeClass: options.sizeClass,
    openPorts: options.openPorts,
    startCommand: options.startCommand,
    ttlSeconds: options.ttlSeconds,
    diskSizeGb: options.diskSizeGb,
    workingDirectory: options.workingDirectory,
    envVars: options.envVars,
    setupHooks: options.setupHooks,
    archiveId: options.archiveId,
    daemonId: options.daemonId,
    waitForReadyMs: options.waitForReadyMs,
  };
}

function describe(info: SandboxInfo | null, fallbackId: string): string {
  if (!info) {
    return (
      `Heyo microVM sandbox (id: ${fallbackId}). ` +
      `Run shell commands and read/write files inside an isolated VM.`
    );
  }
  const parts = [`image: ${info.image}`, `status: ${info.status}`];
  if (info.region) parts.push(`region: ${info.region}`);
  if (info.workingDirectory) parts.push(`workdir: ${info.workingDirectory}`);
  if (info.urls.length) {
    parts.push(`ports: ${info.urls.map((u) => u.port).join(', ')}`);
  }
  return (
    `Heyo microVM sandbox (${parts.join(', ')}). ` +
    `Run shell commands and read/write files inside an isolated VM.`
  );
}

function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function streamToBytes(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.length;
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Extended options for {@link HeyoSandbox.exec}. */
export interface HeyoExecOptions extends SandboxProcessOptions {
  /** Per-command timeout in milliseconds. */
  timeoutMs?: number;
}

/**
 * A handle to a single Heyo sandbox that implements the AI SDK's
 * {@link SandboxSession} contract (command execution + file I/O) and exposes
 * the rest of the sandbox lifecycle (ports, TTL, resize, checkpoint, …).
 */
export class HeyoSandbox implements SandboxSession {
  readonly id: string;
  readonly description: string;

  private readonly sandbox: CloudSandbox;
  private readonly mountPath: string;

  constructor(
    sandbox: CloudSandbox,
    options: { description?: string; mountPath?: string } = {},
  ) {
    this.sandbox = sandbox;
    this.id = sandbox.sandboxId;
    this.mountPath = options.mountPath ?? '/workspace';
    this.description =
      options.description ?? describe(sandbox.info, sandbox.sandboxId);
  }

  /** The latest cached sandbox info, or `null` until {@link refresh} runs. */
  get info(): SandboxInfo | null {
    return this.sandbox.info;
  }

  /**
   * The underlying `@heyocomputer/sdk` `Sandbox`. Escape hatch for SDK features
   * not surfaced here (e.g. raw `commands`/`files` access).
   */
  get raw(): CloudSandbox {
    return this.sandbox;
  }

  /** Run a single shell command (AI SDK `SandboxSession.run`). */
  run(options: SandboxProcessOptions): Promise<RunResult> {
    return this.exec(options);
  }

  /** Run a command, optionally with a per-command timeout. */
  async exec(options: HeyoExecOptions): Promise<RunResult> {
    const result = await this.sandbox.commands.run(options.command, {
      cwd: options.workingDirectory,
      env: options.env,
      timeoutMs: options.timeoutMs,
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  /**
   * Run a command and return a process handle. The exec endpoint is blocking,
   * so the command has already finished: the streams replay its output and
   * `wait()` resolves immediately.
   */
  async spawn(options: SandboxProcessOptions): Promise<SandboxProcess> {
    const result = await this.exec(options);
    const enc = new TextEncoder();
    return {
      stdout: bytesToStream(enc.encode(result.stdout)),
      stderr: bytesToStream(enc.encode(result.stderr)),
      wait: () => Promise.resolve({ exitCode: result.exitCode }),
      kill: () => Promise.resolve(),
    };
  }

  async readBinaryFile(options: ReadFileOptions): Promise<Uint8Array | null> {
    try {
      return await this.sandbox.files.read(options.path, {
        format: 'bytes',
        mountPath: options.mountPath ?? this.mountPath,
      });
    } catch (err) {
      if (err instanceof NotFoundError) return null;
      throw err;
    }
  }

  async readFile(
    options: ReadFileOptions,
  ): Promise<ReadableStream<Uint8Array> | null> {
    const bytes = await this.readBinaryFile(options);
    return bytes === null ? null : bytesToStream(bytes);
  }

  async readTextFile(
    options: ReadFileOptions & {
      encoding?: string;
      startLine?: number;
      endLine?: number;
    },
  ): Promise<string | null> {
    let text: string;
    try {
      text = await this.sandbox.files.read(options.path, {
        mountPath: options.mountPath ?? this.mountPath,
      });
    } catch (err) {
      if (err instanceof NotFoundError) return null;
      throw err;
    }
    if (options.startLine === undefined && options.endLine === undefined) {
      return text;
    }
    const lines = text.split('\n');
    const start = (options.startLine ?? 1) - 1;
    const end = options.endLine ?? lines.length;
    return lines.slice(Math.max(0, start), end).join('\n');
  }

  async writeBinaryFile(options: WriteFileOptions<Uint8Array>): Promise<void> {
    await this.sandbox.files.write(options.path, options.content, {
      mountPath: options.mountPath ?? this.mountPath,
    });
  }

  async writeFile(
    options: WriteFileOptions<ReadableStream<Uint8Array>>,
  ): Promise<void> {
    const content = await streamToBytes(options.content);
    await this.writeBinaryFile({ ...options, content });
  }

  async writeTextFile(
    options: WriteFileOptions<string> & { encoding?: string },
  ): Promise<void> {
    await this.sandbox.files.write(options.path, options.content, {
      mountPath: options.mountPath ?? this.mountPath,
    });
  }

  /** Open a persistent interactive PTY shell over a WebSocket. */
  shell(options?: ShellOptions): Promise<ShellSession> {
    return this.sandbox.shell(options);
  }

  /** Bind a port and return its public URL. */
  exposePort(port: number, options: { private?: boolean } = {}) {
    return this.sandbox.bindPort(port, { isPublic: !options.private });
  }

  /** Public URL for a bound port, or `null` if it isn't exposed. */
  getHost(port: number): Promise<string | null> {
    return this.sandbox.getHost(port);
  }

  /** Fetch and cache the latest server-side info. */
  getInfo(): Promise<SandboxInfo> {
    return this.sandbox.getInfo();
  }

  /** Alias for {@link getInfo}. */
  refresh(): Promise<SandboxInfo> {
    return this.sandbox.getInfo();
  }

  /** Block until the sandbox leaves the `provisioning` state. */
  waitForReady(timeoutMs?: number): Promise<SandboxInfo> {
    return this.sandbox.waitForReady(timeoutMs);
  }

  /** Update the TTL in seconds (`0` for unlimited, if the plan allows). */
  setTimeout(ttlSeconds: number): Promise<void> {
    return this.sandbox.setTimeout(ttlSeconds);
  }

  /** Resize to a different size class (restarted server-side). */
  resize(sizeClass: SandboxSize): Promise<void> {
    return this.sandbox.resize(sizeClass);
  }

  /** Cold-store the sandbox (frees compute, keeps state). */
  checkpoint(): Promise<void> {
    return this.sandbox.checkpoint();
  }

  /** Restore a cold-stored sandbox. */
  restore(): Promise<void> {
    return this.sandbox.restore();
  }

  /** Snapshot the disk into a reusable image. */
  snapshotToImage(name: string): Promise<SnapshotImageInfo> {
    return this.sandbox.snapshotToImage(name);
  }

  /** Replace a mount's contents from an archive. */
  replaceMount(archiveId: string, sandboxPath?: string): Promise<void> {
    return this.sandbox.replaceMount(archiveId, sandboxPath);
  }

  stop(): Promise<void> {
    return this.sandbox.stop();
  }

  start(): Promise<void> {
    return this.sandbox.start();
  }

  restart(): Promise<void> {
    return this.sandbox.restart();
  }

  /** Permanently delete the sandbox. */
  delete(): Promise<void> {
    return this.sandbox.kill();
  }

  /** Enables `await using sandbox = ...` to auto-delete the sandbox. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.delete();
  }
}

/**
 * Create a fresh Heyo sandbox and return a session ready to pass to the AI SDK
 * via `experimental_sandbox`. Remember to `.delete()` (or set a TTL) to avoid
 * leaks.
 */
export async function createHeyoSandbox(
  options: CreateSandboxOptions = {},
): Promise<HeyoSandbox> {
  const sandbox = await CloudSandbox.create(
    createOptions(options),
    clientOptions(options),
  );
  return new HeyoSandbox(sandbox, { mountPath: options.mountPath });
}

export type ConnectSandboxOptions = HeyoConnectionOptions & {
  mountPath?: string;
};

/**
 * Attach to an existing sandbox by id. Lazy — issues no network call until a
 * method needs server data. Call {@link HeyoSandbox.refresh} for fresh info.
 */
export function connectHeyoSandbox(
  sandboxId: string,
  options: ConnectSandboxOptions = {},
): HeyoSandbox {
  const sandbox = CloudSandbox.connect(sandboxId, clientOptions(options));
  return new HeyoSandbox(sandbox, { mountPath: options.mountPath });
}

/** List every deployed sandbox the API key can see. */
export function listHeyoSandboxes(
  options: HeyoConnectionOptions = {},
): Promise<SandboxInfo[]> {
  return CloudSandbox.list(clientOptions(options));
}

/** List public images available to deploy. Pass `id` or `name` as `image`. */
export function listHeyoImages(
  options: HeyoConnectionOptions & { backend?: SandboxDriver } = {},
): Promise<PublicImage[]> {
  return CloudSandbox.listPublicImages(
    options.backend ? { backend: options.backend } : {},
    clientOptions(options),
  );
}

/**
 * Idempotent durable workspace: reattach to the running sandbox with the given
 * `name` if one exists (starting/restoring it when inactive), otherwise create
 * it. Pass a deterministic `name` (e.g. per user/conversation/branch) to reuse
 * the same sandbox across processes.
 */
export async function getOrCreateHeyoSandbox(
  options: CreateSandboxOptions & { name: string },
): Promise<HeyoSandbox> {
  const existing = (await CloudSandbox.list(clientOptions(options))).find(
    (s) => s.name === options.name && s.status !== 'failed',
  );

  if (existing) {
    const sandbox = CloudSandbox.connect(existing.id, clientOptions(options));
    if (existing.status === 'cold-stored') {
      await sandbox.restore().catch(() => undefined);
    } else if (existing.status === 'stopped' || existing.status === 'paused') {
      await sandbox.start().catch(() => undefined);
    }
    return new HeyoSandbox(sandbox, {
      description: describe(existing, existing.id),
      mountPath: options.mountPath,
    });
  }

  return createHeyoSandbox(options);
}
