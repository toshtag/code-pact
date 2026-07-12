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
  changeSet?: Partial<LocalChangedFiles>,
): [string, string[]][];

export interface LocalChangedFiles {
  baseFiles: string[];
  unstagedFiles: string[];
  stagedFiles: string[];
  untrackedFiles: string[];
  workingTreeFiles: string[];
  files: string[];
  mergeBase: string | null;
  baseResolved: boolean;
  indeterminate: boolean;
}

export interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type GitRunner = (args: string[]) => Promise<GitResult>;

export function collectLocalChangedFiles(options?: {
  runGitImpl?: GitRunner;
}): Promise<LocalChangedFiles>;
