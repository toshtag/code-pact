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
import { contextError, contextErrorCode } from "./context-errors.ts";

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
  const digestFromRef = parseContextRef(artifact.ref);
  if (digestFromRef !== artifact.digest) {
    throw contextError(
      "CONTEXT_INVALID",
      "context manifest reference does not match artifact digest",
    );
  }
  const validated = validateContextManifestContent(
    artifact.content,
    artifact.digest,
  );

  try {
    const writePath = await resolveContextManifestWritePath(cwd, validated.digest);
    await atomicCreateTextExclusive(writePath, validated.content);
  } catch (error) {
    if (contextErrorCode(error)) throw error;
    if (isPathUnsafe(error)) {
      throw contextError(
        "CONTEXT_PATH_UNSAFE",
        "context manifest path was refused by filesystem authority",
        error,
      );
    }
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw contextError(
        "CONTEXT_WRITE_FAILED",
        "failed to write context manifest",
        error,
      );
    }
    const existing = await loadContextManifestArtifact(cwd, validated.ref);
    if (existing.content !== validated.content) {
      throw contextError(
        "CONTEXT_DIGEST_MISMATCH",
        "context digest collision or corrupted context manifest",
      );
    }
    return existing;
  }

  return loadContextManifestArtifact(cwd, validated.ref);
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
