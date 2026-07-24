import { describe, it, expect, vi, beforeEach } from "vitest";
import { run } from "../../helpers/cli.js";

vi.mock("node:child_process", async (importOriginal) => {
  const mod = await importOriginal<typeof import("node:child_process")>();
  return { ...mod, spawnSync: vi.fn() };
});

import { spawnSync } from "node:child_process";

describe("cli run() helper", () => {
  beforeEach(() => {
    vi.mocked(spawnSync).mockReset();
  });

  it("returns TEST_SUBPROCESS_TIMEOUT when spawnSync times out", () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: null,
      signal: "SIGKILL",
      stdout: "",
      stderr: "",
      pid: 123,
      output: [null, "", ""],
      error: Object.assign(new Error("spawnSync ETIMEDOUT"), {
        code: "ETIMEDOUT",
      }),
    } as unknown as ReturnType<typeof spawnSync>);

    const result = run("/tmp/test-project", ["plan", "status"], {
      timeoutMs: 30_000,
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("TEST_SUBPROCESS_TIMEOUT");
    expect(result.stderr).toContain("timeout_ms=30000");
    expect(result.stderr).toContain("node dist/cli.js plan status");
    expect(vi.mocked(spawnSync)).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(["plan", "status"]),
      expect.objectContaining({
        timeout: 30_000,
        killSignal: "SIGKILL",
        maxBuffer: 10 * 1024 * 1024,
      }),
    );
  });
});
