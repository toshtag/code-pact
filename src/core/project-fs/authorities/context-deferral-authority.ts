import {
  resolveAndBrandReadForAuthority,
  resolveAndBrandWriteForAuthority,
} from "../authority-resolvers.ts";
import type { OwnedReadPath, OwnedWritePath } from "../branded-paths.ts";
import {
  CONTEXT_SHA256_PATTERN,
  parseContextRef,
} from "../../context-deferral/context-ref.ts";

function contextManifestRelPath(digest: string): string {
  return `.code-pact/cache/context/${digest}.json`;
}

export async function resolveContextManifestReadPath(
  cwd: string,
  ref: string,
): Promise<OwnedReadPath> {
  const digest = parseContextRef(ref);
  const relPath = contextManifestRelPath(digest);
  return resolveAndBrandReadForAuthority(
    cwd,
    relPath,
    path => path === relPath,
  );
}

export async function resolveContextManifestWritePath(
  cwd: string,
  digest: string,
): Promise<OwnedWritePath> {
  if (!CONTEXT_SHA256_PATTERN.test(digest)) {
    const err = new Error("path is not in an owned namespace");
    (err as NodeJS.ErrnoException).code = "PATH_NOT_OWNED";
    throw err;
  }
  const relPath = contextManifestRelPath(digest);
  return resolveAndBrandWriteForAuthority(
    cwd,
    relPath,
    path => path === relPath,
  );
}
