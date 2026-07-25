import { describe, it, expect, vi } from "vitest";
import { checkRequiredCiForSha } from "../../../scripts/check-required-ci-for-sha.mjs";

const sha = "9de33b4f0572319baadb78d9feef68d788b8a50a";

function makeResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
  };
}

function completedRun(
  id: number,
  name: string,
  conclusion: string,
  offsetSeconds: number,
  appSlug = "github-actions",
) {
  const started = new Date(Date.now() + offsetSeconds * 1000).toISOString();
  const completed = new Date(
    Date.now() + (offsetSeconds + 1) * 1000,
  ).toISOString();
  return {
    id,
    name,
    status: "completed",
    conclusion,
    started_at: started,
    completed_at: completed,
    app: { slug: appSlug },
  };
}

function inProgressRun(id: number, name: string, offsetSeconds: number) {
  return {
    id,
    name,
    status: "in_progress",
    conclusion: null,
    started_at: new Date(Date.now() + offsetSeconds * 1000).toISOString(),
    completed_at: null,
    app: { slug: "github-actions" },
  };
}

function queuedRun(id: number, name: string, offsetSeconds: number) {
  return {
    id,
    name,
    status: "queued",
    conclusion: null,
    started_at: new Date(Date.now() + offsetSeconds * 1000).toISOString(),
    completed_at: null,
    app: { slug: "github-actions" },
  };
}

describe("checkRequiredCiForSha", () => {
  it("passes when the latest matching check run completed successfully", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      makeResponse(200, {
        check_runs: [completedRun(1, "CI status", "success", 0)],
      }),
    );

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
  });

  it("fails when the latest matching check run completed with a failure", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      makeResponse(200, {
        check_runs: [completedRun(1, "CI status", "failure", 0)],
      }),
    );

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
    const fetchImpl = vi.fn().mockResolvedValue(
      makeResponse(200, {
        check_runs: [
          completedRun(1, "CI status", "success", -10),
          completedRun(2, "CI status", "failure", 0),
        ],
      }),
    );

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

  it("retries and passes when the check transitions to success", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        makeResponse(200, {
          check_runs: [inProgressRun(1, "CI status", 0)],
        }),
      )
      .mockResolvedValueOnce(
        makeResponse(200, {
          check_runs: [completedRun(1, "CI status", "success", 0)],
        }),
      );

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
    const fetchImpl = vi.fn().mockResolvedValue(
      makeResponse(200, {
        check_runs: [
          completedRun(1, "CI status", "success", -10),
          inProgressRun(2, "CI status", 0),
        ],
      }),
    );

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
    const olderCompleted = {
      id: 1,
      name: "CI status",
      status: "completed",
      conclusion: "success",
      started_at: new Date(Date.now() - 100_000).toISOString(),
      completed_at: new Date(Date.now() + 100_000).toISOString(),
    };

    const fetchImpl = vi.fn().mockResolvedValue(
      makeResponse(200, {
        check_runs: [olderCompleted, inProgressRun(2, "CI status", 0)],
      }),
    );

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

  it("retries when no matching check run exists", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      makeResponse(200, {
        check_runs: [completedRun(1, "Other check", "success", 0)],
      }),
    );

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
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries on 429 and fails after exhaustion", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(makeResponse(429, "rate limit"));

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
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries on 500 and fails after exhaustion", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(makeResponse(500, "server error"));

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
  });

  it("retries on network errors and fails after exhaustion", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network timeout"));

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

  it("fails immediately on 401", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(makeResponse(401, "unauthorized"));

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
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse(403, "forbidden"));

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

  it("retries on queued status and fails after exhaustion", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      makeResponse(200, {
        check_runs: [queuedRun(1, "CI status", 0)],
      }),
    );

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

  it("rejects a same-name check from a non-github-actions app", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      makeResponse(200, {
        check_runs: [
          completedRun(1, "CI status", "success", 0, "some-other-app"),
        ],
      }),
    );

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
    expect(result.error).toContain("github-actions");
  });
});
