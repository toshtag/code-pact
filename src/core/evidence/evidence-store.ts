import { createHash } from "node:crypto";
import {
  readOwnedText,
  resolveEvidenceReadPath,
  resolveEvidenceWritePath,
} from "../project-fs/index.ts";
import { atomicCreateTextExclusive } from "../../io/atomic-text.ts";
import { canonicalJson } from "./canonical-json.ts";
import { evidenceRefFromDigest, parseEvidenceRef } from "./evidence-ref.ts";
import {
  EvidenceArtifactSchema,
  type EvidenceArtifact,
} from "./evidence-schema.ts";

export type StoredEvidence = {
  ref: string;
  digest: string;
  artifact: EvidenceArtifact;
};

export function artifactDigest(artifact: EvidenceArtifact): string {
  return createHash("sha256")
    .update(canonicalJson(artifact))
    .digest("hex");
}

export async function storeEvidenceArtifact(
  cwd: string,
  artifact: EvidenceArtifact,
): Promise<StoredEvidence> {
  const parsed = EvidenceArtifactSchema.parse(artifact);
  const content = canonicalJson(parsed);
  const digest = artifactDigest(parsed);

  try {
    await atomicCreateTextExclusive(await resolveEvidenceWritePath(cwd, digest), content);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readOwnedText(
      await resolveEvidenceReadPath(cwd, evidenceRefFromDigest(digest)),
    );
    if (existing !== content) {
      const conflict = new Error("evidence digest collision or corrupted evidence file");
      (conflict as NodeJS.ErrnoException).code = "EVIDENCE_CONFLICT";
      throw conflict;
    }
  }

  return { ref: evidenceRefFromDigest(digest), digest, artifact: parsed };
}

export async function loadEvidenceArtifact(
  cwd: string,
  ref: string,
): Promise<StoredEvidence> {
  const digest = parseEvidenceRef(ref);
  let raw: string;
  try {
    raw = await readOwnedText(await resolveEvidenceReadPath(cwd, ref));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const missing = new Error(`evidence not found: ${ref}`);
      (missing as NodeJS.ErrnoException).code = "EVIDENCE_NOT_FOUND";
      throw missing;
    }
    throw error;
  }
  const parsed = EvidenceArtifactSchema.parse(JSON.parse(raw));
  const actual = artifactDigest(parsed);
  if (actual !== digest) {
    const mismatch = new Error("evidence file content does not match reference digest");
    (mismatch as NodeJS.ErrnoException).code = "EVIDENCE_DIGEST_MISMATCH";
    throw mismatch;
  }
  return { ref, digest, artifact: parsed };
}
