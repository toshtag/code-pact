import { describe, it, expect, vi } from "vitest";
import {
  verifyPublishedTarball,
  sha1hex,
  sha512sri,
  sha256hex,
  fetchRegistryMetadata,
} from "../../../scripts/verify-published-tarball.mjs";
import { createHash } from "node:crypto";

const testBytes = new TextEncoder().encode("hello world");
const testSha1 = createHash("sha1").update(testBytes).digest("hex");
const testSri = `sha512-${createHash("sha512").update(testBytes).digest("base64")}`;
const testSha256 = createHash("sha256").update(testBytes).digest("hex");

const metadata = {
  version: "2.0.1",
  dist: {
    tarball: "https://registry.npmjs.org/code-pact/-/code-pact-2.0.1.tgz",
    shasum: testSha1,
    integrity: testSri,
  },
};

describe("hash helpers", () => {
  it("sha1hex computes correct SHA-1", () => {
    expect(sha1hex(testBytes)).toBe(testSha1);
  });

  it("sha512sri computes correct SHA-512 SRI", () => {
    expect(sha512sri(testBytes)).toBe(testSri);
  });

  it("sha256hex computes correct SHA-256", () => {
    expect(sha256hex(testBytes)).toBe(testSha256);
  });
});

describe("fetchRegistryMetadata", () => {
  it("retries on 404 and succeeds", async () => {
    let calls = 0;
    const fetcher = vi.fn(async () => {
      calls++;
      if (calls < 3) return { ok: false, status: 404 };
      return { ok: true, json: async () => metadata };
    });
    const sleeper = vi.fn(async () => {});

    const result = await fetchRegistryMetadata(
      "code-pact",
      "2.0.1",
      fetcher as any,
      sleeper as any,
    );

    expect(result).toEqual(metadata);
    expect(calls).toBe(3);
    expect(sleeper).toHaveBeenCalledTimes(2);
  });

  it("fails immediately on non-404 error", async () => {
    const fetcher = vi.fn(async () => ({ ok: false, status: 500 }));
    const sleeper = vi.fn(async () => {});

    await expect(
      fetchRegistryMetadata(
        "code-pact",
        "2.0.1",
        fetcher as any,
        sleeper as any,
      ),
    ).rejects.toThrow("500");

    expect(sleeper).not.toHaveBeenCalled();
  });

  it("fails after max retries on persistent 404", async () => {
    const fetcher = vi.fn(async () => ({ ok: false, status: 404 }));
    const sleeper = vi.fn(async () => {});

    await expect(
      fetchRegistryMetadata(
        "code-pact",
        "2.0.1",
        fetcher as any,
        sleeper as any,
      ),
    ).rejects.toThrow("404");

    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(sleeper).toHaveBeenCalledTimes(4);
  });
});

describe("verifyPublishedTarball", () => {
  it("succeeds when local bytes == registry bytes and hashes match", async () => {
    const result = await verifyPublishedTarball({
      packageName: "code-pact",
      version: "2.0.1",
      localTarballPath: "/dev/null",
      metadataFetcher: async () => metadata,
      tarballFetcher: async () => testBytes,
      fileReader: async () => testBytes,
    });

    expect(result.ok).toBe(true);
    expect(result.report).toEqual({
      package: "code-pact",
      version: "2.0.1",
      tarball: metadata.dist.tarball,
      shasum: testSha1,
      integrity: testSri,
      local_sha256: testSha256,
    });
  });

  it("fails on registry SHA-1 mismatch", async () => {
    const result = await verifyPublishedTarball({
      packageName: "code-pact",
      version: "2.0.1",
      localTarballPath: "/dev/null",
      metadataFetcher: async () => ({
        ...metadata,
        dist: { ...metadata.dist, shasum: "wrong" },
      }),
      tarballFetcher: async () => testBytes,
      fileReader: async () => testBytes,
    });

    expect(result.ok).toBe(false);
    expect(result.problems.some((p: string) => p.includes("SHA-1"))).toBe(true);
  });

  it("fails on registry SRI mismatch", async () => {
    const result = await verifyPublishedTarball({
      packageName: "code-pact",
      version: "2.0.1",
      localTarballPath: "/dev/null",
      metadataFetcher: async () => ({
        ...metadata,
        dist: { ...metadata.dist, integrity: "sha512-wrong" },
      }),
      tarballFetcher: async () => testBytes,
      fileReader: async () => testBytes,
    });

    expect(result.ok).toBe(false);
    expect(result.problems.some((p: string) => p.includes("SRI"))).toBe(true);
  });

  it("fails on local/registry bytes mismatch", async () => {
    const differentBytes = new TextEncoder().encode("different content");
    const result = await verifyPublishedTarball({
      packageName: "code-pact",
      version: "2.0.1",
      localTarballPath: "/dev/null",
      metadataFetcher: async () => metadata,
      tarballFetcher: async () => testBytes,
      fileReader: async () => differentBytes,
    });

    expect(result.ok).toBe(false);
    expect(
      result.problems.some(
        (p: string) => p.includes("size") || p.includes("bytes"),
      ),
    ).toBe(true);
  });

  it("fails on version mismatch", async () => {
    const result = await verifyPublishedTarball({
      packageName: "code-pact",
      version: "2.0.1",
      localTarballPath: "/dev/null",
      metadataFetcher: async () => ({ ...metadata, version: "9.9.9" }),
      tarballFetcher: async () => testBytes,
      fileReader: async () => testBytes,
    });

    expect(result.ok).toBe(false);
    expect(result.problems.some((p: string) => p.includes("version"))).toBe(
      true,
    );
  });

  it("fails when metadata fetch fails", async () => {
    const result = await verifyPublishedTarball({
      packageName: "code-pact",
      version: "2.0.1",
      localTarballPath: "/dev/null",
      metadataFetcher: async () => {
        throw new Error("network error");
      },
    });

    expect(result.ok).toBe(false);
    expect(result.problems.some((p: string) => p.includes("metadata"))).toBe(
      true,
    );
  });

  it("idempotent success when version exists and bytes match", async () => {
    const result = await verifyPublishedTarball({
      packageName: "code-pact",
      version: "2.0.1",
      localTarballPath: "/dev/null",
      metadataFetcher: async () => metadata,
      tarballFetcher: async () => testBytes,
      fileReader: async () => testBytes,
    });

    expect(result.ok).toBe(true);
    expect(result.report?.shasum).toBe(testSha1);
  });
});
