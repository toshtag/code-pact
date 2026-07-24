import { describe, it, expect, vi } from "vitest";
// @ts-expect-error .mjs scripts are not included in tsconfig and are imported as untyped modules across the test suite.
import { checkNpmVersionAvailability } from "../../../scripts/check-npm-version-availability.mjs";

describe("checkNpmVersionAvailability", () => {
  it("returns exists when the registry responds 200", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ status: 200 });
    const result = await checkNpmVersionAvailability("code-pact", "2.0.1", {
      fetchImpl,
    });
    expect(result.state).toBe("exists");
    expect(result.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://registry.npmjs.org/code-pact/2.0.1",
      {
        headers: { accept: "application/json" },
        signal: expect.any(AbortSignal),
      },
    );
  });

  it("returns absent when the registry responds 404", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ status: 404 });
    const result = await checkNpmVersionAvailability("code-pact", "2.0.1", {
      fetchImpl,
    });
    expect(result.state).toBe("absent");
    expect(result.status).toBe(404);
  });

  it("returns error on an unexpected registry status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ status: 503 });
    const result = await checkNpmVersionAvailability("code-pact", "2.0.1", {
      fetchImpl,
    });
    expect(result.state).toBe("error");
    expect(result.status).toBe(503);
  });

  it("returns error on network failure", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await checkNpmVersionAvailability("code-pact", "2.0.1", {
      fetchImpl,
    });
    expect(result.state).toBe("error");
    expect(result.message).toContain("ECONNREFUSED");
  });

  it("trims a trailing slash from a custom registry", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ status: 200 });
    await checkNpmVersionAvailability("code-pact", "2.0.1", {
      registry: "https://registry.npmjs.org/",
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://registry.npmjs.org/code-pact/2.0.1",
      {
        headers: { accept: "application/json" },
        signal: expect.any(AbortSignal),
      },
    );
  });

  it("encodes package and version components", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ status: 404 });
    await checkNpmVersionAvailability("@scope/pkg", "1.0.0-beta.1", {
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://registry.npmjs.org/@scope%2Fpkg/1.0.0-beta.1",
      {
        headers: { accept: "application/json" },
        signal: expect.any(AbortSignal),
      },
    );
  });

  it("returns REGISTRY_TIMEOUT when the request signal aborts", async () => {
    const fetchImpl = vi.fn((_url, init) => {
      const signal = init.signal as AbortSignal | undefined;
      return new Promise((_resolve, reject) => {
        const abort = () => {
          reject(new DOMException("The operation was aborted", "TimeoutError"));
        };
        if (signal?.aborted) {
          abort();
          return;
        }
        signal?.addEventListener("abort", abort, { once: true });
      });
    });
    const result = await checkNpmVersionAvailability("code-pact", "2.0.1", {
      fetchImpl,
      requestTimeoutMs: 10,
    });
    expect(result.state).toBe("error");
    expect(result.code).toBe("REGISTRY_TIMEOUT");
    expect(result.message).toContain("timed out after 10ms");
  });
});
