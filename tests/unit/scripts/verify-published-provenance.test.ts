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
  init?: { headers?: Record<string, string> },
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

function makeVerifiedAudit(predicateType: string): unknown {
  return {
    invalid: [],
    missing: [],
    verified: [
      {
        name: "code-pact",
        version: "2.0.1",
        location: "node_modules/code-pact",
        registry: "https://registry.npmjs.org/",
        attestations: {
          url: "https://registry.npmjs.org/-/npm/v1/attestations/code-pact@2.0.1",
          provenance: { predicateType },
        },
        attestationBundles: [
          {
            predicateType,
            bundle: {
              mediaType: "application/vnd.dev.sigstore.bundle+json;version=0.2",
            },
          },
        ],
      },
    ],
  };
}

function makeExec(auditPayload: unknown): ExecImpl {
  return vi.fn(async (_cwd: string, args: string[]) => {
    if (args[0] === "install") {
      return { ok: true, stdout: "", stderr: "" };
    }
    if (args[0] === "audit") {
      return { ok: true, stdout: JSON.stringify(auditPayload), stderr: "" };
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
  it("succeeds when dist.attestations.provenance is true and audit verifies SLSA v1", async () => {
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
    const execImpl = makeExec(
      makeVerifiedAudit("https://slsa.dev/provenance/v1"),
    );

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

  it("succeeds when dist.attestations.provenance is a URL and audit verifies SLSA v0.2", async () => {
    const fetchImpl = makeFetch([
      makeResponse({
        dist: {
          attestations: {
            provenance:
              "https://registry.npmjs.org/-/npm/v1/attestations/code-pact@2.0.1",
          },
        },
      }),
    ]) as unknown as typeof globalThis.fetch;
    const execImpl = makeExec(
      makeVerifiedAudit("https://slsa.dev/provenance/v0.2"),
    );

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

  it("fails when dist.attestations is missing", async () => {
    const fetchImpl = makeFetch([makeResponse({ dist: {} })]);

    const result = await verifyPublishedProvenance({
      packageName: "code-pact",
      version: "2.0.1",
      fetchImpl,
      execImpl: makeExec({}),
      intervalMs: 10,
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("PROVENANCE_MISSING");
  });

  it("fails when dist.attestations.provenance is falsy", async () => {
    const fetchImpl = makeFetch([
      makeResponse({ dist: { attestations: { provenance: false } } }),
    ]);

    const result = await verifyPublishedProvenance({
      packageName: "code-pact",
      version: "2.0.1",
      fetchImpl,
      execImpl: makeExec({}),
      intervalMs: 10,
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("PROVENANCE_MISSING");
  });

  it("fails when npm audit signatures reports an unsupported predicateType", async () => {
    const fetchImpl = makeFetch([
      makeResponse({ dist: { attestations: { provenance: true } } }),
    ]) as unknown as typeof globalThis.fetch;
    const execImpl = makeExec(
      makeVerifiedAudit("https://example.com/unsupported"),
    );

    const result = await verifyPublishedProvenance({
      packageName: "code-pact",
      version: "2.0.1",
      fetchImpl,
      execImpl,
      intervalMs: 10,
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("PROVENANCE_PREDICATE_TYPE_UNSUPPORTED");
  });

  it("fails when npm audit signatures reports the package as invalid", async () => {
    const fetchImpl = makeFetch([
      makeResponse({ dist: { attestations: { provenance: true } } }),
    ]) as unknown as typeof globalThis.fetch;
    const execImpl = makeExec({
      invalid: [
        {
          name: "code-pact",
          version: "2.0.1",
          reason: "registry signature verification failed",
        },
      ],
      missing: [],
      verified: [],
    });

    const result = await verifyPublishedProvenance({
      packageName: "code-pact",
      version: "2.0.1",
      fetchImpl,
      execImpl,
      intervalMs: 10,
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("PROVENANCE_SIGNATURE_INVALID");
  });

  it("fails when the target package is not in the verified list", async () => {
    const fetchImpl = makeFetch([
      makeResponse({ dist: { attestations: { provenance: true } } }),
    ]) as unknown as typeof globalThis.fetch;
    const execImpl = makeExec({
      invalid: [],
      missing: [],
      verified: [{ name: "zod", version: "3.0.0" }],
    });

    const result = await verifyPublishedProvenance({
      packageName: "code-pact",
      version: "2.0.1",
      fetchImpl,
      execImpl,
      intervalMs: 10,
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("PROVENANCE_NOT_AUDITED");
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
      execImpl: makeExec(makeVerifiedAudit("https://slsa.dev/provenance/v1")),
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
      execImpl: makeExec({}),
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
      execImpl: makeExec({}),
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
      execImpl: makeExec({}),
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
      execImpl: makeExec({}),
      retries: 1,
      intervalMs: 10,
    });

    expect(result.ok).toBe(false);
  });

  it("fails when npm install fails", async () => {
    const fetchImpl = makeFetch([
      makeResponse({ dist: { attestations: { provenance: true } } }),
    ]) as unknown as typeof globalThis.fetch;
    const execImpl = vi.fn(async () => ({
      ok: false,
      stdout: "",
      stderr: "npm ERR! install failed",
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
});
