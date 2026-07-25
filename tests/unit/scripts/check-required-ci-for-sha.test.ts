import { describe, it, expect, vi } from "vitest";
import { checkRequiredCiForSha } from "../../../scripts/check-required-ci-for-sha.mjs";

const sha = "9de33b4f0572319baadb78d9feef68d788b8a50a";
const otherSha = "9de33b4f0572319baadb78d9feef68d788b8a50b";

function makeResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
    json: () => Promise.resolve(body),
  };
}

function workflowRun(options: {
  id: number;
  run_number?: number;
  status: string;
  conclusion?: string | null;
  head_sha?: string;
  head_branch?: string;
  event?: string;
  path?: string;
  created_at?: string;
}) {
  return {
    id: options.id,
    run_number: options.run_number ?? options.id,
    status: options.status,
    conclusion: options.conclusion ?? null,
    head_sha: options.head_sha ?? sha,
    head_branch: options.head_branch ?? "main",
    event: options.event ?? "push",
    path: options.path ?? ".github/workflows/ci.yml",
    created_at: options.created_at ?? new Date().toISOString(),
    name: "CI",
  };
}

function completedRun(
  id: number,
  offsetSeconds: number,
  conclusion = "success",
) {
  const created = new Date(Date.now() + offsetSeconds * 1000).toISOString();
  return workflowRun({
    id,
    run_number: id,
    status: "completed",
    conclusion,
    created_at: created,
  });
}

function inProgressRun(id: number, offsetSeconds: number) {
  const created = new Date(Date.now() + offsetSeconds * 1000).toISOString();
  return workflowRun({
    id,
    run_number: id,
    status: "in_progress",
    conclusion: null,
    created_at: created,
  });
}

function queuedRun(id: number, offsetSeconds: number) {
  const created = new Date(Date.now() + offsetSeconds * 1000).toISOString();
  return workflowRun({
    id,
    run_number: id,
    status: "queued",
    conclusion: null,
    created_at: created,
  });
}

function makeJobsResponse(
  name: string,
  status: string,
  conclusion: string | null,
) {
  return {
    total_count: 1,
    jobs: [
      {
        id: 100,
        run_id: 1,
        name,
        status,
        conclusion,
        created_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
      },
    ],
  };
}

interface ListResponse {
  status: number;
  body: unknown;
  reject?: string;
}

function makeFetchImpl({
  listResponses,
  jobResponse,
}: {
  listResponses: ListResponse[];
  jobResponse?: { status: number; body: unknown; reject?: string };
}) {
  let listCall = 0;
  return vi.fn().mockImplementation(async (url: string) => {
    if (url.includes("/jobs?filter=latest")) {
      if (!jobResponse) {
        return makeResponse(404, { message: "not found" });
      }
      if (jobResponse.reject) {
        return Promise.reject(new Error(jobResponse.reject));
      }
      return makeResponse(jobResponse.status, jobResponse.body);
    }

    const response = listResponses[listCall] ?? {
      status: 200,
      body: { workflow_runs: [] },
    };
    listCall += 1;
    if (response.reject) {
      return Promise.reject(new Error(response.reject));
    }
    return makeResponse(response.status, response.body);
  });
}

