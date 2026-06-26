/**
 * The sandbox contract required by the Vercel AI SDK (`ai@7`). This mirrors
 * `Experimental_SandboxSession` from `@ai-sdk/provider-utils` structurally, so
 * a {@link HeyoSandbox} can be passed to the SDK's `experimental_sandbox`
 * option without a hard build-time dependency on `ai`.
 *
 * @see https://ai-sdk.dev/v7/docs/reference/ai-sdk-core/sandbox
 */
export interface SandboxSession {
  readonly description: string;
  readonly readFile: (
    options: ReadFileOptions,
  ) => PromiseLike<ReadableStream<Uint8Array> | null>;
  readonly readBinaryFile: (
    options: ReadFileOptions,
  ) => PromiseLike<Uint8Array | null>;
  readonly readTextFile: (
    options: ReadFileOptions & {
      encoding?: string;
      startLine?: number;
      endLine?: number;
    },
  ) => PromiseLike<string | null>;
  readonly writeFile: (
    options: WriteFileOptions<ReadableStream<Uint8Array>>,
  ) => PromiseLike<void>;
  readonly writeBinaryFile: (
    options: WriteFileOptions<Uint8Array>,
  ) => PromiseLike<void>;
  readonly writeTextFile: (
    options: WriteFileOptions<string> & { encoding?: string },
  ) => PromiseLike<void>;
  readonly spawn: (options: SandboxProcessOptions) => PromiseLike<SandboxProcess>;
  readonly run: (options: SandboxProcessOptions) => PromiseLike<RunResult>;
}

export interface SandboxProcessOptions {
  /** The command to execute, as a single shell string. */
  command: string;
  /** Optional working directory to execute the command in. */
  workingDirectory?: string;
  /**
   * Optional environment variables for this command. Merged with the
   * sandbox's default environment, with these values taking precedence.
   */
  env?: Record<string, string>;
  /** Optional abort signal used to cancel the in-flight request. */
  abortSignal?: AbortSignal;
}

export interface ReadFileOptions {
  path: string;
  abortSignal?: AbortSignal;
}

export interface WriteFileOptions<CONTENT> {
  path: string;
  content: CONTENT;
  abortSignal?: AbortSignal;
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  /**
   * Heyo's HTTP `execute` endpoint merges stderr into a single `output`
   * stream, so `stderr` is always an empty string for runs performed over the
   * REST API. The combined output is available on `stdout`.
   */
  stderr: string;
}

/**
 * Handle to a process started via {@link SandboxSession.spawn}. Because heyvm's
 * REST `execute` endpoint is blocking, the command has already run to
 * completion by the time this handle is returned (see {@link HeyoSandbox.spawn}).
 */
export interface SandboxProcess {
  readonly pid?: number;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  wait(): PromiseLike<{ exitCode: number }>;
  kill(): PromiseLike<void>;
}

export interface SandboxMount {
  host_path: string;
  sandbox_path: string;
  read_only?: boolean;
}

/**
 * Selects and configures the transport used to talk to heyvm.
 *
 * - `rest` (default): a local `heyvm --api` HTTP server. Remote-capable, but
 *   manages local sandboxes only and merges stderr into stdout.
 * - `cli`: shells out to the `heyvm` binary. Covers local AND cloud sandboxes
 *   plus the full subcommand surface, with true stdout/stderr separation.
 */
export interface HeyoConnectionOptions {
  /** Which transport to use. Defaults to `rest`. */
  transport?: 'rest' | 'cli';

  // --- REST transport options ---
  /** Base URL of the heyvm API server. Defaults to `http://localhost:3000`. */
  apiUrl?: string;
  /** Bearer token for the REST API (when the server has `JWT_SECRET` set). */
  token?: string;
  /** Extra headers for the REST API. */
  headers?: Record<string, string>;
  /** Custom fetch implementation for the REST API. Defaults to global `fetch`. */
  fetch?: typeof fetch;

