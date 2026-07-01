import {
  brandOwnedRead,
  brandOwnedWrite,
  type OwnedReadPath,
  type OwnedWritePath,
} from "../branded-paths-internal.ts";
export { unbrand } from "../branded-paths.ts";
export type { OwnedReadPath, OwnedWritePath } from "../branded-paths.ts";

export function contextOutputReadPath(path: string): OwnedReadPath {
  return brandOwnedRead(path);
}

export function contextOutputWritePath(path: string): OwnedWritePath {
  return brandOwnedWrite(path);
}
