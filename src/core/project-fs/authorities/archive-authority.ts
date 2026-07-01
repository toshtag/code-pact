import {
  brandOwnedDelete,
  brandOwnedList,
  brandOwnedRead,
  brandOwnedWrite,
  type OwnedDeletePath,
  type OwnedListPath,
  type OwnedReadPath,
  type OwnedWritePath,
} from "../branded-paths-internal.ts";
export { unbrand } from "../branded-paths.ts";
export type {
  OwnedDeletePath,
  OwnedListPath,
  OwnedReadPath,
  OwnedWritePath,
} from "../branded-paths.ts";

export function archiveReadPath(path: string): OwnedReadPath {
  return brandOwnedRead(path);
}

export function archiveWritePath(path: string): OwnedWritePath {
  return brandOwnedWrite(path);
}

export function archiveDeletePath(path: string): OwnedDeletePath {
  return brandOwnedDelete(path);
}

export function archiveListPath(path: string): OwnedListPath {
  return brandOwnedList(path);
}
