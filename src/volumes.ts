import { CliTransport } from './cli-transport.js';
import type { CreateVolumeOptions, VolumeInfo } from './transport.js';
import type { HeyoConnectionOptions } from './types.js';

/**
 * Named volumes are account/host scoped (not tied to a single sandbox) and are
 * only available through the `heyvm` binary. Attach them at creation time with
 * the `volumes` option on {@link createHeyoSandbox}.
 */
export interface HeyoVolumesOptions
  extends Pick<HeyoConnectionOptions, 'bin' | 'cloudUrl' | 'dev' | 'cliToken' | 'dryRun'> {}

function cli(options: HeyoVolumesOptions): CliTransport {
  return new CliTransport({
    bin: options.bin,
    cloudUrl: options.cloudUrl,
    dev: options.dev,
    token: options.cliToken,
    dryRun: options.dryRun,
  });
}

/** Create a named volume, optionally seeding it from a host directory. */
export function createHeyoVolume(
  name: string,
  opts: CreateVolumeOptions & HeyoVolumesOptions = {},
): Promise<VolumeInfo> {
  return cli(opts).createVolume(name, { from: opts.from, mountPath: opts.mountPath });
}

/** List registered volumes. */
export function listHeyoVolumes(opts: HeyoVolumesOptions = {}): Promise<VolumeInfo[]> {
  return cli(opts).listVolumes();
}

/** Print the host path of a volume (for use with `mounts`). */
export function heyoVolumePath(
  name: string,
  opts: HeyoVolumesOptions = {},
): Promise<string> {
  return cli(opts).volumePath(name);
}

/** Remove a volume from the registry (optionally deleting its data). */
export function removeHeyoVolume(
  name: string,
  opts: { purge?: boolean } & HeyoVolumesOptions = {},
): Promise<void> {
  return cli(opts).removeVolume(name, { purge: opts.purge });
}
