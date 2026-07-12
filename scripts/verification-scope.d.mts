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
export function buildLocalCommands(
  scope: VerificationScope,
  mergeBase: string | null,
): [string, string[]][];

export interface LocalChangedFiles {
  files: string[];
  mergeBase: string | null;
  baseResolved: boolean;
}

export function collectLocalChangedFiles(): Promise<LocalChangedFiles>;
