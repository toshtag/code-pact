// Type declarations for verify-published-tarball.mjs (consumed by the unit test;
// the script itself runs as plain Node ESM).

export function sha1hex(bytes: Uint8Array): string;
export function sha512sri(bytes: Uint8Array): string;
export function sha256hex(bytes: Uint8Array): string;

export function fetchRegistryMetadata(
  packageName: string,
  version: string,
  fetcher?: (url: string) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>,
  sleeper?: (ms: number) => Promise<void>,
): Promise<{ version: string; dist: { tarball: string; shasum: string; integrity: string } }>;

export function verifyPublishedTarball(opts: {
  packageName: string;
  version: string;
  localTarballPath: string;
  metadataFetcher?: () => Promise<any>;
  tarballFetcher?: (url: string) => Promise<Uint8Array>;
  fileReader?: (path: string) => Promise<Uint8Array | Buffer>;
}): Promise<{ ok: boolean; problems: string[]; report?: { package: string; version: string; tarball: string; shasum: string; integrity: string; local_sha256: string } }>;
