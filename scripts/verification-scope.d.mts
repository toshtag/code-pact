export interface VerificationScope {
  changedFiles: string[];
  docs: boolean;
  standard: boolean;
  toolchain: boolean;
  processControl: boolean;
  generic: boolean;
  reason: string;
}

export function classifyChangedFiles(files: string[]): VerificationScope;
