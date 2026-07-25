// Verify that a named required CI check (or GitHub Actions workflow job)
// succeeded for an exact commit SHA before a release proceeds.
//
// Usage:
//   node scripts/check-required-ci-for-sha.mjs --owner toshtag --repo code-pact \
//     --sha <40-char-sha> --check-name "CI status" [--token "$GITHUB_TOKEN"]

import { parseArgs } from "node:util";
import process from "node:process";

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_ATTEMPTS = 6;
const DEFAULT_RETRY_INTERVAL_MS = 5_000;
const DEFAULT_OVERALL_TIMEOUT_MS = 120_000;

function assertHexSha(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/i.test(value)) {
    throw new Error(`--sha must be a full 40-character hex SHA: ${value}`);
  }
}

const GITHUB_API_BASE = "https://api.github.com";
const CI_WORKFLOW_ID = "ci.yml";

export async function checkRequiredCiForSha({
  owner,
  repo,
  sha,
  checkName,
  token,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  retryAttempts = DEFAULT_RETRY_ATTEMPTS,
  retryIntervalMs = DEFAULT_RETRY_INTERVAL_MS,
  overallTimeoutMs = DEFAULT_OVERALL_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
}) {
  assertHexSha(sha);

  const lowerSha = sha.toLowerCase();
  const baseUrl = `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/${encodeURIComponent(CI_WORKFLOW_ID)}/runs`;
  const listUrl = `${baseUrl}?head_sha=${encodeURIComponent(lowerSha)}&branch=${encodeURIComponent("main")}&event=${encodeURIComponent("push")}&per_page=100`;
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const startedAt = Date.now();
  let lastError = null;
  let lastResponseStatus = null;

  for (let attempt = 1; attempt <= retryAttempts; attempt++) {
    if (Date.now() - startedAt >= overallTimeoutMs) {
      lastError = "overall timeout exceeded";
      break;
    }

    const listResult = await fetchJson(listUrl, {
      headers,
      requestTimeoutMs,
      fetchImpl,
    });

    if (listResult.error) {
      lastResponseStatus = listResult.status;
      if (listResult.status === 401 || listResult.status === 403) {
        return immediateFail({
          owner,
          repo,
          sha: lowerSha,
          checkName,
          attempt,
          status: String(listResult.status),
          error: listResult.error,
        });
      }
      if (
        listResult.status === 429 ||
        (typeof listResult.status === "number" && listResult.status >= 500) ||
        listResult.network
      ) {
        lastError = listResult.error;
        if (attempt < retryAttempts) {
          await sleep(retryIntervalMs);
          continue;
        }
        break;
      }
      return immediateFail({
        owner,
        repo,
        sha: lowerSha,
        checkName,
        attempt,
        status: String(listResult.status ?? "unknown"),
        error: listResult.error,
      });
    }

    const data = listResult.data;
    const allRuns = Array.isArray(data.workflow_runs) ? data.workflow_runs : [];
    const runs = allRuns.filter(
      run =>
        typeof run === "object" &&
        run.event === "push" &&
        run.head_branch === "main" &&
        (run.head_sha ?? "").toLowerCase() === lowerSha,
    );

    if (runs.length === 0) {
      lastError = "no main push workflow run for the exact SHA";
      if (attempt < retryAttempts) {
        await sleep(retryIntervalMs);
        continue;
      }
      break;
    }

    const latest = latestWorkflowRun(runs);

    if (!isTerminalStatus(latest.status)) {
      lastError = `latest workflow run is ${latest.status}`;
      if (attempt < retryAttempts) {
        await sleep(retryIntervalMs);
        continue;
      }
      break;
    }

    if (latest.status !== "completed" || latest.conclusion !== "success") {
      return {
        ok: false,
        owner,
        repo,
        sha: lowerSha,
        check_name: checkName,
        status: String(latest.status ?? "completed"),
        conclusion: latest.conclusion ?? null,
        total_check_runs: allRuns.length,
        matching_check_runs: runs.length,
        attempts: attempt,
        latest_run_id: latest.id ?? null,
        error:
          latest.conclusion && latest.conclusion !== "success"
            ? `workflow run conclusion is ${latest.conclusion}`
            : `workflow run status is ${latest.status}`,
      };
    }

    if (checkName) {
      const jobResult = await verifyNamedJob({
        owner,
        repo,
        runId: latest.id,
        checkName,
        token,
        requestTimeoutMs,
        fetchImpl,
      });
      if (jobResult.error) {
        if (jobResult.retryable && attempt < retryAttempts) {
          lastError = jobResult.error;
          lastResponseStatus = jobResult.status;
          await sleep(retryIntervalMs);
          continue;
        }
        return {
          ok: false,
          owner,
          repo,
          sha: lowerSha,
          check_name: checkName,
          status: String(jobResult.status ?? "unknown"),
          conclusion: jobResult.conclusion ?? null,
          total_check_runs: allRuns.length,
          matching_check_runs: runs.length,
          attempts: attempt,
          latest_run_id: latest.id ?? null,
          error: jobResult.error,
        };
      }
      return {
        ok: jobResult.ok,
        owner,
        repo,
        sha: lowerSha,
        check_name: checkName,
        status: jobResult.status,
        conclusion: jobResult.conclusion,
        total_check_runs: allRuns.length,
        matching_check_runs: runs.length,
        attempts: attempt,
        latest_run_id: latest.id ?? null,
        error: jobResult.error ?? null,
      };
    }

    return {
      ok: true,
      owner,
      repo,
      sha: lowerSha,
      check_name: checkName,
      status: latest.status,
      conclusion: latest.conclusion,
      total_check_runs: allRuns.length,
      matching_check_runs: runs.length,
      attempts: attempt,
      latest_run_id: latest.id ?? null,
      error: null,
    };
  }

  return {
    ok: false,
    owner,
    repo,
    sha: lowerSha,
    check_name: checkName,
    status: lastResponseStatus ? String(lastResponseStatus) : "not_found",
    conclusion: null,
    total_check_runs: 0,
    matching_check_runs: 0,
    attempts: retryAttempts,
    latest_run_id: null,
    error: lastError ?? "required CI did not complete successfully",
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isTerminalStatus(status) {
  return status === "completed";
}

function runTs(run) {
  const created = run.created_at ? Date.parse(run.created_at) : null;
  if (created !== null) return created;
  const started = run.started_at ? Date.parse(run.started_at) : null;
  if (started !== null) return started;
  return 0;
}

function latestWorkflowRun(runs) {
  return [...runs].sort((a, b) => {
    const tsA = runTs(a);
    const tsB = runTs(b);
    if (tsA !== tsB) return tsB - tsA;

    const numA = typeof a.run_number === "number" ? a.run_number : 0;
    const numB = typeof b.run_number === "number" ? b.run_number : 0;
    if (numA !== numB) return numB - numA;

    const idA = typeof a.id === "number" ? a.id : Number(a.id ?? 0);
    const idB = typeof b.id === "number" ? b.id : Number(b.id ?? 0);
    return idB - idA;
  })[0];
}

async function fetchJson(url, { headers, requestTimeoutMs, fetchImpl }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers,
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return {
        error: `GitHub API ${response.status}: ${body}`,
        status: response.status,
      };
    }
    const data = await response.json();
    return { data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      error: message,
      network: true,
      status: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

function immediateFail({
  owner,
  repo,
  sha,
  checkName,
  attempt,
  status,
  error,
}) {
  return {
    ok: false,
    owner,
    repo,
    sha,
    check_name: checkName,
    status,
    conclusion: null,
    total_check_runs: 0,
    matching_check_runs: 0,
    attempts: attempt,
    latest_run_id: null,
    error,
  };
}

async function verifyNamedJob({
  owner,
  repo,
  runId,
  checkName,
  token,
  requestTimeoutMs,
  fetchImpl,
}) {
  const url = `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${encodeURIComponent(runId)}/jobs?filter=latest`;
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const result = await fetchJson(url, {
    headers,
    requestTimeoutMs,
    fetchImpl,
  });
  if (result.error) {
    const retryable =
      result.network === true ||
      result.status === 429 ||
      (typeof result.status === "number" && result.status >= 500);
    return {
      ok: false,
      status: result.status ?? null,
      retryable,
      conclusion: null,
      error: result.error,
    };
  }

  const jobs = Array.isArray(result.data.jobs) ? result.data.jobs : [];
  const job = jobs.find(j => j.name === checkName);

  if (!job) {
    return {
      ok: false,
      status: "not_found",
      retryable: false,
      conclusion: null,
      error: `workflow run does not contain job "${checkName}"`,
    };
  }

  if (job.status !== "completed" || job.conclusion !== "success") {
    return {
      ok: false,
      status: String(job.status ?? "unknown"),
      retryable: false,
      conclusion: job.conclusion ?? null,
      error:
        job.conclusion && job.conclusion !== "success"
          ? `job "${checkName}" conclusion is ${job.conclusion}`
          : `job "${checkName}" status is ${job.status}`,
    };
  }

  return {
    ok: true,
    status: job.status,
    retryable: false,
    conclusion: job.conclusion,
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      owner: { type: "string" },
      repo: { type: "string" },
      sha: { type: "string" },
      "check-name": { type: "string" },
      token: { type: "string" },
      json: { type: "boolean", default: false },
      "timeout-ms": { type: "string" },
    },
    allowPositionals: false,
  });

  const missing = [];
  if (!values.owner) missing.push("--owner");
  if (!values.repo) missing.push("--repo");
  if (!values.sha) missing.push("--sha");
  if (!values["check-name"]) missing.push("--check-name");
  if (missing.length > 0) {
    console.error(`check-required-ci-for-sha: missing ${missing.join(", ")}`);
    process.exit(2);
  }

  const requestTimeoutMs = values["timeout-ms"]
    ? Number(values["timeout-ms"])
    : DEFAULT_REQUEST_TIMEOUT_MS;
  const result = await checkRequiredCiForSha({
    owner: values.owner,
    repo: values.repo,
    sha: values.sha,
    checkName: values["check-name"],
    token: values.token,
    requestTimeoutMs,
  });

  if (values.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.ok) {
    console.log(
      `check-required-ci-for-sha: ${result.check_name} succeeded for ${result.sha}`,
    );
  } else {
    console.error(
      `check-required-ci-for-sha: ${result.check_name} did not succeed for ${result.sha} ` +
        `(status=${result.status}, conclusion=${result.conclusion}, ` +
        `matches=${result.matching_check_runs})`,
    );
  }

  process.exit(result.ok ? 0 : 1);
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  main().catch(err => {
    console.error(
      `check-required-ci-for-sha: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(2);
  });
}
