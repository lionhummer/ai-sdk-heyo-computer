import { spawn } from 'node:child_process';

import type {
  ArchiveInfo,
  CreateSandboxParams,
  CreateVolumeOptions,
  ExecParams,
  ExecResult,
  HeyoCapability,
  HeyoTransport,
  ProxyResult,
  RunHostOptions,
  SizeClass,
  SyncPushOptions,
  UpdateOptions,
  VolumeInfo,
  WebhookInfo,
} from './transport.js';
import type { ProxyEndpoint, SandboxInfo, SandboxMount } from './types.js';

const CLI_CAPABILITIES: ReadonlySet<HeyoCapability> = new Set<HeyoCapability>([
  'realStderr',
  'cloud',
  'fork',
  'archive',
  'resize',
  'bind',
  'mounts',
  'volumes',
  'session',
  'timeout',
  'expose',
  'runHost',
  'update',
  'webhook',
  'sync',
]);

export interface CliTransportOptions {
  /** Path or name of the heyvm binary. Defaults to `heyvm`. */
  bin?: string;
  /** Override the cloud server URL (passed as `--cloud-url`). */
  cloudUrl?: string;
  /** Override the auth server URL (passed as `--auth-url`, used by `login`). */
  authUrl?: string;
  /** Development mode (`--dev`): use localhost auth/cloud URLs. */
  dev?: boolean;
  /**
   * JWT token injected as `HEYO_ARCHIVE_TOKEN` for the deploy plane
   * (`create`/`archive`/`update`). NOTE: cloud `exec`/`get`/`list` ignore this
   * and require a logged-in session — use {@link apiKey} for those.
   */
  token?: string;
  /**
   * API key (from the Heyo dashboard) used to establish a cloud **session** via
   * `heyvm login --api-key`. This is what authorizes the exec/status plane for
   * cloud sandboxes. When set, the transport logs in automatically before the
   * first command and re-logs-in once on an auth failure (session refresh).
   */
  apiKey?: string;
  /** Disable the automatic `heyvm login` even when {@link apiKey} is set. */
  autoLogin?: boolean;
  /**
   * When true, no process is spawned. Generated argv is recorded on `calls`
   * and canned responses are returned. Useful for tests.
   */
  dryRun?: boolean;
}

interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Error thrown when a heyvm CLI invocation fails (and produced no usable JSON). */
export class HeyoCliError extends Error {
  readonly argv: string[];
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;

  constructor(bin: string, argv: string[], result: SpawnResult) {
    super(
      `heyvm ${argv.join(' ')} exited with code ${result.code}: ${
        result.stderr || result.stdout
      }`,
    );
    this.name = 'HeyoCliError';
    this.argv = [bin, ...argv];
    this.code = result.code;
    this.stdout = result.stdout;
    this.stderr = result.stderr;
  }
}

function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    // heyvm sometimes prints a banner line before/after JSON; try the last line.
    const lines = trimmed.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]?.trim();
      if (line && (line.startsWith('{') || line.startsWith('['))) {
        try {
          return JSON.parse(line);
        } catch {
          /* keep scanning */
        }
      }
    }
    return undefined;
  }
}

/**
 * Transport that shells out to the `heyvm` binary. Covers local AND cloud
 * sandboxes and the full subcommand surface, and returns true stdout/stderr
 * separation. Requires the binary on the same machine as this process.
 */
export class CliTransport implements HeyoTransport {
  readonly kind = 'cli' as const;
  readonly capabilities = CLI_CAPABILITIES;

  /** Recorded argv per call when `dryRun` is set (for testing). */
  readonly calls: string[][] = [];

  private readonly bin: string;
  private readonly cloudUrl?: string;
  private readonly authUrl?: string;
  private readonly dev: boolean;
  private readonly token?: string;
  private readonly apiKey?: string;
  private readonly autoLogin: boolean;
  private readonly dryRun: boolean;

  private loginDone = false;
  private loginInFlight?: Promise<void>;

