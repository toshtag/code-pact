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
  fallbackReason: string | null;
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
  stage: "focused" | "full";
  fallback_full: boolean;
  fallback_reason: string | null;
  reason: string;
  changed_files: string[];
  selected_unit_tests: number | null;
  selected_integration_tests: number | null;
  command_count: number;
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
  scope: VerificationScope;
  change_set: Partial<LocalChangedFiles>;
  steps: VerificationStep[];
}

export function validatePlan(plan: unknown): true;

export function buildVerificationPlan(options: {
  scope: VerificationScope;
  changeSet?: Partial<LocalChangedFiles>;
  mergeBase?: string | null;
  baseSha?: string | null;
  headSha?: string | null;
  stage?: "focused" | "full" | null;
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
