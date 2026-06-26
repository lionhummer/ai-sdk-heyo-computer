import { CliTransport, type WorktreeArgs } from './cli-transport.js';
import { HeyoSandbox } from './sandbox.js';
import type { HeyoConnectionOptions } from './types.js';

export interface CreateWorktreeSandboxOptions
  extends WorktreeArgs,
    Pick<HeyoConnectionOptions, 'bin' | 'cloudUrl' | 'dev' | 'cliToken' | 'dryRun' | 'shell'> {
  /** Branch name (e.g. `feat/cool-feature`). */
  branch: string;
}

/**
 * Create a git worktree sandbox from `heyvm wt` and return a {@link HeyoSandbox}.
 *
 * Experimental and CLI-only. Because `heyvm wt` attaches an interactive shell by
 * default, this helper runs it detached (or with `deploy: true` to spin up a
 * cloud sandbox). On `apple_virt` (macOS) detached mode is not yet supported by
 * heyvm, so prefer `deploy: true` there. The sandbox id is parsed from text
 * output, so treat failures as "couldn't determine the new sandbox id".
 */
export async function createHeyoWorktreeSandbox(
  options: CreateWorktreeSandboxOptions,
): Promise<HeyoSandbox> {
  const { branch, bin, cloudUrl, dev, cliToken, dryRun, shell, ...wt } = options;
  const transport = new CliTransport({ bin, cloudUrl, dev, token: cliToken, dryRun });
  const info = await transport.worktree(branch, wt);
  return new HeyoSandbox(transport, info, { shell });
}