  constructor(options: CliTransportOptions = {}) {
    this.bin = options.bin ?? 'heyvm';
    this.cloudUrl = options.cloudUrl;
    this.authUrl = options.authUrl;
    this.dev = options.dev ?? false;
    this.token = options.token;
    this.apiKey = options.apiKey;
    this.autoLogin = options.autoLogin ?? true;
    this.dryRun = options.dryRun ?? false;
  }

  /**
   * Flags supported by (essentially) every subcommand. `--cloud-url`/`--auth-url`
   * let the CLI target a **self-hosted** Heyo cloud stack (the same stack
   * `--dev` points at `localhost:4445`/`:3001`), not just `heyo.computer`.
   */
  private globalFlags(): string[] {
    const flags: string[] = [];
    if (this.cloudUrl) flags.push('--cloud-url', this.cloudUrl);
    if (this.authUrl) flags.push('--auth-url', this.authUrl);
    if (this.dev) flags.push('--dev');
    return flags;
  }

  private spawn(argv: string[], abortSignal?: AbortSignal): Promise<SpawnResult> {
    // `token` authorizes the deploy plane only (create/archive/update) via the
    // HEYO_ARCHIVE_TOKEN env var. The exec/status plane (exec/get/list) needs a
    // logged-in session instead — see `apiKey`/`login()`.
    const env = this.token
      ? { ...process.env, HEYO_ARCHIVE_TOKEN: this.token }
      : process.env;
    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, argv, { signal: abortSignal, env });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
  }

  private static isAuthFailure(result: SpawnResult): boolean {
    const text = `${result.stderr}\n${result.stdout}`.toLowerCase();
    return (
      result.code !== 0 &&
      (text.includes('not authenticated') ||
        text.includes('log in') ||
        text.includes('unauthorized') ||
        text.includes('authentication required'))
    );
  }

  /**
   * Establish a cloud session with `heyvm login --api-key`. Deduplicated so
   * concurrent commands only trigger one login; pass `force` to refresh an
   * expired session.
   */
  async login(force = false): Promise<void> {
    if (!this.apiKey) {
      throw new Error('CliTransport.login requires an apiKey.');
    }
    if (this.loginDone && !force) return;
    if (force) {
      this.loginDone = false;
      this.loginInFlight = undefined;
    }
    if (!this.loginInFlight) {
      const argv = ['login', '--api-key', this.apiKey, ...this.globalFlags()];
      if (this.dryRun) {
        this.calls.push(argv);
        this.loginDone = true;
        return;
      }
      this.loginInFlight = this.spawn(argv)
        .then((result) => {
          if (result.code !== 0) throw new HeyoCliError(this.bin, argv, result);
          this.loginDone = true;
        })
        .finally(() => {
          this.loginInFlight = undefined;
        });
    }
    await this.loginInFlight;
  }

  /** Lazily ensure a session exists before commands when an apiKey is set. */
  private async ensureLogin(): Promise<void> {
    if (this.apiKey && this.autoLogin && !this.loginDone) {
      await this.login(false);
    }
  }

  /**
   * Spawn with session handling: log in first when an apiKey is configured, and
   * if a command fails with an auth error, refresh the session once and retry.
   */
  private async runRaw(
    argv: string[],
    abortSignal?: AbortSignal,
  ): Promise<SpawnResult> {
    await this.ensureLogin();
    let result = await this.spawn(argv, abortSignal);
    if (this.apiKey && CliTransport.isAuthFailure(result)) {
      await this.login(true);
      result = await this.spawn(argv, abortSignal);
    }
    return result;
  }

  /** Run a command expected to emit JSON on stdout; throws on failure. */
  private async runJson<T>(
    argv: string[],
    abortSignal?: AbortSignal,
  ): Promise<T> {
    if (this.dryRun) {
      this.calls.push(argv);
      return this.cannedResponse<T>(argv);
    }
    const result = await this.runRaw(argv, abortSignal);
    const parsed = tryParseJson(result.stdout);
    if (parsed === undefined || result.code !== 0) {
      throw new HeyoCliError(this.bin, argv, result);
    }
    return parsed as T;
  }

  /** Run a command where we only care about success (text output). */
  private async runOk(
    argv: string[],
    abortSignal?: AbortSignal,
  ): Promise<SpawnResult> {
    if (this.dryRun) {
      this.calls.push(argv);
      return { code: 0, stdout: '', stderr: '' };
    }
    const result = await this.runRaw(argv, abortSignal);
    if (result.code !== 0) throw new HeyoCliError(this.bin, argv, result);
    return result;
  }

  private cannedResponse<T>(argv: string[]): T {
    const sub = argv[0];
    if (sub === 'exec') {
      return { exit_code: 0, stdout: '', stderr: '' } as T;
    }
    if (sub === 'create' || sub === 'fork' || sub === 'get' || sub === 'wt') {
      return { id: 'sb-dryrun', name: 'dryrun', status: 'running' } as T;
    }
    if (sub === 'bind') {
      return {
        subdomain: 'dryrun',
        hostname: 'heyo.computer',
        sandbox_id: 'sb-dryrun',
        port: 0,
      } as T;
    }
    if (sub === 'list') return [] as T;
    if (sub === 'volume') {
      const action = argv[1];
      if (action === 'list') return [] as T;
      if (action === 'create') {
        return { name: argv[2] ?? 'dryrun', mountPath: `/${argv[2] ?? 'dryrun'}` } as T;
      }
    }
    if (sub === 'webhook') {
      const action = argv[1];
      if (action === 'list') return [] as T;
      if (action === 'create') return { id: 'wh-dryrun', active: true } as T;
    }
    return {} as T;
  }

  async exec(params: ExecParams): Promise<ExecResult> {
    const argv = ['exec', params.id, '--format', 'json', ...this.globalFlags()];
    if (params.env) {
      for (const [k, v] of Object.entries(params.env)) argv.push('--env', `${k}=${v}`);
    }
    if (params.session) argv.push('--session', params.session);
    if (params.timeoutMs) {
      argv.push('--timeout', `${Math.max(1, Math.ceil(params.timeoutMs / 1000))}s`);
    }
    argv.push('--', params.command, ...(params.args ?? []));

    if (this.dryRun) {
      this.calls.push(argv);
      return { exitCode: 0, stdout: '', stderr: '' };
    }

    // `heyvm exec` propagates the inner command's exit code as its own, so a
    // non-zero process exit is NOT a transport failure as long as we got JSON.
    const result = await this.runRaw(argv, params.abortSignal);
    const parsed = tryParseJson(result.stdout) as
      | { exit_code?: number; stdout?: string; stderr?: string }
      | undefined;
    if (parsed && typeof parsed.exit_code === 'number') {
      return {
        exitCode: parsed.exit_code,
        stdout: parsed.stdout ?? '',
        stderr: parsed.stderr ?? '',
      };
    }
    throw new HeyoCliError(this.bin, argv, result);
  }

  createSandbox(params: CreateSandboxParams): Promise<SandboxInfo> {
    const argv = ['create', '--name', params.name, '--format', 'json', ...this.globalFlags()];
    if (params.slug) argv.push('--slug', params.slug);
    if (params.image) argv.push('--image', params.image);
    if (params.type) argv.push('--type', params.type);
    if (params.backendType) argv.push('--backend', params.backendType);
    if (params.noTtl) argv.push('--no-ttl');
    else if (params.ttlSeconds != null) argv.push('--ttl-seconds', String(params.ttlSeconds));
    if (params.startCommand) argv.push('--start-command', params.startCommand);
    if (params.workingDirectory) argv.push('--working-directory', params.workingDirectory);
    for (const port of params.openPorts ?? []) argv.push('--open-port', String(port));
    if (params.envVars) {
      for (const [k, v] of Object.entries(params.envVars)) argv.push('--env', `${k}=${v}`);
    }
    for (const hook of params.setupHooks ?? []) argv.push('--setup-hook', hook);
    for (const mount of params.mounts ?? []) {
      argv.push('--mount', `${mount.host_path}:${mount.sandbox_path}`);
    }
    for (const volume of params.volumes ?? []) argv.push('--volume', volume);
    if (params.memory) argv.push('--memory', params.memory);
    if (params.agent) argv.push('--agent', params.agent);
    if (params.needsNetwork) argv.push('--needs-network');
    if (params.projectSnapshot) argv.push('--project-snapshot', params.projectSnapshot);
    if (params.cloud) {
      argv.push('--cloud');
      if (params.region) argv.push('--region', params.region);
      if (params.sizeClass) argv.push('--size-class', params.sizeClass);
      for (const port of params.cloudPorts ?? []) argv.push('--port', String(port));
      if (params.healthPath) argv.push('--health-path', params.healthPath);
      if (params.privatePorts) argv.push('--private');
    }
    if (this.token) argv.push('--token', this.token);
    return this.runJson<SandboxInfo>(argv);
  }

  getSandbox(idOrSlug: string): Promise<SandboxInfo> {
    return this.runJson(['get', idOrSlug, '--format', 'json', ...this.globalFlags()]);
  }

  listSandboxes(opts: { all?: boolean; stopped?: boolean } = {}): Promise<SandboxInfo[]> {
    const argv = ['list', '--format', 'json', ...this.globalFlags()];
    if (opts.all) argv.push('--all');
    else if (opts.stopped) argv.push('--stopped');
    return this.runJson<SandboxInfo[]>(argv);
  }

  async deleteSandbox(idOrSlug: string): Promise<void> {
    await this.runOk(['rm', idOrSlug, '-y', ...this.globalFlags()]);
  }

  async stopSandbox(idOrSlug: string): Promise<void> {
    await this.runOk(['stop', idOrSlug, ...this.globalFlags()]);
  }

  async startSandbox(idOrSlug: string): Promise<void> {
    await this.runOk(['start', idOrSlug, ...this.globalFlags()]);
  }

  async restartSandbox(idOrSlug: string): Promise<void> {
    await this.runOk(['restart', idOrSlug, ...this.globalFlags()]);
  }

  async bind(
    idOrSlug: string,
    port: number,
    opts: { private?: boolean } = {},
  ): Promise<ProxyResult> {
    const argv = ['bind', idOrSlug, String(port), '--format', 'json', ...this.globalFlags()];
    if (opts.private) argv.push('--private');
    const endpoint = await this.runJson<ProxyEndpoint & { url?: string }>(argv);
    const url =
      endpoint.url ??
      (endpoint.hostname && endpoint.hostname !== 'localhost'
        ? `https://${endpoint.subdomain}.${endpoint.hostname}`
        : undefined);
    return { ...endpoint, url };
  }

  async addMount(idOrSlug: string, mount: SandboxMount): Promise<void> {
    const argv = [
      'mount-add',
      '--id',
      idOrSlug,
      '--host-path',
      mount.host_path,
      '--sandbox-path',
      mount.sandbox_path,
      ...this.globalFlags(),
    ];
    if (mount.read_only) argv.push('--read-only');
    await this.runOk(argv);
  }

  fork(idOrSlug: string, opts: { name?: string } = {}): Promise<SandboxInfo> {
    const argv = ['fork', idOrSlug, '--format', 'json', ...this.globalFlags()];
    if (opts.name) argv.push('--name', opts.name);
    return this.runJson<SandboxInfo>(argv);
  }

  async archive(
    idOrSlug: string,
    opts: { name?: string; token?: string } = {},
  ): Promise<ArchiveInfo> {
    const argv = ['archive', idOrSlug, ...this.globalFlags()];
    if (opts.name) argv.push('--name', opts.name);
    const token = opts.token ?? this.token;
    if (token) argv.push('--token', token);
    const result = await this.runOk(argv);
    const match = /ID:\s*([A-Za-z0-9_-]+)/.exec(result.stdout);
    return {
      archiveId: match?.[1] ?? '',
      name: opts.name,
      raw: result.stdout,
    };
  }

  async resize(idOrSlug: string, sizeClass: SizeClass): Promise<void> {
    await this.runOk([
      'resize',
      idOrSlug,
      '--size-class',
      sizeClass,
      ...this.globalFlags(),
    ]);
  }

  async expose(idOrSlug: string): Promise<void> {
    await this.runOk(['expose', idOrSlug, ...this.globalFlags()]);
  }

  async unexpose(idOrSlug: string): Promise<void> {
    await this.runOk(['unexpose', idOrSlug, ...this.globalFlags()]);
  }

  async runHost(
    idOrSlug: string,
    args: string[],
    opts: RunHostOptions = {},
  ): Promise<ExecResult> {
    const argv = ['run-host', idOrSlug];
    if (opts.mountPath) argv.push('--mount-path', opts.mountPath);
    argv.push(...this.globalFlags(), '--', ...args);

    if (this.dryRun) {
      this.calls.push(argv);
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    // run-host propagates the inner command's exit code as its own.
    const result = await this.runRaw(argv, opts.abortSignal);
    return { exitCode: result.code ?? 0, stdout: result.stdout, stderr: result.stderr };
  }

  async update(
    idOrSlug: string,
    archiveId: string,
    opts: UpdateOptions = {},
  ): Promise<void> {
    const argv = ['update', idOrSlug, '--archive', archiveId];
    if (opts.mountPath) argv.push('--mount-path', opts.mountPath);
    await this.runOk([...argv, ...this.globalFlags()]);
  }

  async syncPush(idOrSlug: string, opts: SyncPushOptions = {}): Promise<string> {
    if (!opts.to && !opts.cloud) {
      throw new Error(
        'syncPush without `to` (a heyo:// ticket) or `cloud: true` blocks waiting ' +
          'for a receiver. Pass `to` to send to a `heyvm sync pull` listener, or ' +
          '`cloud: true` to upload (note: cloud upload may be "not yet implemented").',
      );
    }
    const argv = ['sync', 'push', idOrSlug];
    if (opts.cloud) argv.push('--cloud');
    if (opts.to) argv.push('--to', opts.to);
    if (opts.includeMemory) argv.push('--include-memory');
    if (opts.noMounts) argv.push('--no-mounts');
    if (opts.relay) argv.push('--relay', opts.relay);
    const result = await this.runOk([...argv, ...this.globalFlags()]);
    const match = /heyo:\/\/\S+/.exec(result.stdout);
    return match?.[0] ?? result.stdout.trim();
  }

  async createWebhook(
    idOrSlug: string,
    command: string,
    opts: { inactive?: boolean } = {},
  ): Promise<WebhookInfo> {
    const argv = ['webhook', 'create', idOrSlug, '--command', command];
    if (opts.inactive) argv.push('--inactive');
    const raw = await this.runJson<Record<string, unknown>>([
      ...argv,
      ...this.globalFlags(),
    ]).catch(async () => {
      // `webhook create` may emit text rather than JSON; fall back to runOk.
      const result = await this.runOk([...argv, ...this.globalFlags()]);
      const match = /([0-9a-fA-F-]{8,})/.exec(result.stdout);
      return { id: match?.[1] ?? '' } as Record<string, unknown>;
    });
    return {
      id: String(raw.id ?? ''),
      command,
      active: !opts.inactive,
      raw,
    };
  }

  async listWebhooks(idOrSlug: string): Promise<WebhookInfo[]> {
    const raw = await this.runJson<unknown>([
      'webhook',
      'list',
      idOrSlug,
      '--format',
      'json',
      ...this.globalFlags(),
    ]).catch(() => [] as unknown);
    const arr = Array.isArray(raw) ? raw : [];
    return arr.map((w) => {
      const obj = (w ?? {}) as Record<string, unknown>;
      return {
        id: String(obj.id ?? ''),
        command: obj.command as string | undefined,
        active: obj.active as boolean | undefined,
        raw: obj,
      };
    });
  }

  async deleteWebhook(idOrSlug: string, webhookId: string): Promise<void> {
    await this.runOk(['webhook', 'delete', idOrSlug, webhookId, ...this.globalFlags()]);
  }

  async createVolume(name: string, opts: CreateVolumeOptions = {}): Promise<VolumeInfo> {
    const argv = ['volume', 'create', name];
    if (opts.from) argv.push('--from', opts.from);
    if (opts.mountPath) argv.push('--mount-path', opts.mountPath);
    await this.runOk([...argv, ...this.globalFlags()]);
    return { name, mountPath: opts.mountPath ?? `/${name}` };
  }

  async listVolumes(): Promise<VolumeInfo[]> {
    const raw = await this.runJson<unknown>([
      'volume',
      'list',
      '--format',
      'json',
      ...this.globalFlags(),
    ]).catch(() => [] as unknown);
    const arr = Array.isArray(raw) ? raw : [];
    return arr.map((v) => {
      const obj = (v ?? {}) as Record<string, unknown>;
      return {
        name: String(obj.name ?? ''),
        mountPath: (obj.mount_path ?? obj.mountPath) as string | undefined,
        hostPath: (obj.host_path ?? obj.hostPath ?? obj.path) as string | undefined,
        raw: obj,
      };
    });
  }

  async volumePath(name: string): Promise<string> {
    const result = await this.runOk(['volume', 'path', name, ...this.globalFlags()]);
    return result.stdout.trim();
  }

  async removeVolume(name: string, opts: { purge?: boolean } = {}): Promise<void> {
    const argv = ['volume', 'rm', name, '-y'];
    if (opts.purge) argv.push('--purge');
    await this.runOk([...argv, ...this.globalFlags()]);
  }

  /**
   * Create a git worktree sandbox via `heyvm wt`. Must run in detached or deploy
   * mode (plain `wt` attaches an interactive shell and blocks). Output is text,
   * so the sandbox id is parsed best-effort.
   */
  async worktree(branch: string, opts: WorktreeArgs = {}): Promise<SandboxInfo> {
    const argv = ['wt', branch];
    if (opts.createBranch) argv.push('--create-branch');
    if (opts.image) argv.push('--image', opts.image);
    if (opts.backendType) argv.push('--backend', opts.backendType);
    if (opts.path) argv.push('--path', opts.path);
    if (opts.deploy) {
      argv.push('--deploy');
      if (opts.deployDriver) argv.push('--deploy-driver', opts.deployDriver);
      if (opts.deployImage) argv.push('--deploy-image', opts.deployImage);
      if (opts.deployRegion) argv.push('--deploy-region', opts.deployRegion);
      if (opts.deployTtlSeconds != null) {
        argv.push('--deploy-ttl-seconds', String(opts.deployTtlSeconds));
      }
      for (const port of opts.deployPorts ?? []) argv.push('--deploy-port', String(port));
    } else {
      argv.push('--detach');
    }

    if (this.dryRun) {
      this.calls.push([...argv, ...this.globalFlags()]);
      return { id: 'sb-dryrun', name: branch, status: 'running' };
    }
    const result = await this.runOk([...argv, ...this.globalFlags()]);
    const match =
      /\b(?:ID|id)[:=]?\s*([A-Za-z0-9][A-Za-z0-9_-]{5,})/.exec(result.stdout) ??
      /\b(sb_[A-Za-z0-9_-]+|[0-9a-f]{8}-[0-9a-f-]{27,})\b/.exec(result.stdout);
    const id = match?.[1];
    if (!id) throw new HeyoCliError(this.bin, argv, result);
    return { id, name: branch, status: 'running' };
  }
}

export interface WorktreeArgs {
  createBranch?: boolean;
  image?: string;
  backendType?: string;
  path?: string;
  /** Deploy the worktree to a cloud sandbox instead of detaching locally. */
  deploy?: boolean;
  deployDriver?: string;
  deployImage?: string;
  deployRegion?: 'US' | 'EU';
  deployTtlSeconds?: number;
  deployPorts?: number[];
}
