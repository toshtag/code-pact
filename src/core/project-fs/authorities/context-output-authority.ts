import {
  brandValidatedAuthorityPath,
  brandExplicitUserWrite,
  type OwnedWritePath,
  type ExplicitUserWritePath,
} from "../branded-paths-internal.ts";
import { resolveAndBrandWriteForAuthority } from "../authority-resolvers.ts";
import { isAbsolute, join } from "node:path";
export { unbrand } from "../branded-paths.ts";
export type { OwnedWritePath } from "../branded-paths.ts";

function isGeneratedContextOutputPath(path: string): boolean {
  return path === ".context" || path.startsWith(".context/");
}

export async function resolveProfileContextOutputWritePath(
  cwd: string,
  relPath: string,
): Promise<OwnedWritePath> {
  return resolveAndBrandWriteForAuthority(
    cwd,
    relPath,
    isGeneratedContextOutputPath,
  );
}

export async function resolveExplicitProjectContextOutputWritePath(
  cwd: string,
  relPath: string,
): Promise<ExplicitUserWritePath> {
  return brandExplicitUserWrite(
    await resolveAndBrandWriteForAuthority(cwd, relPath, () => true),
  );
}

export function resolveExplicitContextOutputWritePath(
  outputDir: string,
  fileName: string,
): ExplicitUserWritePath {
  if (!isAbsolute(outputDir)) {
    throw new Error("explicit context output directory must be absolute");
  }
  return brandExplicitUserWrite(
    brandValidatedAuthorityPath(join(outputDir, fileName)),
  );
}
