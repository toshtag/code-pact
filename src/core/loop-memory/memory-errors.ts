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

export function loopMemoryPruneConflict(
  message: string,
  metadata: { partial_applied?: boolean; deleted_count?: number } = {},
): Error {
  const error = new Error(message);
  (error as NodeJS.ErrnoException).code = "MEMORY_PRUNE_CONFLICT";
  (error as NodeJS.ErrnoException & { partial_applied: boolean }).partial_applied =
    metadata.partial_applied ?? false;
  (error as NodeJS.ErrnoException & { deleted_count: number }).deleted_count =
    metadata.deleted_count ?? 0;
  return error;
}

export function loopMemoryPruneFailed(
  message: string,
  metadata: {
    partial_applied?: boolean;
    deleted_count?: number;
    system_code?: string;
  } = {},
  cause?: unknown,
): Error {
  const error = new Error(message);
  (error as NodeJS.ErrnoException).code = "MEMORY_PRUNE_FAILED";
  (error as NodeJS.ErrnoException & { partial_applied: boolean }).partial_applied =
    metadata.partial_applied ?? false;
  (error as NodeJS.ErrnoException & { deleted_count: number }).deleted_count =
    metadata.deleted_count ?? 0;
  if (metadata.system_code !== undefined) {
    (error as NodeJS.ErrnoException & { system_code: string }).system_code =
      metadata.system_code;
  }
  if (cause !== undefined) {
    (error as Error & { cause?: unknown }).cause = cause;
  }
  return error;
}
