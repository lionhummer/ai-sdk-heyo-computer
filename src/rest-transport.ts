import type {
  ExecParams,
  ExecResult,
  CreateSandboxParams,
  HeyoCapability,
  HeyoTransport,
  ProxyResult,
} from './transport.js';
import { HeyoCapabilityError } from './transport.js';
import type {
  ExecuteResponse,
  ProxyEndpoint,
  SandboxInfo,
  SandboxMount,
} from './types.js';

export const DEFAULT_API_URL = 'http://localhost:3000';

/** Error thrown when the heyvm HTTP API returns a non-2xx response. */
export class HeyoApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string, path: string) {
    super(`Heyo API request to ${path} failed with status ${status}: ${body}`);
    this.name = 'HeyoApiError';
    this.status = status;
    this.body = body;
  }
}

export interface RestTransportOptions {
  /** Base URL of the heyvm API server. Defaults to `http://localhost:3000`. */
  apiUrl?: string;
  /** Optional bearer token (required when the server has `JWT_SECRET` set). */
  token?: string;
  /** Extra headers to send on every request. */
  headers?: Record<string, string>;
  /** Custom fetch implementation. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

const REST_CAPABILITIES: ReadonlySet<HeyoCapability> = new Set<HeyoCapability>([
  'bind',
  'mounts',
]);

/**
 * Transport that talks to a local `heyvm --api` HTTP server. Manages local
 * sandboxes only — the Heyo cloud uses a different API, so cloud operations and
 * the richer subcommands (fork/archive/resize/…) require the CLI transport.
 */
export class RestTransport implements HeyoTransport {
  readonly kind = 'rest' as const;
  readonly capabilities = REST_CAPABILITIES;
  readonly apiUrl: string;

  private readonly token?: string;
  private readonly extraHeaders: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: RestTransportOptions = {}) {
    this.apiUrl = (options.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, '');
    this.token = options.token;
    this.extraHeaders = options.headers ?? {};
    const resolvedFetch = options.fetch ?? globalThis.fetch;
    if (typeof resolvedFetch !== 'function') {
      throw new Error(
        'No fetch implementation found. Provide `fetch` in options or run on Node 18+.',
      );
    }
    this.fetchImpl = resolvedFetch.bind(globalThis);
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.extraHeaders,
      ...extra,
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    return headers;
  }

  private async request<T>(
    path: string,
    init: RequestInit & { abortSignal?: AbortSignal } = {},
  ): Promise<T> {
    const { abortSignal, ...rest } = init;
    const res = await this.fetchImpl(`${this.apiUrl}${path}`, {
      ...rest,
      signal: abortSignal ?? rest.signal,
      headers: this.headers(rest.headers as Record<string, string> | undefined),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new HeyoApiError(res.status, body, path);
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  async exec(params: ExecParams): Promise<ExecResult> {
    if (params.session) throw new HeyoCapabilityError('session', this.kind);
    if (params.timeoutMs) throw new HeyoCapabilityError('timeout', this.kind);

    let command = params.command;
    let args = params.args ?? [];

    // The REST execute endpoint has no env field, so fold env into argv via
    // `env KEY=VALUE ... <command> <args...>` (values passed as argv, no quoting).
    if (params.env && Object.keys(params.env).length > 0) {
      const assignments = Object.entries(params.env).map(([k, v]) => `${k}=${v}`);
      command = 'env';
      args = [...assignments, params.command, ...args];
    }

    const res = await this.request<ExecuteResponse>(
      `/sandboxes/${encodeURIComponent(params.id)}/execute`,
      {
        method: 'POST',
        body: JSON.stringify({ command, args }),
        abortSignal: params.abortSignal,
      },
    );

    return { exitCode: res.exit_code ?? 0, stdout: res.output ?? '', stderr: '' };
  }

  createSandbox(params: CreateSandboxParams): Promise<SandboxInfo> {
    if (params.cloud) throw new HeyoCapabilityError('cloud', this.kind);
    return this.request('/sandboxes', {
      method: 'POST',
      body: JSON.stringify({
        name: params.name,
        slug: params.slug,
        sandbox_type: params.type,
        image: params.image,
        backend_type: params.backendType,
        ttl_seconds: params.noTtl ? undefined : params.ttlSeconds,
        start_command: params.startCommand,
        working_directory: params.workingDirectory,
        open_ports: params.openPorts,
        env_vars: params.envVars,
        setup_hooks: params.setupHooks,
        mounts: params.mounts,
      }),
    });
  }

  getSandbox(idOrSlug: string): Promise<SandboxInfo> {
    return this.request(`/sandboxes/${encodeURIComponent(idOrSlug)}`);
  }

  listSandboxes(): Promise<SandboxInfo[]> {
    return this.request('/sandboxes');
  }

  deleteSandbox(idOrSlug: string): Promise<void> {
    return this.request(`/sandboxes/${encodeURIComponent(idOrSlug)}`, {
      method: 'DELETE',
    });
  }

  async stopSandbox(idOrSlug: string): Promise<void> {
    await this.request(`/sandboxes/${encodeURIComponent(idOrSlug)}/stop`, {
      method: 'POST',
    });
  }

  async startSandbox(idOrSlug: string): Promise<void> {
    await this.request(`/sandboxes/${encodeURIComponent(idOrSlug)}/start`, {
      method: 'POST',
    });
  }

  async restartSandbox(idOrSlug: string): Promise<void> {
    await this.request(`/sandboxes/${encodeURIComponent(idOrSlug)}/restart`, {
      method: 'POST',
    });
  }

  async bind(idOrSlug: string, port: number): Promise<ProxyResult> {
    const endpoint = await this.request<ProxyEndpoint>(
      `/sandboxes/${encodeURIComponent(idOrSlug)}/proxy`,
      { method: 'POST', body: JSON.stringify({ port }) },
    );
    const url =
      endpoint.hostname && endpoint.hostname !== 'localhost'
        ? `https://${endpoint.subdomain}.${endpoint.hostname}`
        : undefined;
    return { ...endpoint, url };
  }

  async addMount(idOrSlug: string, mount: SandboxMount): Promise<void> {
    await this.request(`/sandboxes/${encodeURIComponent(idOrSlug)}/mounts`, {
      method: 'POST',
      body: JSON.stringify(mount),
    });
  }
}
