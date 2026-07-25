export interface CheckResult {
  ok: boolean;
  owner: string;
  repo: string;
  sha: string;
  check_name: string;
  status: string | null;
  conclusion: string | null;
  total_check_runs: number;
  matching_check_runs: number;
  attempts: number;
  latest_run_id?: number | null;
  error?: string;
}

export interface CheckOptions {
  owner: string;
  repo: string;
  sha: string;
  checkName: string;
  token?: string;
  requestTimeoutMs?: number;
  retryAttempts?: number;
  retryIntervalMs?: number;
  overallTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export function checkRequiredCiForSha(options: CheckOptions): Promise<CheckResult>;