  // --- CLI transport options ---
  /** Path or name of the heyvm binary. Defaults to `heyvm`. */
  bin?: string;
  /** Override the cloud server URL (`--cloud-url`). */
  cloudUrl?: string;
  /** Override the auth server URL (`--auth-url`, used by `login`). */
  authUrl?: string;
  /** Development mode (`--dev`). */
  dev?: boolean;
  /**
   * JWT token injected as `HEYO_ARCHIVE_TOKEN` for the deploy plane
   * (create/archive/update). Cloud exec/status need {@link apiKey} instead.
   */
  cliToken?: string;
  /**
   * Heyo dashboard API key. When set, the CLI transport establishes a cloud
   * **session** via `heyvm login --api-key` (automatically before the first
   * command, and again once on an auth failure). This authorizes the
   * exec/status plane for cloud sandboxes.
   */
  apiKey?: string;
  /** Disable the automatic `heyvm login` even when {@link apiKey} is set. */
  autoLogin?: boolean;
  /** Record argv and skip spawning (for tests). */
  dryRun?: boolean;

  /**
   * Shell used to interpret single-string commands. Defaults to `bash`. The
   * command is run as `<shell> -lc "<command>"`.
   */
  shell?: string;
}

/** Options for creating a new sandbox. */
export interface CreateSandboxOptions extends HeyoConnectionOptions {
  /** Human-readable name (also used to derive the slug). */
  name?: string;
  /** URL-safe slug (defaults to slugified name). */
  slug?: string;
  /** Base image, e.g. `ubuntu:24.04`. */
  image?: string;
  /** Sandbox flavor. Defaults to `shell`. */
  sandboxType?: 'shell' | 'python' | 'node';
  /** Backend to run on, e.g. `msb`, `apple_container`, `bubblewrap`. */
  backendType?: string;
  /** Auto-destroy the sandbox after this many seconds. */
  ttlSeconds?: number;
  /** Never expire (`--no-ttl`). */
  noTtl?: boolean;
  /** Long-running start command to keep the sandbox alive. */
  startCommand?: string;
  /** Default working directory for the sandbox. */
  workingDirectory?: string;
  /** Ports to expose locally. */
  openPorts?: number[];
  /** Default environment variables for the sandbox. */
  envVars?: Record<string, string>;
  /** Shell commands to run once after the filesystem is mounted. */
  setupHooks?: string[];
  /** Host directories to mount into the sandbox. */
  mounts?: SandboxMount[];

  // --- CLI / cloud only ---
  /** Named volumes to attach (CLI transport only). */
  volumes?: string[];
  /** Memory allocation, e.g. `2g` (CLI transport only). */
  memory?: string;
  /** Pre-install an agent CLI at creation time (CLI transport only). */
  agent?: 'claude' | 'codex';
  /** Require a networked backend (CLI transport only). */
  needsNetwork?: boolean;
  /** Host dir mounted as overlay lower; enables `fork` (CLI, bubblewrap). */
  projectSnapshot?: string;
  /** Create directly in the Heyo cloud (CLI transport only). */
  cloud?: boolean;
  /** Cloud region for `cloud: true`. */
  region?: 'US' | 'EU';
  /** Cloud size class for `cloud: true`. */
  sizeClass?: 'micro' | 'mini' | 'small' | 'medium' | 'large';
  /** Public cloud ports to expose (with `cloud: true`). */
  cloudPorts?: number[];
  /** Health check path the cloud-create waits for. */
  healthPath?: string;
  /** Make cloud-bound ports private. */
  privatePorts?: boolean;
}

/** Raw shape returned by `POST /sandboxes`. */
export interface SandboxInfo {
  id: string;
  name?: string;
  slug?: string;
  status?: string;
  image?: string;
  [key: string]: unknown;
}

/** Raw shape returned by `POST /sandboxes/:id/execute`. */
export interface ExecuteResponse {
  output?: string;
  exit_code?: number;
  [key: string]: unknown;
}

/** Raw shape returned by `POST /sandboxes/:id/proxy`. */
export interface ProxyEndpoint {
  subdomain: string;
  hostname: string;
  sandbox_id: string;
  port: number;
}
