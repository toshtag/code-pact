import { z } from "zod";
import { RelativePosixPath } from "../../schemas/relative-path.ts";
import {
  type OwnedListPath,
  type OwnedReadPath,
  type OwnedWritePath,
} from "../branded-paths-internal.ts";
export { unbrand } from "../branded-paths.ts";
import {
  resolveAndBrandListForAuthority,
  resolveAndBrandReadForAuthority,
  resolveAndBrandWriteForAuthority,
} from "../authority-resolvers.ts";

export const NormalizeTargetPath = RelativePosixPath.refine(
  p =>
    (p.startsWith("design/") &&
      (p.endsWith(".md") || p.endsWith(".yaml") || p.endsWith(".yml"))) ||
    p === ".code-pact/state/progress.yaml",
  "path is not a normalization target",
);

export type NormalizeTargetPath = z.infer<typeof NormalizeTargetPath>;

export async function resolveNormalizeReadPath(
  cwd: string,
  path: NormalizeTargetPath,
): Promise<OwnedReadPath> {
  return resolveAndBrandReadForAuthority(cwd, path, p =>
    NormalizeTargetPath.safeParse(p).success,
  );
}

export async function resolveNormalizeWritePath(
  cwd: string,
  path: NormalizeTargetPath,
): Promise<OwnedWritePath> {
  return resolveAndBrandWriteForAuthority(cwd, path, p =>
    NormalizeTargetPath.safeParse(p).success,
  );
}

export async function resolveNormalizeListPath(
  cwd: string,
  path: string,
): Promise<OwnedListPath> {
  return resolveAndBrandListForAuthority(
    cwd,
    path,
    p => p === "design" || p.startsWith("design/"),
  );
}
