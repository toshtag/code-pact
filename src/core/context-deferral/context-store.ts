import { atomicCreateTextExclusive } from "../../io/atomic-text.ts";
import {
  readOwnedText,
  resolveContextManifestReadPath,
  resolveContextManifestWritePath,
} from "../project-fs/index.ts";
import { parseContextRef } from "./context-ref.ts";
import {
  validateContextManifestContent,
  type PendingContextManifestArtifact,
} from "./context-manifest.ts";
import { contextError } from "./context-errors.ts";

function isPathUnsafe(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return (
    code === "PATH_NOT_OWNED" ||
    code === "PATH_OUTSIDE_PROJECT" ||
    code === "FS_AUTHORITY_FAILURE"
  );
}

export async function storeContextManifestArtifact(
  cwd: string,
  artifact: PendingContextManifestArtifact,
): Promise<PendingContextManifestArtifact> {
  try {
    const writePath = await resolveContextManifestWritePath(cwd, artifact.digest);
    await atomicCreateTextExclusive(
      writePath,
      artifact.content,
    );
  } catch (error) {
    if (isPathUnsafe(error)) {
      throw contextError(
        "CONTEXT_PATH_UNSAFE",
        "context manifest path was refused by filesystem authority",
        error,
      );
    }
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const readPath = await resolveContextManifestReadPath(cwd, artifact.ref);
    const existing = await readOwnedText(
      readPath,
    );
    if (existing !== artifact.content) {
      throw contextError(
        "CONTEXT_DIGEST_MISMATCH",
        "context digest collision or corrupted context manifest",
      );
    }
  }

  return loadContextManifestArtifact(cwd, artifact.ref);
}

export async function loadContextManifestArtifact(
  cwd: string,
  ref: string,
): Promise<PendingContextManifestArtifact> {
  const digest = parseContextRef(ref);
  let raw: string;
  try {
    const readPath = await resolveContextManifestReadPath(cwd, ref);
    raw = await readOwnedText(readPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw contextError("CONTEXT_NOT_FOUND", `context not found: ${ref}`, error);
    }
    if (isPathUnsafe(error)) {
      throw contextError(
        "CONTEXT_PATH_UNSAFE",
        "context manifest path was refused by filesystem authority",
        error,
      );
    }
    throw contextError("CONTEXT_READ_FAILED", "failed to read context manifest", error);
  }
  return validateContextManifestContent(raw, digest);
}
