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

export function decisionReadPath(path: string): OwnedReadPath {
  return brandOwnedRead(path);
}

export function decisionWritePath(path: string): OwnedWritePath {
  return brandOwnedWrite(path);
}

export function decisionDeletePath(path: string): OwnedDeletePath {
  return brandOwnedDelete(path);
}

export function decisionListPath(path: string): OwnedListPath {
  return brandOwnedList(path);
}
