import { describe, it, expect, vi } from "vitest";
// @ts-expect-error .mjs scripts are not included in tsconfig and are imported as untyped modules across the test suite.
import { verifyPublishedProvenance } from "../../../scripts/verify-published-provenance.mjs";

type FetchResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

type FetchImpl = (url: string) => Promise<FetchResponse>;

function makeResponse(body: unknown): FetchResponse {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue(body),
  };
}

function makeFetch(
  responses: Array<FetchResponse | Error>,
): FetchImpl & { calls: () => number } {
  let calls = 0;
  const fn = vi.fn(async () => {
    const r = responses[calls] ?? responses[responses.length - 1];
    calls += 1;
    if (r instanceof Error) throw r;
    return r;
  }) as unknown as FetchImpl & { calls: () => number };
  fn.calls = () => calls;
  return fn;
}

const TARGET = "https://registry.npmjs.org/code-pact/2.0.1";

describe("verifyPublishedProvenance", () => {
  it("succeeds when dist.attestations.provenance is true", async () => {
    const fetchImpl = makeFetch([
      makeResponse({
        dist: {
          attestations: {
            provenance: true,
            url: "https://registry.npmjs.org/-/attestations/code-pact/2.0.1",
          },
        },
      }),
    ]) as unknown as typeof globalThis.fetch;

    const result = await verifyPublishedProvenance({
      packageName: "code-pact",
      version: "2.0.1",
      fetchImpl,
      intervalMs: 10,
    });

    expect(result.ok).toBe(true);
    expect(result.code).toBe("PROVENANCE_FOUND");
    expect(result.url).toBe(
      "https://registry.npmjs.org/-/attestations/code-pact/2.0.1",
    );
    expect((fetchImpl as unknown as { calls: () => number }).calls()).toBe(1);
    expect(
      (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock
        .calls[0]![0],
    ).toBe(TARGET);
  });

  it("fails when dist.attestations is missing", async () => {
    const fetchImpl = makeFetch([
      makeResponse({ dist: {} }),
    ]) as unknown as typeof globalThis.fetch;

    const result = await verifyPublishedProvenance({
      packageName: "code-pact",
      version: "2.0.1",
      fetchImpl,
      intervalMs: 10,
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("PROVENANCE_MISSING");
  });

  it("fails when dist.attestations.provenance is not true", async () => {
    const fetchImpl = makeFetch([
      makeResponse({ dist: { attestations: { provenance: false } } }),
    ]) as unknown as typeof globalThis.fetch;

    const result = await verifyPublishedProvenance({
      packageName: "code-pact",
      version: "2.0.1",
      fetchImpl,
      intervalMs: 10,
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("PROVENANCE_MISSING");
  });

  it("retries on 404 and succeeds when the version appears", async () => {
    const fetchImpl = makeFetch([
      { ok: false, status: 404, json: vi.fn().mockResolvedValue({}) },
      makeResponse({
        dist: {
          attestations: { provenance: true, url: "https://example.com/a" },
        },
      }),
    ]) as unknown as typeof globalThis.fetch;

    const result = await verifyPublishedProvenance({
      packageName: "code-pact",
      version: "2.0.1",
      fetchImpl,
      intervalMs: 10,
    });

    expect(result.ok).toBe(true);
    expect((fetchImpl as unknown as { calls: () => number }).calls()).toBe(2);
  });

  it("fails when 404 persists through all retries", async () => {
    const fetchImpl = makeFetch([
      { ok: false, status: 404, json: vi.fn().mockResolvedValue({}) },
    ]) as unknown as typeof globalThis.fetch;

    const result = await verifyPublishedProvenance({
      packageName: "code-pact",
      version: "2.0.1",
      fetchImpl,
      retries: 2,
      intervalMs: 10,
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("VERSION_NOT_FOUND");
    expect((fetchImpl as unknown as { calls: () => number }).calls()).toBe(2);
  });

  it("fails immediately on non-404 registry errors", async () => {
    const fetchImpl = makeFetch([
      { ok: false, status: 500, json: vi.fn().mockResolvedValue({}) },
    ]) as unknown as typeof globalThis.fetch;

    const result = await verifyPublishedProvenance({
      packageName: "code-pact",
      version: "2.0.1",
      fetchImpl,
      intervalMs: 10,
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("REGISTRY_ERROR");
    expect((fetchImpl as unknown as { calls: () => number }).calls()).toBe(1);
  });

  it("retries on network errors and fails when retries are exhausted", async () => {
    const fetchImpl = makeFetch([
      new Error("ECONNREFUSED"),
    ]) as unknown as typeof globalThis.fetch;

    const result = await verifyPublishedProvenance({
      packageName: "code-pact",
      version: "2.0.1",
      fetchImpl,
      retries: 2,
      intervalMs: 10,
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("REGISTRY_FETCH_FAILED");
    expect((fetchImpl as unknown as { calls: () => number }).calls()).toBe(2);
  });

  it("does not treat network errors as success", async () => {
    const fetchImpl = makeFetch([
      new Error("ETIMEDOUT"),
    ]) as unknown as typeof globalThis.fetch;

    const result = await verifyPublishedProvenance({
      packageName: "code-pact",
      version: "2.0.1",
      fetchImpl,
      retries: 1,
      intervalMs: 10,
    });

    expect(result.ok).toBe(false);
  });
});
