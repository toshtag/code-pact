import {
  brandOwnedDelete,
  brandOwnedList,
  brandOwnedRead,
  brandOwnedWrite,
  brandAdapterAuthority,
  brandValidatedAuthorityPath,
  type AdapterAuthorityPath,
  type OwnedDeletePath,
  type OwnedListPath,
  type OwnedReadPath,
  type OwnedWritePath,
  type ValidatedAuthorityPath,
} from "../branded-paths-internal.ts";
import {
  resolveSymlinkFreeProjectPath,
  resolveSymlinkFreeProjectPathSync,
} from "../../path-safety.ts";
export { unbrand } from "../branded-paths.ts";
export type {
  AdapterAuthorityPath,
  OwnedDeletePath,
  OwnedListPath,
  OwnedReadPath,
  OwnedWritePath,
  ValidatedAuthorityPath,
} from "../branded-paths.ts";

type AdapterReadPath = OwnedReadPath & AdapterAuthorityPath;
type AdapterWritePath = OwnedWritePath & AdapterAuthorityPath;
type AdapterDeletePath = OwnedDeletePath & AdapterAuthorityPath;
type AdapterListPath = OwnedListPath & AdapterAuthorityPath;

export function adapterReadPath(path: AdapterAuthorityPath): AdapterReadPath {
  return brandAdapterAuthority(brandOwnedRead(path)) as AdapterReadPath;
}

export function adapterWritePath(path: AdapterAuthorityPath): AdapterWritePath {
  return brandAdapterAuthority(brandOwnedWrite(path)) as AdapterWritePath;
}

export function adapterDeletePath(
  path: AdapterAuthorityPath,
): AdapterDeletePath {
  return brandAdapterAuthority(brandOwnedDelete(path)) as AdapterDeletePath;
}

export function adapterListPath(path: AdapterAuthorityPath): AdapterListPath {
  return brandAdapterAuthority(brandOwnedList(path)) as AdapterListPath;
}

export function adapterValidatedAuthorityPath(
  path: string,
): AdapterAuthorityPath & ValidatedAuthorityPath {
  return brandAdapterAuthority(
    brandValidatedAuthorityPath(path),
  ) as AdapterAuthorityPath & ValidatedAuthorityPath;
}

export async function resolveAdapterProjectAuthorityPath(
  cwd: string,
  relPath: string,
): Promise<AdapterAuthorityPath> {
  return brandAdapterAuthority(
    await resolveSymlinkFreeProjectPath(cwd, relPath),
  );
}

export function resolveAdapterProjectAuthorityPathSync(
  cwd: string,
  relPath: string,
): AdapterAuthorityPath {
  return brandAdapterAuthority(resolveSymlinkFreeProjectPathSync(cwd, relPath));
}
