import { jsonSchema, tool, type ToolSet } from 'ai';

import type { HeyoSandbox } from './sandbox.js';

export interface CreateHeyoToolsOptions {
  /**
   * Prefix for tool names (e.g. `heyo` → `heyoRunCommand`). Defaults to no
   * prefix. Useful when wiring more than one sandbox into the same call.
   */
  prefix?: string;
  /**
   * Limit which tools are generated. Defaults to all available tools (the
   * `exposePort` tool is only included when the transport supports it).
   */
  include?: ReadonlyArray<HeyoToolName>;
  /** Default timeout (ms) applied to `runCommand`. */
  commandTimeoutMs?: number;
}

export type HeyoToolName =
  | 'runCommand'
  | 'readTextFile'
  | 'writeTextFile'
  | 'listFiles'
  | 'exposePort';

function clip(text: string, max = 60_000): string {
  return text.length > max ? `${text.slice(0, max)}\n…[truncated]` : text;
}

/**
 * Build a ready-to-use AI SDK {@link ToolSet} backed by a {@link HeyoSandbox}:
 * run shell commands, read/write text files, list a directory, and (when the
 * transport supports it) expose a port. Drop straight into `generateText`/
 * `streamText` via the `tools` option.
 */
export function createHeyoTools(
  sandbox: HeyoSandbox,
  options: CreateHeyoToolsOptions = {},
): ToolSet {
  const prefix = options.prefix ?? '';
  const name = (base: string) =>
    prefix ? `${prefix}${base[0]!.toUpperCase()}${base.slice(1)}` : base;

  const wants = (n: HeyoToolName) => !options.include || options.include.includes(n);
  const canExpose = sandbox.transport.capabilities.has('bind');

  const tools: ToolSet = {};

  if (wants('runCommand')) {
    tools[name('runCommand')] = tool({
      description:
        `Run a shell command inside the sandbox (${sandbox.description}). ` +
        `Returns exitCode, stdout and stderr.`,
      inputSchema: jsonSchema<{ command: string; workingDirectory?: string }>({
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute.' },
          workingDirectory: {
            type: 'string',
            description: 'Optional directory to run the command in.',
          },
        },
        required: ['command'],
        additionalProperties: false,
      }),
      execute: async ({ command, workingDirectory }) => {
        const res = await sandbox.exec({
          command,
          workingDirectory,
          timeoutMs: options.commandTimeoutMs,
        });
        return {
          exitCode: res.exitCode,
          stdout: clip(res.stdout),
          stderr: clip(res.stderr),
        };
      },
    });
  }

  if (wants('readTextFile')) {
    tools[name('readTextFile')] = tool({
      description: 'Read a UTF-8 text file from the sandbox. Returns null if missing.',
      inputSchema: jsonSchema<{ path: string }>({
        type: 'object',
        properties: { path: { type: 'string', description: 'Absolute or relative file path.' } },
        required: ['path'],
        additionalProperties: false,
      }),
      execute: async ({ path }) => {
        const content = await sandbox.readTextFile({ path });
        return { path, content: content === null ? null : clip(content) };
      },
    });
  }

  if (wants('writeTextFile')) {
    tools[name('writeTextFile')] = tool({
      description: 'Write a UTF-8 text file in the sandbox, creating parent directories.',
      inputSchema: jsonSchema<{ path: string; content: string }>({
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Destination file path.' },
          content: { type: 'string', description: 'File contents.' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      }),
      execute: async ({ path, content }) => {
        await sandbox.writeTextFile({ path, content });
        return { path, bytesWritten: content.length };
      },
    });
  }

  if (wants('listFiles')) {
    tools[name('listFiles')] = tool({
      description: 'List files in a sandbox directory (like `ls -la`).',
      inputSchema: jsonSchema<{ path?: string }>({
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory to list (default: current dir).' },
        },
        additionalProperties: false,
      }),
      execute: async ({ path }) => {
        const res = await sandbox.exec({ command: `ls -la ${path ? `'${path}'` : '.'}` });
        return { exitCode: res.exitCode, output: clip(res.stdout || res.stderr) };
      },
    });
  }

  if (canExpose && wants('exposePort')) {
    tools[name('exposePort')] = tool({
      description: 'Expose a port from the sandbox and return a public URL.',
      inputSchema: jsonSchema<{ port: number }>({
        type: 'object',
        properties: { port: { type: 'number', description: 'Port number to expose.' } },
        required: ['port'],
        additionalProperties: false,
      }),
      execute: async ({ port }) => {
        const endpoint = await sandbox.exposePort(port);
        return { port, url: endpoint.url ?? null, endpoint };
      },
    });
  }

  return tools;
}
