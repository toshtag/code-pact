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

export function adapterReadPath(path: string): OwnedReadPath {
  return brandOwnedRead(path);
}

export function adapterWritePath(path: string): OwnedWritePath {
  return brandOwnedWrite(path);
}

export function adapterDeletePath(path: string): OwnedDeletePath {
  return brandOwnedDelete(path);
}

export function adapterListPath(path: string): OwnedListPath {
  return brandOwnedList(path);
}