describe("checkRequiredCiForSha", () => {
  it("passes when the latest matching workflow run and named job completed successfully", async () => {
    const fetchImpl = makeFetchImpl({
      listResponses: [
        { status: 200, body: { workflow_runs: [completedRun(1, 0)] } },
      ],
      jobResponse: {
        status: 200,
        body: makeJobsResponse("CI status", "completed", "success"),
      },
    });

    const result = await checkRequiredCiForSha({
      owner: "toshtag",
      repo: "code-pact",
      sha,
      checkName: "CI status",
      retryAttempts: 1,
      retryIntervalMs: 10,
      fetchImpl,
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("completed");
    expect(result.conclusion).toBe("success");
    expect(result.attempts).toBe(1);
    expect(result.matching_check_runs).toBe(1);
  });

  it("fails when the latest matching workflow run completed with a failure", async () => {
    const fetchImpl = makeFetchImpl({
      listResponses: [
        { status: 200, body: { workflow_runs: [completedRun(1, 0, "failure")] } },
      ],
    });

    const result = await checkRequiredCiForSha({
      owner: "toshtag",
      repo: "code-pact",
      sha,
      checkName: "CI status",
      retryAttempts: 1,
      retryIntervalMs: 10,
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("completed");
    expect(result.conclusion).toBe("failure");
  });

  it("fails when an older success is superseded by a newer failure", async () => {
    const fetchImpl = makeFetchImpl({
      listResponses: [
        {
          status: 200,
          body: {
            workflow_runs: [
              completedRun(1, -10, "success"),
              completedRun(2, 0, "failure"),
            ],
          },
        },
      ],
    });

    const result = await checkRequiredCiForSha({
      owner: "toshtag",
      repo: "code-pact",
      sha,
      checkName: "CI status",
      retryAttempts: 1,
      retryIntervalMs: 10,
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    expect(result.conclusion).toBe("failure");
    expect(result.matching_check_runs).toBe(2);
  });

  it("retries and passes when the workflow run transitions to success", async () => {
    const fetchImpl = makeFetchImpl({
      listResponses: [
        { status: 200, body: { workflow_runs: [inProgressRun(1, 0)] } },
        { status: 200, body: { workflow_runs: [completedRun(1, 0)] } },
      ],
      jobResponse: {
        status: 200,
        body: makeJobsResponse("CI status", "completed", "success"),
      },
    });

    const result = await checkRequiredCiForSha({
      owner: "toshtag",
      repo: "code-pact",
      sha,
      checkName: "CI status",
      retryAttempts: 2,
      retryIntervalMs: 10,
      fetchImpl,
    });

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
  });

  it("fails after retry exhaustion while the latest run is still in_progress", async () => {
    const fetchImpl = makeFetchImpl({
      listResponses: [
        {
          status: 200,
          body: {
            workflow_runs: [
              completedRun(1, -10, "success"),
              inProgressRun(2, 0),
            ],
          },
        },
      ],
    });

    const result = await checkRequiredCiForSha({
      owner: "toshtag",
      repo: "code-pact",
      sha,
      checkName: "CI status",
      retryAttempts: 3,
      retryIntervalMs: 10,
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(3);
  });

  it("prefers a newer in-progress run over an older completed run even when completed_at is later", async () => {
    const olderCompleted = workflowRun({
      id: 1,
      run_number: 1,
      status: "completed",
      conclusion: "success",
      created_at: new Date(Date.now() - 100_000).toISOString(),
    });

    const fetchImpl = makeFetchImpl({
      listResponses: [
        {
          status: 200,
          body: {
            workflow_runs: [olderCompleted, inProgressRun(2, 0)],
          },
        },
      ],
    });

    const result = await checkRequiredCiForSha({
      owner: "toshtag",
      repo: "code-pact",
      sha,
      checkName: "CI status",
      retryAttempts: 2,
      retryIntervalMs: 10,
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(2);
  });

  it("retries when no matching workflow run exists and then passes", async () => {
    const fetchImpl = makeFetchImpl({
      listResponses: [
        { status: 200, body: { workflow_runs: [] } },
        { status: 200, body: { workflow_runs: [completedRun(1, 0)] } },
      ],
      jobResponse: {
        status: 200,
        body: makeJobsResponse("CI status", "completed", "success"),
      },
    });

    const result = await checkRequiredCiForSha({
      owner: "toshtag",
      repo: "code-pact",
      sha,
      checkName: "CI status",
      retryAttempts: 2,
      retryIntervalMs: 10,
      fetchImpl,
    });

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("fails when a pull_request run exists but no push run", async () => {
    const fetchImpl = makeFetchImpl({
      listResponses: [
        {
          status: 200,
          body: {
            workflow_runs: [
              workflowRun({
                id: 1,
                status: "completed",
                conclusion: "success",
                event: "pull_request",
                head_branch: "main",
              }),
            ],
          },
        },
      ],
    });

    const result = await checkRequiredCiForSha({
      owner: "toshtag",
      repo: "code-pact",
      sha,
      checkName: "CI status",
      retryAttempts: 1,
      retryIntervalMs: 10,
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    expect(result.matching_check_runs).toBe(0);
  });

  it("fails when the run is on a branch other than main", async () => {
    const fetchImpl = makeFetchImpl({
      listResponses: [
        {
          status: 200,
          body: {
            workflow_runs: [
              workflowRun({
                id: 1,
                status: "completed",
                conclusion: "success",
                head_branch: "feature",
              }),
            ],
          },
        },
      ],
    });

    const result = await checkRequiredCiForSha({
      owner: "toshtag",
      repo: "code-pact",
      sha,
      checkName: "CI status",
      retryAttempts: 1,
      retryIntervalMs: 10,
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    expect(result.matching_check_runs).toBe(0);
  });

  it("fails when the run has a different head SHA", async () => {
    const fetchImpl = makeFetchImpl({
      listResponses: [
        {
          status: 200,
          body: {
            workflow_runs: [
              workflowRun({
                id: 1,
                status: "completed",
                conclusion: "success",
                head_sha: otherSha,
              }),
            ],
          },
        },
      ],
    });

    const result = await checkRequiredCiForSha({
      owner: "toshtag",
      repo: "code-pact",
      sha,
      checkName: "CI status",
      retryAttempts: 1,
      retryIntervalMs: 10,
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    expect(result.matching_check_runs).toBe(0);
  });

  it("fails when the run belongs to a different workflow path", async () => {
    const fetchImpl = makeFetchImpl({
      listResponses: [
        {
          status: 200,
          body: {
            workflow_runs: [
              workflowRun({
                id: 1,
                status: "completed",
                conclusion: "success",
                path: ".github/workflows/other.yml",
              }),
            ],
          },
        },
      ],
    });

    const result = await checkRequiredCiForSha({
      owner: "toshtag",
      repo: "code-pact",
      sha,
      checkName: "CI status",
      retryAttempts: 1,
      retryIntervalMs: 10,
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    expect(result.matching_check_runs).toBe(0);
  });

  it("fails when the named job is missing from the successful run", async () => {
    const fetchImpl = makeFetchImpl({
      listResponses: [
        { status: 200, body: { workflow_runs: [completedRun(1, 0)] } },
      ],
      jobResponse: {
        status: 200,
        body: { total_count: 0, jobs: [] },
      },
    });

    const result = await checkRequiredCiForSha({
      owner: "toshtag",
      repo: "code-pact",
      sha,
      checkName: "CI status",
      retryAttempts: 1,
      retryIntervalMs: 10,
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("does not contain job");
  });

  it("fails when the named job completed with a non-success conclusion", async () => {
    const fetchImpl = makeFetchImpl({
      listResponses: [
        { status: 200, body: { workflow_runs: [completedRun(1, 0)] } },
      ],
      jobResponse: {
        status: 200,
        body: makeJobsResponse("CI status", "completed", "failure"),
      },
    });

    const result = await checkRequiredCiForSha({
      owner: "toshtag",
      repo: "code-pact",
      sha,
      checkName: "CI status",
      retryAttempts: 1,
      retryIntervalMs: 10,
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    expect(result.conclusion).toBe("failure");
  });

  it("fails immediately on 401", async () => {
    const fetchImpl = makeFetchImpl({
      listResponses: [{ status: 401, body: "unauthorized" }],
    });

    const result = await checkRequiredCiForSha({
      owner: "toshtag",
      repo: "code-pact",
      sha,
      checkName: "CI status",
      retryAttempts: 5,
      retryIntervalMs: 10,
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(1);
    expect(result.error).toContain("401");
  });

  it("fails immediately on 403", async () => {
    const fetchImpl = makeFetchImpl({
      listResponses: [{ status: 403, body: "forbidden" }],
    });

    const result = await checkRequiredCiForSha({
      owner: "toshtag",
      repo: "code-pact",
      sha,
      checkName: "CI status",
      retryAttempts: 5,
      retryIntervalMs: 10,
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(1);
  });

  it("retries on 429 and fails after exhaustion", async () => {
    const fetchImpl = makeFetchImpl({
      listResponses: [
        { status: 429, body: "rate limit" },
        { status: 429, body: "rate limit" },
      ],
    });

    const result = await checkRequiredCiForSha({
      owner: "toshtag",
      repo: "code-pact",
      sha,
      checkName: "CI status",
      retryAttempts: 2,
      retryIntervalMs: 10,
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("429");
    expect(result.attempts).toBe(2);
  });

  it("retries on 500 and fails after exhaustion", async () => {
    const fetchImpl = makeFetchImpl({
      listResponses: [
        { status: 500, body: "server error" },
        { status: 500, body: "server error" },
      ],
    });

    const result = await checkRequiredCiForSha({
      owner: "toshtag",
      repo: "code-pact",
      sha,
      checkName: "CI status",
      retryAttempts: 2,
      retryIntervalMs: 10,
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("500");
    expect(result.attempts).toBe(2);
  });

  it("retries on network errors and fails after exhaustion", async () => {
    const fetchImpl = makeFetchImpl({
      listResponses: [
        { status: 200, body: {}, reject: "network timeout" },
        { status: 200, body: {}, reject: "network timeout" },
      ],
    });

    const result = await checkRequiredCiForSha({
      owner: "toshtag",
      repo: "code-pact",
      sha,
      checkName: "CI status",
      retryAttempts: 2,
      retryIntervalMs: 10,
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("network timeout");
  });

  it("retries on queued status and fails after exhaustion", async () => {
    const fetchImpl = makeFetchImpl({
      listResponses: [
        { status: 200, body: { workflow_runs: [queuedRun(1, 0)] } },
      ],
    });

    const result = await checkRequiredCiForSha({
      owner: "toshtag",
      repo: "code-pact",
      sha,
      checkName: "CI status",
      retryAttempts: 2,
      retryIntervalMs: 10,
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("not_found");
  });
});
