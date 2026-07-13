export const CONTEXT_ERROR_DESCRIPTORS = [
  { code: "INVALID_CONTEXT_REF" },
  { code: "CONTEXT_NOT_FOUND" },
  { code: "CONTEXT_INVALID" },
  { code: "CONTEXT_DIGEST_MISMATCH" },
  { code: "CONTEXT_PATH_UNSAFE" },
  { code: "CONTEXT_READ_FAILED" },
] as const;

export type ContextErrorCode = (typeof CONTEXT_ERROR_DESCRIPTORS)[number]["code"];

export const CONTEXT_ERROR_CODES = CONTEXT_ERROR_DESCRIPTORS.map(
  item => item.code,
) as ContextErrorCode[];

export function contextError(
  code: ContextErrorCode,
  message: string,
  cause?: unknown,
): Error {
  const error = new Error(message);
  (error as NodeJS.ErrnoException).code = code;
  if (cause !== undefined) {
    (error as Error & { cause?: unknown }).cause = cause;
  }
  return error;
}
