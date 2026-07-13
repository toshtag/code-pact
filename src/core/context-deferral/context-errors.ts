export const CONTEXT_ERROR_DESCRIPTORS = [
  { code: "INVALID_CONTEXT_REF" },
  { code: "CONTEXT_NOT_FOUND" },
  { code: "CONTEXT_INVALID" },
  { code: "CONTEXT_DIGEST_MISMATCH" },
  { code: "CONTEXT_PATH_UNSAFE" },
  { code: "CONTEXT_READ_FAILED" },
  { code: "CONTEXT_WRITE_FAILED" },
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

export function contextErrorCode(error: unknown): ContextErrorCode | null {
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" &&
    (CONTEXT_ERROR_CODES as ReadonlyArray<string>).includes(code)
    ? (code as ContextErrorCode)
    : null;
}

const CONTEXT_CODES = new Set<string>(CONTEXT_ERROR_CODES);
const PLATFORM_ERRNO_PATTERN = /^(E[A-Z0-9]+|FS_AUTHORITY_FAILURE|PATH_NOT_OWNED|PATH_OUTSIDE_PROJECT)$/;

export function underlyingSystemCode(error: unknown): string | undefined {
  let current: unknown = (error as Error & { cause?: unknown }).cause;
  while (current) {
    const code = (current as NodeJS.ErrnoException).code;
    if (
      typeof code === "string" &&
      !CONTEXT_CODES.has(code) &&
      PLATFORM_ERRNO_PATTERN.test(code)
    ) {
      return code;
    }
    current = (current as Error & { cause?: unknown }).cause;
  }
  return undefined;
}
