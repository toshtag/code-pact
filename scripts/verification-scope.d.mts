export interface VerificationScope {
  changedFiles: string[];
  docs: boolean;
  standard: boolean;
  toolchain: boolean;
  processControl: boolean;
  generic: boolean;
  workflow: boolean;
  releaseScript: boolean;
  sharedTestInfra: boolean;
  unknown: boolean;
  highRisk: boolean;
  fallbackFull: boolean;
  mode: "focused" | "full";
  reason: string;
}

export function classifyChangedFiles(files: string[]): VerificationScope;

export interface VerificationStep {
  id: string;
  scope: string;
  enabled: boolean;
  command: string[];
  timeout_ms: number;
  reason: string;
}

export interface VerificationPlan {
  schema_version: string;
  base_sha: string | null;
  head_sha: string | null;
  mode: "focused" | "full";
  fallback_full: boolean;
  reason: string;
  changed_files: string[];
  categories: {
    docs: boolean;
    standard: boolean;
    toolchain: boolean;
    process_control: boolean;
    generic: boolean;
    workflow: boolean;
    release: boolean;
    shared_test_infra: boolean;
    unknown: boolean;
    high_risk: boolean;
  };
  steps: VerificationStep[];
}

export function buildVerificationPlan(options: {
  scope: VerificationScope;
  changeSet?: Partial<LocalChangedFiles>;
  mergeBase?: string | null;
  baseSha?: string | null;
  headSha?: string | null;
}): VerificationPlan;

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
