import { jsonSchema, tool, type ToolSet } from 'ai';

import type { HeyoSandbox } from './sandbox.js';

export interface CreateHeyoToolsOptions {
  /**
   * Prefix for tool names (e.g. `heyo` → `heyoBash`). Useful when wiring more
   * than one sandbox into the same call. Note: prefixing changes the canonical
   * Anthropic tool names, so leave it unset to benefit from model training.
   */
  prefix?: string;
  /** Limit which tools are generated. Defaults to all of them. */
  include?: ReadonlyArray<HeyoToolName>;
  /** Default timeout (ms) applied to the `bash` tool. */
  commandTimeoutMs?: number;
}

/**
 * Tool names mirror Anthropic's built-in tools so models invoke them reliably:
 * - `bash` — run a shell command.
 * - `str_replace_based_edit_tool` — view / create / edit files.
 * - `exposePort` — Heyo extension: bind a port to a public URL.
 */
export type HeyoToolName = 'bash' | 'str_replace_based_edit_tool' | 'exposePort';

function clip(text: string, max = 60_000): string {
  return text.length > max ? `${text.slice(0, max)}\n…[truncated]` : text;
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Number lines `cat -n`-style, starting at `from`, matching the editor tool. */
function withLineNumbers(text: string, from = 1): string {
  return text
    .split('\n')
    .map((line, i) => `${String(from + i).padStart(6)}\t${line}`)
    .join('\n');
}

/**
 * Build a ready-to-use AI SDK {@link ToolSet} backed by a {@link HeyoSandbox}.
 * Tool names follow Anthropic's defaults (`bash`, `str_replace_based_edit_tool`)
 * plus a Heyo `exposePort` extension. Drop straight into `generateText` /
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

  const tools: ToolSet = {};

  if (wants('bash')) {
    tools[name('bash')] = tool({
      description:
        `Run a bash command inside the sandbox (${sandbox.description}). ` +
        `Returns exitCode, stdout and stderr.`,
      inputSchema: jsonSchema<{ command?: string; restart?: boolean }>({
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The bash command to run.' },
          restart: {
            type: 'boolean',
            description: 'Ignored — each command runs in a fresh shell.',
          },
        },
        additionalProperties: false,
      }),
      execute: async ({ command, restart }) => {
        if (restart || !command) {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        const res = await sandbox.exec({
          command,
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

  if (wants('str_replace_based_edit_tool')) {
    tools[name('str_replace_based_edit_tool')] = tool({
      description:
        'View, create, and edit files inside the sandbox. ' +
        'Commands: `view` (file contents or directory listing), `create` ' +
        '(write a new file), `str_replace` (replace a unique snippet), ' +
        '`insert` (insert text after a line).',
      inputSchema: jsonSchema<{
        command: 'view' | 'create' | 'str_replace' | 'insert';
        path: string;
        file_text?: string;
        old_str?: string;
        new_str?: string;
        insert_line?: number;
        view_range?: [number, number];
      }>({
        type: 'object',
        properties: {
          command: {
            type: 'string',
            enum: ['view', 'create', 'str_replace', 'insert'],
            description: 'The edit operation to perform.',
          },
          path: { type: 'string', description: 'Absolute path to the file or directory.' },
          file_text: { type: 'string', description: 'Contents for `create`.' },
          old_str: { type: 'string', description: 'Exact text to replace for `str_replace`.' },
          new_str: {
            type: 'string',
            description: 'Replacement text for `str_replace`, or text to add for `insert`.',
          },
          insert_line: {
            type: 'number',
            description: 'Line number to insert after (0 = start of file) for `insert`.',
          },
          view_range: {
            type: 'array',
            items: { type: 'number' },
            description: 'Optional [start, end] 1-indexed line range for `view`.',
          },
        },
        required: ['command', 'path'],
        additionalProperties: false,
      }),
      execute: async (input) => {
        const { command, path } = input;

        if (command === 'view') {
          const content = await sandbox.readTextFile({ path });
          if (content !== null) {
            const [start, end] = input.view_range ?? [];
            if (start !== undefined) {
              const lines = content.split('\n');
              const slice = lines.slice(start - 1, end ?? lines.length);
              return { output: clip(withLineNumbers(slice.join('\n'), start)) };
            }
            return { output: clip(withLineNumbers(content)) };
          }
          const listing = await sandbox.exec({
            command: `find ${quote(path)} -maxdepth 2 -not -path '*/.*' 2>/dev/null | sort`,
          });
          if (listing.exitCode !== 0 || !listing.stdout.trim()) {
            return { error: `No such file or directory: ${path}` };
          }
          return { output: clip(listing.stdout) };
        }

        if (command === 'create') {
          await sandbox.writeTextFile({ path, content: input.file_text ?? '' });
          return { output: `File created: ${path}` };
        }

        if (command === 'str_replace') {
          const current = await sandbox.readTextFile({ path });
          if (current === null) return { error: `No such file: ${path}` };
          const old = input.old_str ?? '';
          const occurrences = old ? current.split(old).length - 1 : 0;
          if (occurrences === 0) return { error: 'old_str not found in file.' };
          if (occurrences > 1) {
            return { error: `old_str is not unique (${occurrences} matches).` };
          }
          const next = current.replace(old, input.new_str ?? '');
          await sandbox.writeTextFile({ path, content: next });
          return { output: `Replaced 1 occurrence in ${path}` };
        }

        // insert
        const current = await sandbox.readTextFile({ path });
        if (current === null) return { error: `No such file: ${path}` };
        const lines = current.split('\n');
        const at = Math.max(0, Math.min(input.insert_line ?? lines.length, lines.length));
        lines.splice(at, 0, input.new_str ?? '');
        await sandbox.writeTextFile({ path, content: lines.join('\n') });
        return { output: `Inserted text after line ${at} in ${path}` };
      },
    });
  }

  if (wants('exposePort')) {
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
        return { port, url: endpoint.url, endpoint };
      },
    });
  }

  return tools;
}
