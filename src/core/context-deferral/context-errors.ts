export const CONTEXT_ERROR_CODES = [
  "INVALID_CONTEXT_REF",
  "CONTEXT_NOT_FOUND",
  "CONTEXT_INVALID",
  "CONTEXT_DIGEST_MISMATCH",
  "CONTEXT_PATH_UNSAFE",
  "CONTEXT_READ_FAILED",
] as const;

export type ContextErrorCode = (typeof CONTEXT_ERROR_CODES)[number];

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
