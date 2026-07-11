export const EVIDENCE_REF_PATTERN = /^evidence:sha256:([0-9a-f]{64})$/;
export const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export function evidenceRefFromDigest(digest: string): string {
  if (!SHA256_PATTERN.test(digest)) {
    const error = new Error("invalid evidence digest");
    (error as NodeJS.ErrnoException).code = "CONFIG_ERROR";
    throw error;
  }
  return `evidence:sha256:${digest}`;
}

export function parseEvidenceRef(ref: string): string {
  const match = EVIDENCE_REF_PATTERN.exec(ref);
  if (!match) {
    const error = new Error(
      "invalid evidence reference (expected evidence:sha256:<64 lowercase hex characters>)",
    );
    (error as NodeJS.ErrnoException).code = "INVALID_EVIDENCE_REF";
    throw error;
  }
  return match[1]!;
}
