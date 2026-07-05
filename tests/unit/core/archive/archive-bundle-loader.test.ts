import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadArchiveBundles } from "../../../../src/core/archive/archive-bundle-loader.ts";
import { computeMemberIdsSha256 } from "../../../../src/core/archive/archive-bundle-reader.ts";
import { ARCHIVE_BUNDLE_SCHEMA_VERSION } from "../../../../src/core/schemas/archive-bundle.ts";
import { sha256Hex } from "../../../../src/core/archive/paths.ts";

// Layer 1c-ii-a: the bundle-dir loader (readdir + per-file Tier-1 + index). Unwired.

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "archive-bundle-loader-"));
});
afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

const BUNDLES = (c: string) => join(c, ".code-pact", "state", "archive", "bundles");
const memberFor = (id: string, bytes: string) => ({ id, sha256: sha256Hex(bytes), bytes });
function bundleJson(kind: string, pairs: [string, string][]): string {
  const members = pairs.map(([id, b]) => memberFor(id, b)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return JSON.stringify({
    schema_version: ARCHIVE_BUNDLE_SCHEMA_VERSION,
    kind,
    member_ids_sha256: computeMemberIdsSha256(members.map((m) => m.id)),
    members,
  });
}
async function writeBundle(c: string, name: string, raw: string): Promise<void> {
  await mkdir(BUNDLES(c), { recursive: true });
  await writeFile(join(BUNDLES(c), name), raw, "utf8");
}

describe("loadArchiveBundles", () => {
  it("absent bundles dir → empty index (no crash)", () => {
    const { index, bundles } = loadArchiveBundles(cwd);
    expect(index.size).toBe(0);
    expect(bundles).toEqual([]);
  });

  it("loads + Tier-1-validates bundles and builds the cross-bundle index", async () => {
    await writeBundle(cwd, "phase_snapshot-a.json", bundleJson("phase_snapshot", [["P1", "a"], ["P2", "b"]]));
    await writeBundle(cwd, "decision_record-a.json", bundleJson("decision_record", [["d-1", "c"]]));
    const { index, bundles } = loadArchiveBundles(cwd);
    expect(bundles.map((b) => b.file).sort()).toEqual(["bundles/decision_record-a.json", "bundles/phase_snapshot-a.json"]);
    expect(index.get("phase_snapshot")!.get("P1")!.bytes).toBe("a");
    expect(index.get("decision_record")!.get("d-1")!.bytes).toBe("c");
  });

  it("a Tier-1-invalid bundle file → fail-closed ARCHIVE_BUNDLE_INVALID", async () => {
    await writeBundle(cwd, "phase_snapshot-bad.json", "{ not valid json");
    // Capture the thrown error so the `.code` assertion can never become dead
    // code: if loadArchiveBundles ever returned instead of throwing, `caught`
    // stays undefined and the final assertion fails loudly.
    let caught: unknown;
    try {
      loadArchiveBundles(cwd);
    } catch (e) {
      caught = e;
    }
    expect((caught as NodeJS.ErrnoException | undefined)?.code).toBe("ARCHIVE_BUNDLE_INVALID");
  });

  it("a `.json`-named SUBDIRECTORY is skipped (not read as a file → no untyped EISDIR)", async () => {
    await mkdir(join(BUNDLES(cwd), "phase_snapshot-dir.json"), { recursive: true });
    await writeBundle(cwd, "phase_snapshot-real.json", bundleJson("phase_snapshot", [["P1", "a"]]));
    const { index, bundles } = loadArchiveBundles(cwd);
    expect(bundles.map((b) => b.file)).toEqual(["bundles/phase_snapshot-real.json"]);
    expect(index.get("phase_snapshot")!.get("P1")!.bytes).toBe("a");
  });

  it("same id in two bundles with different bytes → fail-closed duplicate_member_conflict", async () => {
    await writeBundle(cwd, "phase_snapshot-1.json", bundleJson("phase_snapshot", [["P1", "a"]]));
    await writeBundle(cwd, "phase_snapshot-2.json", bundleJson("phase_snapshot", [["P1", "DIFFERENT"]]));
    expect(() => loadArchiveBundles(cwd)).toThrow(/duplicate_member_conflict/);
  });
});
