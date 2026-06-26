import { CliTransport } from './cli-transport.js';
import { RestTransport } from './rest-transport.js';
import type {
  ArchiveInfo,
  ExecResult,
  HeyoTransport,
  ProxyResult,
  RunHostOptions,
  SizeClass,
  SyncPushOptions,
  UpdateOptions,
  WebhookInfo,
} from './transport.js';
import { requireCapability } from './transport.js';
import type {
  CreateSandboxOptions,
  HeyoConnectionOptions,
  ReadFileOptions,
  RunResult,
  SandboxInfo,
  SandboxMount,
  SandboxProcess,
  SandboxProcessOptions,
  SandboxSession,
  WriteFileOptions,
} from './types.js';

function quoteForShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function dirnameOf(path: string): string {
  const idx = path.lastIndexOf('/');
  if (idx < 0) return '.';
  if (idx === 0) return '/';
  return path.slice(0, idx);
}

function base64Encode(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64Decode(b64: string): Uint8Array {
  const clean = b64.replace(/\s/g, '');
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(clean, 'base64'));
  const binary = atob(clean);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** Pull a likely list of exposed ports out of a raw SandboxInfo. */
function portsFromInfo(info: SandboxInfo): number[] {
  const candidate =
    (info.open_ports as unknown) ??
    (info.ports as unknown) ??
    (info.openPorts as unknown);
  if (Array.isArray(candidate)) {
    return candidate
      .map((p) => (typeof p === 'number' ? p : Number((p as { port?: unknown })?.port ?? p)))
      .filter((p) => Number.isFinite(p)) as number[];
  }
  return [];
}

/**
 * Build an environment-aware `description` so the model knows what it is working
 * with (image, working dir, exposed ports, public hostname, transport).
 */
function buildDescription(info: SandboxInfo, transport: HeyoTransport): string {
  const parts: string[] = [`Heyo (heyvm) microVM sandbox`];
  parts.push(`image: ${info.image ?? 'unknown'}`);
  parts.push(`transport: ${transport.kind}`);
  const wd = (info.working_directory ?? info.workingDirectory) as string | undefined;
  if (wd) parts.push(`workdir: ${wd}`);
  const ports = portsFromInfo(info);
  if (ports.length) parts.push(`exposed ports: ${ports.join(', ')}`);
  const hostname = (info.hostname ?? info.public_hostname) as string | undefined;
  if (hostname) parts.push(`hostname: ${hostname}`);
  if (info.status) parts.push(`status: ${info.status}`);
  return `${parts[0]} (${parts.slice(1).join(', ')}). ` +
    `Run shell commands and read/write files inside an isolated VM.`;
}

async function streamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
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

/** Build a {@link HeyoTransport} from connection options. */
export function createTransport(options: HeyoConnectionOptions = {}): HeyoTransport {
  if (options.transport === 'cli') {
    return new CliTransport({
      bin: options.bin,
      cloudUrl: options.cloudUrl,
      dev: options.dev,
      token: options.cliToken,
      dryRun: options.dryRun,
    });
  }
  return new RestTransport({
    apiUrl: options.apiUrl,
    token: options.token,
    headers: options.headers,
    fetch: options.fetch,
  });
}

/** Extended options for {@link HeyoSandbox.exec} (superset of the SDK's run). */
export interface HeyoExecOptions extends SandboxProcessOptions {
  /** Persistent shell session name (CLI transport only). */
  session?: string;
  /** Command timeout in milliseconds (CLI transport only). */
  timeoutMs?: number;
}

export type ConnectSandboxOptions = HeyoConnectionOptions;

/**
 * A handle to a single Heyo sandbox that implements the AI SDK's
 * {@link SandboxSession} contract (command execution + file I/O), plus the
 * richer heyvm features (fork/archive/resize/bind/mounts) where the active
 * transport supports them.
 *
 * File I/O is implemented with `base64` over the exec endpoint so that
 * arbitrary absolute paths work regardless of mounts. The sandbox image must
 * provide `base64` and the chosen shell (both present on typical Ubuntu/Debian
 * images).
 */
export class HeyoSandbox implements SandboxSession {
  readonly description: string;
  readonly id: string;
  readonly slug: string | undefined;
  readonly info: SandboxInfo;
  readonly transport: HeyoTransport;

  private readonly shell: string;

  constructor(
    transport: HeyoTransport,
    info: SandboxInfo,
    options: { shell?: string; description?: string } = {},
  ) {
    this.transport = transport;
    this.info = info;
    this.id = info.id;
    this.slug = info.slug;
    this.shell = options.shell ?? 'bash';
    this.description = options.description ?? buildDescription(info, transport);
  }

  /** Run a single shell command (AI SDK `SandboxSession.run`). */
  run(options: SandboxProcessOptions): Promise<RunResult> {
    return this.exec(options);
  }

  /**
   * Run a command with optional persistent `session` and `timeoutMs`
   * (both require the CLI transport).
   */
  async exec(options: HeyoExecOptions): Promise<RunResult> {
    const { command, workingDirectory, env, session, timeoutMs, abortSignal } =
      options;

    const script = workingDirectory
      ? `cd ${quoteForShell(workingDirectory)} && ${command}`
      : command;

    const result = await this.transport.exec({
      id: this.id,
      command: this.shell,
      args: ['-lc', script],
      env,
      session,
      timeoutMs,
      abortSignal,
    });

    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  /**
   * Spawn a process. heyvm exec is blocking, so the command has already
   * finished when the handle is returned: streams replay captured output,
   * `wait()` resolves immediately, and `kill()` is a no-op. Fine for finite
   * commands; not for long-running servers.
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
    const { path, abortSignal } = options;
    const result = await this.exec({
      command: `base64 < ${quoteForShell(path)} 2>/dev/null`,
      abortSignal,
    });
    if (result.exitCode !== 0) return null;
    return base64Decode(result.stdout);
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
    const bytes = await this.readBinaryFile(options);
    if (bytes === null) return null;
    const text = new TextDecoder(options.encoding ?? 'utf-8').decode(bytes);
    if (options.startLine === undefined && options.endLine === undefined) return text;
    const lines = text.split('\n');
    const start = (options.startLine ?? 1) - 1;
    const end = options.endLine ?? lines.length;
    return lines.slice(Math.max(0, start), end).join('\n');
  }

  async writeBinaryFile(options: WriteFileOptions<Uint8Array>): Promise<void> {
    const { path, content, abortSignal } = options;
    const b64 = base64Encode(content);
    const dir = quoteForShell(dirnameOf(path));
    const target = quoteForShell(path);
    const result = await this.exec({
      command: `mkdir -p ${dir} && printf %s '${b64}' | base64 -d > ${target}`,
      abortSignal,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `writeBinaryFile failed for ${path}: ${result.stderr || result.stdout}`,
      );
    }
  }

  async writeFile(
    options: WriteFileOptions<ReadableStream<Uint8Array>>,
  ): Promise<void> {
    const content = await streamToBytes(options.content);
    await this.writeBinaryFile({
      path: options.path,
      content,
      abortSignal: options.abortSignal,
    });
  }

  async writeTextFile(
    options: WriteFileOptions<string> & { encoding?: string },
  ): Promise<void> {
    await this.writeBinaryFile({
      path: options.path,
      content: new TextEncoder().encode(options.content),
      abortSignal: options.abortSignal,
    });
  }

  /** Expose a port and return the proxy endpoint plus a best-effort public URL. */
  exposePort(port: number, opts?: { private?: boolean }): Promise<ProxyResult> {
    requireCapability(this.transport, 'bind');
    return this.transport.bind!(this.id, port, opts);
  }

  /** Attach a host directory to the running sandbox. */
  addMount(mount: SandboxMount): Promise<void> {
    requireCapability(this.transport, 'mounts');
    return this.transport.addMount!(this.id, mount);
  }

  /**
   * Fork this sandbox (copy-on-write upper layer over a shared snapshot).
   * Great for reviewer agents and best-of-N. Requires the CLI transport.
   */
  async fork(opts?: { name?: string }): Promise<HeyoSandbox> {
    requireCapability(this.transport, 'fork');
    const info = await this.transport.fork!(this.id, opts);
    return new HeyoSandbox(this.transport, info, { shell: this.shell });
  }

  /** Snapshot the sandbox's mounts to an archive (S3). Requires the CLI transport. */
  archive(opts?: { name?: string; token?: string }): Promise<ArchiveInfo> {
    requireCapability(this.transport, 'archive');
    return this.transport.archive!(this.id, opts);
  }

  /** Resize the sandbox to a different size class. Requires the CLI transport. */
  resize(sizeClass: SizeClass): Promise<void> {
    requireCapability(this.transport, 'resize');
    return this.transport.resize!(this.id, sizeClass);
  }

  /**
   * Opt this local sandbox in to remote P2P shell access via the Heyo cloud.
   * Required before configuring webhooks. Requires the CLI transport.
   */
  expose(): Promise<void> {
    requireCapability(this.transport, 'expose');
    return this.transport.expose!(this.id);
  }

  /** Disable remote P2P access previously enabled with {@link expose}. */
  unexpose(): Promise<void> {
    requireCapability(this.transport, 'expose');
    return this.transport.unexpose!(this.id);
  }

  /**
   * Run a host CLI in the host directory backing one of this sandbox's mounts
   * (e.g. `git`, `npm` from the host). `command` is split into argv by the
   * caller. Requires the CLI transport.
   */
  runHost(args: string[], opts?: RunHostOptions): Promise<ExecResult> {
    requireCapability(this.transport, 'runHost');
    return this.transport.runHost!(this.id, args, opts);
  }

  /** Replace this (deployed) sandbox's mount contents from an archive. */
  update(archiveId: string, opts?: UpdateOptions): Promise<void> {
    requireCapability(this.transport, 'update');
    return this.transport.update!(this.id, archiveId, opts);
  }

  /**
   * Package this sandbox and serve it over iroh (returns the `heyo://` ticket)
   * or upload it with `cloud: true`. Requires `to` or `cloud` to avoid blocking.
   */
  syncPush(opts: SyncPushOptions): Promise<string> {
    requireCapability(this.transport, 'sync');
    return this.transport.syncPush!(this.id, opts);
  }

  /**
   * Configure an exec webhook on this sandbox (must be {@link expose}d first).
   * `command` runs inside the sandbox on each invocation; use `{{payload.data}}`
   * to interpolate the JSON body. Requires the CLI transport.
   */
  createWebhook(command: string, opts?: { inactive?: boolean }): Promise<WebhookInfo> {
    requireCapability(this.transport, 'webhook');
    return this.transport.createWebhook!(this.id, command, opts);
  }

  /** List webhooks configured on this sandbox. Requires the CLI transport. */
  listWebhooks(): Promise<WebhookInfo[]> {
    requireCapability(this.transport, 'webhook');
    return this.transport.listWebhooks!(this.id);
  }

  /** Delete a webhook by id. Requires the CLI transport. */
  deleteWebhook(webhookId: string): Promise<void> {
    requireCapability(this.transport, 'webhook');
    return this.transport.deleteWebhook!(this.id, webhookId);
  }

  stop(): Promise<void> {
    return this.transport.stopSandbox(this.id);
  }

  start(): Promise<void> {
    return this.transport.startSandbox(this.id);
  }

  restart(): Promise<void> {
    return this.transport.restartSandbox(this.id);
  }

  /** Permanently delete the sandbox. */
  delete(): Promise<void> {
    return this.transport.deleteSandbox(this.id);
  }

  /** Enables `await using sandbox = ...` to auto-delete the sandbox. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.delete();
  }
}

function createParamsFromOptions(options: CreateSandboxOptions): Parameters<
  HeyoTransport['createSandbox']
>[0] {
  return {
    name: options.name ?? `aisdk-${Math.random().toString(36).slice(2, 10)}`,
    slug: options.slug,
    image: options.image,
    type: options.sandboxType,
    backendType: options.backendType,
    ttlSeconds: options.ttlSeconds,
    noTtl: options.noTtl,
    startCommand: options.startCommand,
    workingDirectory: options.workingDirectory,
    openPorts: options.openPorts,
    envVars: options.envVars,
    setupHooks: options.setupHooks,
    mounts: options.mounts,
    volumes: options.volumes,
    memory: options.memory,
    agent: options.agent,
    needsNetwork: options.needsNetwork,
    projectSnapshot: options.projectSnapshot,
    cloud: options.cloud,
    region: options.region,
    sizeClass: options.sizeClass,
    cloudPorts: options.cloudPorts,
    healthPath: options.healthPath,
    privatePorts: options.privatePorts,
  };
}

/**
 * Create a fresh Heyo sandbox and return a session ready to pass to the AI SDK
 * via `experimental_sandbox`. Set `transport: 'cli'` for cloud and the full
 * feature set. Remember to `.delete()` (or set a TTL) to avoid leaks.
 */
export async function createHeyoSandbox(
  options: CreateSandboxOptions = {},
): Promise<HeyoSandbox> {
  const transport = createTransport(options);
  const info = await transport.createSandbox(createParamsFromOptions(options));
  return new HeyoSandbox(transport, info, { shell: options.shell });
}

/** Attach to an existing sandbox by id or slug without creating a new one. */
export async function connectHeyoSandbox(
  idOrSlug: string,
  options: ConnectSandboxOptions = {},
): Promise<HeyoSandbox> {
  const transport = createTransport(options);
  const info = await transport.getSandbox(idOrSlug);
  return new HeyoSandbox(transport, info, { shell: options.shell });
}

/**
 * Idempotent durable workspace: attach to the sandbox with the given slug if it
 * exists (auto-starting it if stopped), otherwise create it. Pass a
 * deterministic `slug` (e.g. per user/conversation/branch) so the same sandbox
 * is reused across processes and machines.
 */
export async function getOrCreateHeyoSandbox(
  options: CreateSandboxOptions & { slug: string },
): Promise<HeyoSandbox> {
  const transport = createTransport(options);
  let info: SandboxInfo | undefined;
  try {
    info = await transport.getSandbox(options.slug);
  } catch {
    info = undefined;
  }

  if (info) {
    const sandbox = new HeyoSandbox(transport, info, { shell: options.shell });
    if (typeof info.status === 'string' && info.status.toLowerCase() !== 'running') {
      await transport.startSandbox(info.id).catch(() => {});
    }
    return sandbox;
  }

  const created = await transport.createSandbox(createParamsFromOptions(options));
  return new HeyoSandbox(transport, created, { shell: options.shell });
}
