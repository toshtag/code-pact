import { z } from "zod";
import { RelativePosixPath } from "../../schemas/relative-path.ts";
import {
  brandOwnedDelete,
  brandOwnedRead,
  brandOwnedWrite,
  type OwnedDeletePath,
  type OwnedReadPath,
  type OwnedWritePath,
} from "../branded-paths-internal.ts";
export { unbrand } from "../branded-paths.ts";
import {
  resolveAndBrandReadForAuthority,
  resolveAndBrandWriteForAuthority,
} from "../authority-resolvers.ts";

export const PruneSourcePath = RelativePosixPath.refine(
  p =>
    (!p.includes("/") && p.endsWith(".md")) ||
    (p.startsWith("docs/") && p.endsWith(".md")) ||
    (p.startsWith("design/") && p.endsWith(".md")) ||
    (p.startsWith(".github/") && (p.endsWith(".md") || p.endsWith(".yml"))),
  "path is outside the prune source surface",
);

export type PruneSourcePath = z.infer<typeof PruneSourcePath>;

export async function resolvePruneSourceReadPath(
  cwd: string,
  path: PruneSourcePath,
): Promise<OwnedReadPath> {
  return resolveAndBrandReadForAuthority(cwd, path, p =>
    PruneSourcePath.safeParse(p).success,
  );
}

export async function resolvePruneSourceWritePath(
  cwd: string,
  path: PruneSourcePath,
): Promise<OwnedWritePath> {
  return resolveAndBrandWriteForAuthority(cwd, path, p =>
    PruneSourcePath.safeParse(p).success,
  );
}

export async function resolvePrunedLedgerReadPath(
  cwd: string,
): Promise<OwnedReadPath> {
  return resolveAndBrandReadForAuthority(
    cwd,
    "design/decisions/PRUNED.md",
    p => p === "design/decisions/PRUNED.md",
  );
}

export async function resolvePrunedLedgerWritePath(
  cwd: string,
): Promise<OwnedWritePath> {
  return resolveAndBrandWriteForAuthority(
    cwd,
    "design/decisions/PRUNED.md",
    p => p === "design/decisions/PRUNED.md",
  );
}

export function pruneReadPath(path: string): OwnedReadPath {
  return brandOwnedRead(path);
}

export function pruneWritePath(path: string): OwnedWritePath {
  return brandOwnedWrite(path);
}

export function pruneDeletePath(path: string): OwnedDeletePath {
  return brandOwnedDelete(path);
}
