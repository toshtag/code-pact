export const DEFAULT_COMMAND_TIMEOUT_MS = 300_000;
export const MAX_TIMEOUT_MS = 2_147_483_647;

function timeoutError(value: unknown): Error {
  const error = new Error(
    `Timeout must be a decimal integer string of milliseconds between 1 and ${MAX_TIMEOUT_MS}; received ${String(value)}.`,
  );
  (error as NodeJS.ErrnoException).code = "CONFIG_ERROR";
  return error;
}

/** Validate the shared verification timeout contract. */
export function validateTimeoutMs(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TIMEOUT_MS) {
    throw timeoutError(value);
  }
  return value;
}

/** Parse a CLI timeout value without lossy flooring or timer overflow. */
export function parseTimeoutMs(raw: string): number {
  if (!/^[1-9][0-9]*$/.test(raw)) throw timeoutError(raw);
  const value = Number(raw);
  return validateTimeoutMs(value);
}
