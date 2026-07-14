export function loopMemoryInvalid(message: string, cause?: unknown): Error {
  const error = new Error(message);
  if (cause !== undefined) {
    (error as Error & { cause?: unknown }).cause = cause;
  }
  return error;
}

export function loopMemoryConflict(message: string): Error {
  return new Error(message);
}

export function loopMemoryPruneConflict(message: string): Error {
  const error = new Error(message);
  (error as NodeJS.ErrnoException).code = "MEMORY_PRUNE_CONFLICT";
  return error;
}
