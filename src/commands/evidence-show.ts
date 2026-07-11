import { loadEvidenceArtifact } from "../core/evidence/evidence-store.ts";
import type { EvidenceArtifact } from "../core/evidence/evidence-schema.ts";

export type EvidenceStream = "all" | "stdout" | "stderr";

export type EvidenceShowResult = {
  evidence_ref: string;
  digest: string;
  artifact: EvidenceArtifact;
};

export async function runEvidenceShow(
  cwd: string,
  ref: string,
): Promise<EvidenceShowResult> {
  const loaded = await loadEvidenceArtifact(cwd, ref);
  return {
    evidence_ref: loaded.ref,
    digest: loaded.digest,
    artifact: loaded.artifact,
  };
}

export function renderEvidenceStream(
  artifact: EvidenceArtifact,
  stream: EvidenceStream,
): string {
  switch (stream) {
    case "stdout":
      return artifact.stdout;
    case "stderr":
      return artifact.stderr;
    case "all":
      return `${artifact.stdout}${artifact.stderr}`;
  }
}
