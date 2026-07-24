import { describe, it, expect, vi } from "vitest";
// @ts-expect-error .mjs scripts are not included in tsconfig and are imported as untyped modules across the test suite.
import { verifyPublishedProvenance } from "../../../scripts/verify-published-provenance.mjs";

type FetchResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

type FetchImpl = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<FetchResponse>;

type ExecResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode?: number;
};
type ExecImpl = (cwd: string, args: string[]) => Promise<ExecResult>;

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

function makeProvenanceManifest(provenance: unknown) {
  return {
    name: "code-pact",
    version: "2.0.1",
    dist: { attestations: { provenance } },
  };
}

function makeExec(auditResult: ExecResult): ExecImpl {
  return vi.fn(async (_cwd: string, args: string[]) => {
    if (args[0] === "install") {
      return { ok: true, stdout: "", stderr: "" };
    }
    if (args[0] === "audit") {
      return auditResult;
    }
    return {
      ok: false,
      stdout: "",
      stderr: `unexpected npm args: ${args.join(" ")}`,
    };
  }) as unknown as ExecImpl;
}

const TARGET = "https://registry.npmjs.org/code-pact/2.0.1";

describe("verifyPublishedProvenance", () => {
  it("succeeds when manifest advertises provenance and audit exits 0", async () => {
    const fetchImpl = makeFetch([
      makeResponse(makeProvenanceManifest(true)),
    ]) as unknown as typeof globalThis.fetch;
    const execImpl = makeExec({ ok: true, stdout: "{}", stderr: "" });

    const result = await verifyPublishedProvenance({
      packageName: "code-pact",
      version: "2.0.1",
      fetchImpl,
      execImpl,
      intervalMs: 10,
    });

    expect(result.ok).toBe(true);
    expect(result.code).toBe("PROVENANCE_VERIFIED");
    expect(result.url).toBe(
      "https://registry.npmjs.org/-/attestations/code-pact/2.0.1",
    );
    expect((fetchImpl as unknown as { calls: () => number }).calls()).toBe(1);
    expect(
      (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock
        .calls[0]![0],
    ).toBe(TARGET);
  });

  it("succeeds when provenance is a URL and audit exits 0", async () => {
    const fetchImpl = makeFetch([
      makeResponse(
        makeProvenanceManifest(
          "https://registry.npmjs.org/-/npm/v1/attestations/code-pact@2.0.1",
        ),
      ),
    ]) as unknown as typeof globalThis.fetch;
    const execImpl = makeExec({ ok: true, stdout: "{}", stderr: "" });

    const result = await verifyPublishedProvenance({
      packageName: "code-pact",
      version: "2.0.1",
      fetchImpl,
      execImpl,
      intervalMs: 10,
    });

    expect(result.ok).toBe(true);
    expect(result.code).toBe("PROVENANCE_VERIFIED");
    expect(result.url).toBe(
      "https://registry.npmjs.org/-/npm/v1/attestations/code-pact@2.0.1",
    );
  });

  it("fails when manifest has no provenance metadata", async () => {
    const fetchImpl = makeFetch([
      makeResponse({ name: "code-pact", version: "2.0.1", dist: {} }),
    ]);

    const result = await verifyPublishedProvenance({
      packageName: "code-pact",
      version: "2.0.1",
      fetchImpl,
      execImpl: makeExec({ ok: true, stdout: "", stderr: "" }),
      intervalMs: 10,
      retries: 2,
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("PROVENANCE_MISSING");
  });

  it("fails when audit exits non-zero", async () => {
    const fetchImpl = makeFetch([
      makeResponse(makeProvenanceManifest(true)),
    ]) as unknown as typeof globalThis.fetch;
    const execImpl = makeExec({
      ok: false,
      stdout: "",
      stderr: "npm audit signatures failed",
      exitCode: 1,
    });

    const result = await verifyPublishedProvenance({
      packageName: "code-pact",
      version: "2.0.1",
      fetchImpl,
      execImpl,
      intervalMs: 10,
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("PROVENANCE_AUDIT_FAILED");
  });

  it("fails when npm install fails", async () => {
    const fetchImpl = makeFetch([
      makeResponse(makeProvenanceManifest(true)),
    ]) as unknown as typeof globalThis.fetch;
    const execImpl = vi.fn(async () => ({
      ok: false,
      stdout: "",
      stderr: "npm ERR! install failed",
      exitCode: 1,
    })) as unknown as ExecImpl;

    const result = await verifyPublishedProvenance({
      packageName: "code-pact",
      version: "2.0.1",
      fetchImpl,
      execImpl,
      intervalMs: 10,
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("NPM_INSTALL_FAILED");
  });

  it("retries on 404 and succeeds when version appears", async () => {
    const fetchImpl = makeFetch([
      { ok: false, status: 404, json: vi.fn().mockResolvedValue({}) },
      makeResponse(makeProvenanceManifest(true)),
    ]) as unknown as typeof globalThis.fetch;

    const result = await verifyPublishedProvenance({
      packageName: "code-pact",
      version: "2.0.1",
      fetchImpl,
      execImpl: makeExec({ ok: true, stdout: "{}", stderr: "" }),
      intervalMs: 10,
    });

    expect(result.ok).toBe(true);
    expect((fetchImpl as unknown as { calls: () => number }).calls()).toBe(2);
  });

  it("retries on missing provenance and succeeds", async () => {
    const fetchImpl = makeFetch([
      makeResponse({ name: "code-pact", version: "2.0.1", dist: {} }),
      makeResponse(makeProvenanceManifest(true)),
    ]) as unknown as typeof globalThis.fetch;

    const result = await verifyPublishedProvenance({
      packageName: "code-pact",
      version: "2.0.1",
      fetchImpl,
      execImpl: makeExec({ ok: true, stdout: "{}", stderr: "" }),
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
      execImpl: makeExec({ ok: true, stdout: "", stderr: "" }),
      retries: 2,
      intervalMs: 10,
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("VERSION_NOT_FOUND");
    expect((fetchImpl as unknown as { calls: () => number }).calls()).toBe(2);
  });

  it("fails immediately on non-retryable 403", async () => {
    const fetchImpl = makeFetch([
      { ok: false, status: 403, json: vi.fn().mockResolvedValue({}) },
    ]) as unknown as typeof globalThis.fetch;

    const result = await verifyPublishedProvenance({
      packageName: "code-pact",
      version: "2.0.1",
      fetchImpl,
      execImpl: makeExec({ ok: true, stdout: "", stderr: "" }),
      intervalMs: 10,
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("REGISTRY_AUTH_ERROR");
    expect((fetchImpl as unknown as { calls: () => number }).calls()).toBe(1);
  });

  it("fails immediately on package/version mismatch", async () => {
    const fetchImpl = makeFetch([
      makeResponse({
        name: "wrong-pkg",
        version: "9.9.9",
        dist: { attestations: { provenance: true } },
      }),
    ]) as unknown as typeof globalThis.fetch;

    const result = await verifyPublishedProvenance({
      packageName: "code-pact",
      version: "2.0.1",
      fetchImpl,
      execImpl: makeExec({ ok: true, stdout: "", stderr: "" }),
      intervalMs: 10,
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("REGISTRY_PACKAGE_MISMATCH");
  });

  it("retries on network errors and fails when retries are exhausted", async () => {
    const fetchImpl = makeFetch([
      new Error("ECONNREFUSED"),
    ]) as unknown as typeof globalThis.fetch;

    const result = await verifyPublishedProvenance({
      packageName: "code-pact",
      version: "2.0.1",
      fetchImpl,
      execImpl: makeExec({ ok: true, stdout: "", stderr: "" }),
      retries: 2,
      intervalMs: 10,
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("REGISTRY_FETCH_FAILED");
    expect((fetchImpl as unknown as { calls: () => number }).calls()).toBe(2);
  });

  it("passes explicit --registry to npm commands", async () => {
    const fetchImpl = makeFetch([
      makeResponse(makeProvenanceManifest(true)),
    ]) as unknown as typeof globalThis.fetch;
    const execImpl = vi.fn(async (_cwd: string, args: string[]) => {
      if (args[0] === "install") {
        expect(args).toContain("--registry=https://registry.example.com");
        return { ok: true, stdout: "", stderr: "" };
      }
      if (args[0] === "audit") {
        expect(args).toContain("--registry=https://registry.example.com");
        return { ok: true, stdout: "{}", stderr: "" };
      }
      return { ok: false, stdout: "", stderr: "unexpected" };
    }) as unknown as ExecImpl;

    const result = await verifyPublishedProvenance({
      packageName: "code-pact",
      version: "2.0.1",
      registry: "https://registry.example.com",
      fetchImpl,
      execImpl,
      intervalMs: 10,
    });

    expect(result.ok).toBe(true);
    expect(execImpl).toHaveBeenCalledTimes(2);
  });
});
