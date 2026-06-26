import type { ProxyEndpoint, SandboxInfo, SandboxMount } from './types.js';

/**
 * Capabilities a transport may support. The REST transport (local `heyvm --api`)
 * covers a subset; the CLI transport (the `heyvm` binary) covers everything and
 * is the only path to Heyo cloud sandboxes.
 */
export type HeyoCapability =
  | 'realStderr'
  | 'cloud'
  | 'fork'
  | 'archive'
  | 'resize'
  | 'bind'
  | 'mounts'
  | 'volumes'
  | 'session'
  | 'timeout'
  | 'expose'
  | 'runHost'
  | 'update'
  | 'webhook'
  | 'sync';

export type SizeClass = 'micro' | 'mini' | 'small' | 'medium' | 'large';

export interface ExecParams {
  id: string;
  /** Program to execute (e.g. `bash`). */
  command: string;
  /** Arguments to the program (e.g. `['-lc', 'echo hi']`). */
  args?: string[];
  env?: Record<string, string>;
  /** Persistent shell session name (CLI transport only). */
  session?: string;
  /** Command timeout in milliseconds (CLI transport only). */
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CreateSandboxParams {
  name: string;
  slug?: string;
  image?: string;
  type?: 'shell' | 'python' | 'node';
  backendType?: string;
  ttlSeconds?: number;
  noTtl?: boolean;
  startCommand?: string;
  workingDirectory?: string;
  openPorts?: number[];
  envVars?: Record<string, string>;
  setupHooks?: string[];
  mounts?: SandboxMount[];
  /** Named volumes to attach (CLI transport only). */
  volumes?: string[];
  /** Memory allocation, e.g. `2g` (CLI transport only). */
  memory?: string;
  /** Pre-install an agent CLI at creation time (CLI transport only). */
  agent?: 'claude' | 'codex';
  /** Require a networked backend (CLI transport only). */
  needsNetwork?: boolean;
  /**
   * Host directory mounted as an immutable overlay lower (project snapshot).
   * Required for {@link HeyoTransport.fork} (bubblewrap backend today).
   */
  projectSnapshot?: string;
  /** Create directly in the Heyo cloud (CLI transport only). */
  cloud?: boolean;
  region?: 'US' | 'EU';
  sizeClass?: SizeClass;
  /** Public cloud ports to expose (with `cloud: true`). */
  cloudPorts?: number[];
  healthPath?: string;
  /** Make cloud-bound ports private (account members only). */
  privatePorts?: boolean;
}

export interface ArchiveInfo {
  archiveId: string;
  name?: string;
  raw: string;
}

export interface VolumeInfo {
  name: string;
  mountPath?: string;
  hostPath?: string;
  raw?: unknown;
}

export interface WebhookInfo {
  id: string;
  command?: string;
  active?: boolean;
  raw?: unknown;
}

export interface RunHostOptions {
  /** Sandbox mount path to resolve to a host workspace (default `/workspace`). */
  mountPath?: string;
  abortSignal?: AbortSignal;
}

export interface UpdateOptions {
  /** Mount path to replace (default `/workspace`). */
  mountPath?: string;
}

export interface SyncPushOptions {
  /** Push directly to a receiver listening on this `heyo://` ticket. */
  to?: string;
  /** Upload to the cloud (S3) instead of serving over iroh. */
  cloud?: boolean;
  /** Include a memory snapshot (Firecracker only). */
  includeMemory?: boolean;
  /** Drop mount disk images from the bundle. */
  noMounts?: boolean;
  relay?: string;
}

export interface CreateVolumeOptions {
  /** Seed the volume by copying the contents of this host directory. */
  from?: string;
  /** Default mount path inside sandboxes (default `/<name>`). */
  mountPath?: string;
}

export type ProxyResult = ProxyEndpoint & { url?: string };

/**
 * Abstraction over the two ways to drive heyvm: the local HTTP API
 * (`RestTransport`) and the `heyvm` binary (`CliTransport`). `HeyoSandbox` is
 * built on top of this interface, so callers get the same API regardless of
 * which transport is active.
 */
export interface HeyoTransport {
  readonly kind: 'rest' | 'cli';
  readonly capabilities: ReadonlySet<HeyoCapability>;

  exec(params: ExecParams): Promise<ExecResult>;
  createSandbox(params: CreateSandboxParams): Promise<SandboxInfo>;
  getSandbox(idOrSlug: string): Promise<SandboxInfo>;
  listSandboxes(opts?: { all?: boolean; stopped?: boolean }): Promise<SandboxInfo[]>;
  deleteSandbox(idOrSlug: string): Promise<void>;
  stopSandbox(idOrSlug: string): Promise<void>;
  startSandbox(idOrSlug: string): Promise<void>;
  restartSandbox(idOrSlug: string): Promise<void>;

  // Capability-gated. Present only when `capabilities` includes the matching flag.
  bind?(idOrSlug: string, port: number, opts?: { private?: boolean }): Promise<ProxyResult>;
  addMount?(idOrSlug: string, mount: SandboxMount): Promise<void>;
  fork?(idOrSlug: string, opts?: { name?: string }): Promise<SandboxInfo>;
  archive?(idOrSlug: string, opts?: { name?: string; token?: string }): Promise<ArchiveInfo>;
  resize?(idOrSlug: string, sizeClass: SizeClass): Promise<void>;

  /** Opt a local sandbox in to remote P2P shell access via the Heyo cloud. */
  expose?(idOrSlug: string): Promise<void>;
  /** Disable remote P2P access previously enabled with {@link expose}. */
  unexpose?(idOrSlug: string): Promise<void>;
  /** Run a host CLI in the directory backing a sandbox mount. */
  runHost?(idOrSlug: string, args: string[], opts?: RunHostOptions): Promise<ExecResult>;
  /** Replace a deployed sandbox's mount contents from an archive. */
  update?(idOrSlug: string, archiveId: string, opts?: UpdateOptions): Promise<void>;
  /** Package a local sandbox and serve/upload it (returns the iroh ticket when serving). */
  syncPush?(idOrSlug: string, opts?: SyncPushOptions): Promise<string>;

  /** Configure an exec webhook on a P2P-exposed local sandbox. */
  createWebhook?(
    idOrSlug: string,
    command: string,
    opts?: { inactive?: boolean },
  ): Promise<WebhookInfo>;
  listWebhooks?(idOrSlug: string): Promise<WebhookInfo[]>;
  deleteWebhook?(idOrSlug: string, webhookId: string): Promise<void>;

  /** Create a named volume (account/host scoped, not sandbox scoped). */
  createVolume?(name: string, opts?: CreateVolumeOptions): Promise<VolumeInfo>;
  listVolumes?(): Promise<VolumeInfo[]>;
  volumePath?(name: string): Promise<string>;
  removeVolume?(name: string, opts?: { purge?: boolean }): Promise<void>;
}

/** Thrown when a feature is requested on a transport that does not support it. */
export class HeyoCapabilityError extends Error {
  readonly capability: HeyoCapability;
  readonly transportKind: string;

  constructor(capability: HeyoCapability, transportKind: string) {
    super(
      `Capability "${capability}" is not supported by the "${transportKind}" transport. ` +
        `Use the CLI transport (transport: "cli") — it is also the only path to Heyo cloud sandboxes.`,
    );
    this.name = 'HeyoCapabilityError';
    this.capability = capability;
    this.transportKind = transportKind;
  }
}

export function requireCapability(
  transport: HeyoTransport,
  capability: HeyoCapability,
): void {
  if (!transport.capabilities.has(capability)) {
    throw new HeyoCapabilityError(capability, transport.kind);
  }
}
