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

  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${sha}/check-runs?per_page=100`;
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

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    let response;
    try {
      response = await fetchImpl(url, { headers, signal: controller.signal });
    } catch (err) {
      clearTimeout(timer);
      lastError = err instanceof Error ? err.message : String(err);
      // Retry on network / abort errors.
      if (attempt < retryAttempts) {
        await sleep(retryIntervalMs);
        continue;
      }
      break;
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      lastResponseStatus = response.status;
      const body = await response.text().catch(() => "");
      // 401/403 are auth/permission failures — fail immediately.
      if (response.status === 401 || response.status === 403) {
        return {
          ok: false,
          owner,
          repo,
          sha: sha.toLowerCase(),
          check_name: checkName,
          status: String(response.status),
          conclusion: null,
          total_check_runs: 0,
          matching_check_runs: 0,
          attempts: attempt,
          error: `GitHub API ${response.status}: ${body}`,
        };
      }
      // Retry on rate-limit (429) and server errors.
      if (response.status === 429 || response.status >= 500) {
        if (attempt < retryAttempts) {
          await sleep(retryIntervalMs);
          continue;
        }
      }
      return {
        ok: false,
        owner,
        repo,
        sha: sha.toLowerCase(),
        check_name: checkName,
        status: String(response.status),
        conclusion: null,
        total_check_runs: 0,
        matching_check_runs: 0,
        attempts: attempt,
        error: `GitHub API ${response.status}: ${body}`,
      };
    }

    let data;
    try {
      data = await response.json();
    } catch (err) {
      lastError = `invalid JSON: ${err instanceof Error ? err.message : String(err)}`;
      if (attempt < retryAttempts) {
        await sleep(retryIntervalMs);
        continue;
      }
      break;
    }

    const runs = Array.isArray(data.check_runs) ? data.check_runs : [];
    const matches = runs.filter(
      run => typeof run === "object" && run.name === checkName,
    );

    if (matches.length === 0) {
      lastError = "no matching check run";
      if (attempt < retryAttempts) {
        await sleep(retryIntervalMs);
        continue;
      }
      break;
    }

    const latest = latestRun(matches);

    if (latest.status === "completed") {
      const ok = latest.conclusion === "success";
      return {
        ok,
        owner,
        repo,
        sha: sha.toLowerCase(),
        check_name: checkName,
        status: latest.status,
        conclusion: latest.conclusion ?? null,
        total_check_runs: runs.length,
        matching_check_runs: matches.length,
        attempts: attempt,
        latest_run_id: latest.id ?? null,
      };
    }

    // Queued or in-progress — wait for completion.
    lastError = `latest run is ${latest.status}`;
    if (attempt < retryAttempts) {
      await sleep(retryIntervalMs);
      continue;
    }
    break;
  }

  return {
    ok: false,
    owner,
    repo,
    sha: sha.toLowerCase(),
    check_name: checkName,
    status: lastResponseStatus ? String(lastResponseStatus) : "not_found",
    conclusion: null,
    total_check_runs: 0,
    matching_check_runs: 0,
    attempts: retryAttempts,
    error: lastError ?? "required CI did not complete successfully",
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function latestRun(runs) {
  function activityTs(run) {
    const completed = run.completed_at ? Date.parse(run.completed_at) : null;
    const started = run.started_at ? Date.parse(run.started_at) : null;
    if (completed !== null && started !== null)
      return Math.max(completed, started);
    if (completed !== null) return completed;
    if (started !== null) return started;
    return Number(run.id ?? 0);
  }

  return [...runs].sort((a, b) => activityTs(b) - activityTs(a))[0];
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
