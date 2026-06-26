import { createHeyoSandbox, HeyoSandbox } from './sandbox.js';
import type { CreateSandboxOptions } from './types.js';

export interface HeyoSandboxPoolOptions extends CreateSandboxOptions {
  /** Number of sandboxes to create. */
  size: number;
}

/**
 * A fixed-size set of sibling sandboxes for parallel work and best-of-N agent
 * runs. Each member is created from the same {@link CreateSandboxOptions} with a
 * distinct name/slug suffix. Use `await using pool = ...` (or call
 * {@link dispose}) to delete every member when done.
 */
export class HeyoSandboxPool {
  readonly sandboxes: HeyoSandbox[];

  private constructor(sandboxes: HeyoSandbox[]) {
    this.sandboxes = sandboxes;
  }

  get size(): number {
    return this.sandboxes.length;
  }

  /** Create `size` sandboxes in parallel. */
  static async create(options: HeyoSandboxPoolOptions): Promise<HeyoSandboxPool> {
    const { size, ...base } = options;
    if (size < 1) throw new Error('HeyoSandboxPool size must be >= 1');
    const baseName = base.name ?? `pool-${Math.random().toString(36).slice(2, 8)}`;
    const sandboxes = await Promise.all(
      Array.from({ length: size }, (_, i) =>
        createHeyoSandbox({
          ...base,
          name: `${baseName}-${i}`,
          slug: base.slug ? `${base.slug}-${i}` : undefined,
        }),
      ),
    );
    return new HeyoSandboxPool(sandboxes);
  }

  /** Run `fn` against every sandbox in parallel and collect the results. */
  map<T>(fn: (sandbox: HeyoSandbox, index: number) => Promise<T>): Promise<T[]> {
    return Promise.all(this.sandboxes.map((s, i) => fn(s, i)));
  }

  /**
   * Run `fn` against every sandbox and pick the best result with `score`
   * (highest wins). Returns the winning result, its sandbox, and all results.
   */
  async best<T>(
    fn: (sandbox: HeyoSandbox, index: number) => Promise<T>,
    score: (result: T, sandbox: HeyoSandbox, index: number) => number,
  ): Promise<{ result: T; sandbox: HeyoSandbox; index: number; all: T[] }> {
    const all = await this.map(fn);
    let bestIndex = 0;
    let bestScore = -Infinity;
    all.forEach((result, i) => {
      const s = score(result, this.sandboxes[i]!, i);
      if (s > bestScore) {
        bestScore = s;
        bestIndex = i;
      }
    });
    return {
      result: all[bestIndex]!,
      sandbox: this.sandboxes[bestIndex]!,
      index: bestIndex,
      all,
    };
  }

  /** Delete every sandbox in the pool (errors are swallowed per-member). */
  async dispose(): Promise<void> {
    await Promise.all(this.sandboxes.map((s) => s.delete().catch(() => {})));
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose();
  }
}

/** Convenience wrapper around {@link HeyoSandboxPool.create}. */
export function createHeyoSandboxPool(
  options: HeyoSandboxPoolOptions,
): Promise<HeyoSandboxPool> {
  return HeyoSandboxPool.create(options);
}
