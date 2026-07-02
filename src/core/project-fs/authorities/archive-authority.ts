import {
  brandOwnedDelete,
  brandOwnedList,
  brandOwnedRead,
  brandOwnedWrite,
  brandArchiveAuthority,
  type ArchiveAuthorityPath,
  type OwnedDeletePath,
  type OwnedListPath,
  type OwnedReadPath,
  type OwnedWritePath,
} from "../branded-paths-internal.ts";
import {
  resolveAndBrandDeleteForAuthority,
  resolveAndBrandListForAuthority,
  resolveAndBrandReadForAuthority,
  resolveAndBrandWriteForAuthority,
} from "../authority-resolvers.ts";
export { unbrand } from "../branded-paths.ts";
export type {
  ArchiveAuthorityPath,
  OwnedDeletePath,
  OwnedListPath,
  OwnedReadPath,
  OwnedWritePath,
} from "../branded-paths.ts";

type ArchiveReadPath = OwnedReadPath & ArchiveAuthorityPath;
type ArchiveWritePath = OwnedWritePath & ArchiveAuthorityPath;
type ArchiveDeletePath = OwnedDeletePath & ArchiveAuthorityPath;
type ArchiveListPath = OwnedListPath & ArchiveAuthorityPath;

export function archiveReadPath(path: ArchiveAuthorityPath): OwnedReadPath {
  return brandOwnedRead(path);
}

export function archiveWritePath(path: ArchiveAuthorityPath): OwnedWritePath {
  return brandOwnedWrite(path);
}

export function archiveDeletePath(path: ArchiveAuthorityPath): OwnedDeletePath {
  return brandOwnedDelete(path);
}

export function archiveListPath(path: ArchiveAuthorityPath): OwnedListPath {
  return brandOwnedList(path);
}

export async function resolveArchiveAuthorityProof(
  cwd: string,
  relPath: string,
): Promise<ArchiveAuthorityPath> {
  return brandArchiveAuthority(
    await resolveAndBrandReadForAuthority(cwd, relPath, isArchiveRelPath),
  );
}

export async function resolveArchiveReadPath(
  cwd: string,
  relPath: string,
): Promise<ArchiveReadPath> {
  return brandArchiveAuthority(
    await resolveAndBrandReadForAuthority(cwd, relPath, isArchiveRelPath),
  ) as ArchiveReadPath;
}

export async function resolveArchiveWritePath(
  cwd: string,
  relPath: string,
): Promise<ArchiveWritePath> {
  return brandArchiveAuthority(
    await resolveAndBrandWriteForAuthority(cwd, relPath, isArchiveRelPath),
  ) as ArchiveWritePath;
}

export async function resolveArchiveDeletePath(
  cwd: string,
  relPath: string,
): Promise<ArchiveDeletePath> {
  return brandArchiveAuthority(
    await resolveAndBrandDeleteForAuthority(cwd, relPath, isArchiveRelPath),
  ) as ArchiveDeletePath;
}

export async function resolveArchiveListPath(
  cwd: string,
  relPath: string,
): Promise<ArchiveListPath> {
  return brandArchiveAuthority(
    await resolveAndBrandListForAuthority(cwd, relPath, isArchiveRelPath),
  ) as ArchiveListPath;
}

function isArchiveRelPath(path: string): boolean {
  return (
    path === ".code-pact/state/archive" ||
    path.startsWith(".code-pact/state/archive/") ||
    path === ".code-pact/state/events" ||
    path.startsWith(".code-pact/state/events/")
  );
}
