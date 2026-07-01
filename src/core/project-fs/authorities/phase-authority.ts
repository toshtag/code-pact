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

export function phaseReadPath(path: string): OwnedReadPath {
  return brandOwnedRead(path);
}

export function phaseWritePath(path: string): OwnedWritePath {
  return brandOwnedWrite(path);
}

export function phaseDeletePath(path: string): OwnedDeletePath {
  return brandOwnedDelete(path);
}

export function phaseListPath(path: string): OwnedListPath {
  return brandOwnedList(path);
}
