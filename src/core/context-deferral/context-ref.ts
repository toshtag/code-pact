export const CONTEXT_REF_PREFIX = "context:sha256:";
export const CONTEXT_SHA256_PATTERN = /^[0-9a-f]{64}$/;
export const CONTEXT_REF_PATTERN = /^context:sha256:([0-9a-f]{64})$/;

export function contextRefFromDigest(digest: string): string {
  if (!CONTEXT_SHA256_PATTERN.test(digest)) {
    const err = new Error("invalid context digest");
    (err as NodeJS.ErrnoException).code = "INVALID_CONTEXT_REF";
    throw err;
  }
  return `${CONTEXT_REF_PREFIX}${digest}`;
}

export function parseContextRef(ref: string): string {
  const match = CONTEXT_REF_PATTERN.exec(ref);
  if (!match) {
    const err = new Error(
      "context reference must match context:sha256:<64 lowercase hex>",
    );
    (err as NodeJS.ErrnoException).code = "INVALID_CONTEXT_REF";
    throw err;
  }
  return match[1]!;
}
