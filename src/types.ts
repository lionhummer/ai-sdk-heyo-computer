import type {
  SandboxDriver,
  SandboxRegion,
  SandboxSize,
} from '@heyocomputer/sdk';

/**
 * The sandbox contract consumed by the Vercel AI SDK (`ai@7`). Structurally
 * matches `Experimental_SandboxSession`, so a {@link HeyoSandbox} can be passed
 * to the SDK's `experimental_sandbox` option without a build-time dependency on
 * `ai`.
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
  /** The command to execute, as a single shell string (run via `sh -c`). */
  command: string;
  /** Working directory to run the command in. */
  workingDirectory?: string;
  /** Environment variables, merged on top of the sandbox's default env. */
  env?: Record<string, string>;
  /** Abort signal to cancel the in-flight request. */
  abortSignal?: AbortSignal;
}

export interface ReadFileOptions {
  path: string;
  /** Mount the path is rooted on. Defaults to the sandbox mount (`/workspace`). */
  mountPath?: string;
  abortSignal?: AbortSignal;
}

export interface WriteFileOptions<CONTENT> {
  path: string;
  content: CONTENT;
  /** Mount the path is rooted on. Defaults to the sandbox mount (`/workspace`). */
  mountPath?: string;
  abortSignal?: AbortSignal;
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Handle to a process started via {@link SandboxSession.spawn}. The exec
 * endpoint is blocking, so the command has already run to completion by the
 * time this handle is returned: the streams replay captured output, `wait()`
 * resolves immediately, and `kill()` is a no-op.
 */
export interface SandboxProcess {
  readonly pid?: number;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  wait(): PromiseLike<{ exitCode: number }>;
  kill(): PromiseLike<void>;
}

/** Connection settings shared by every factory. */
export interface HeyoConnectionOptions {
  /**
   * Heyo API key, sent as `Authorization: Bearer <key>`. Falls back to
   * `process.env.HEYO_API_KEY`. Omit it to talk to an unauthenticated local
   * `heyvm` daemon.
   */
  apiKey?: string;
  /**
   * API base URL. Defaults to the Heyo cloud (`https://server.heyo.computer`).
   * Point it at a self-hosted `heyvm --api` server to run anywhere.
   */
  baseUrl?: string;
  /** Per-request timeout in milliseconds. Default: 60000. */
  timeoutMs?: number;
  /** Custom `fetch` implementation. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Custom `WebSocket` constructor for {@link HeyoSandbox.shell} on Node < 22. */
  webSocket?: typeof WebSocket;
}

/** Options for creating a new sandbox. */
export interface CreateSandboxOptions extends HeyoConnectionOptions {
  /** Human-readable name. The server generates one when omitted. */
  name?: string;
  /** Base image, e.g. `ubuntu:24.04`, a public image name, or a `pi-…` id. */
  image?: string;
  /** Region. Default: `US`. */
  region?: SandboxRegion;
  /** VM driver. Inferred from the image when omitted. */
  driver?: SandboxDriver;
  /** Resource size class. Default: `small`. */
  sizeClass?: SandboxSize;
  /** Ports to expose publicly via the proxy. */
  openPorts?: number[];
  /** Command run on startup. */
  startCommand?: string;
  /** Time-to-live in seconds. `0` means unlimited (if the plan allows). */
  ttlSeconds?: number;
  /** Disk size in GB (capped server-side at 250). */
  diskSizeGb?: number;
  /** Working directory for `startCommand` and commands. */
  workingDirectory?: string;
  /** Default environment variables. */
  envVars?: Record<string, string>;
  /** Commands run once after the workspace is mounted. */
  setupHooks?: string[];
  /** Archive id (`ar-…`) to seed the workspace (libvirt deploys). */
  archiveId?: string;
  /** Pin the sandbox to a specific user-owned daemon (heyvmd) id. */
  daemonId?: string;
  /**
   * Max time to wait for the sandbox to leave `provisioning`. Default 5
   * minutes. Pass `0` to return immediately while it's still provisioning.
   */
  waitForReadyMs?: number;
  /** Mount that file operations are rooted on. Default: `/workspace`. */
  mountPath?: string;
}

export type {
  BoundUrl,
  PublicImage,
  SandboxDriver,
  SandboxInfo,
  SandboxLogEntry,
  SandboxLogs,
  SandboxLogsOptions,
  SandboxRegion,
  SandboxSize,
  SandboxStatus,
  ShellOptions,
  ShellSession,
  SnapshotImageInfo,
} from '@heyocomputer/sdk';
