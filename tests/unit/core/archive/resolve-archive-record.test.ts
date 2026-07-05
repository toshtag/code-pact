import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveArchiveRecordBytes,
  type RawLooseRecord,
} from "../../../../src/core/archive/resolve-archive-record.ts";
import type { BundleMemberIndex } from "../../../../src/core/archive/archive-bundle-index.ts";
import { writeDecisionRecord } from "../../../../src/core/archive/decision-record.ts";
import { decisionRecordPath, sha256Hex } from "../../../../src/core/archive/paths.ts";
import { decisionRecordStem } from "../../../../src/core/archive/archive-bundle-binding.ts";
import { archiveBundleError } from "../../../../src/core/archive/archive-bundle-reader.ts";

// The shared loose ∪ bundle resolver. reader-loose-wins is exercised end-to-end by
// the phase + decision readers; here we cover what they don't: the strict-reconcile
// mode (no runtime consumer yet), the lazy-load ISOLATION invariant, and bundle-fault
// propagation. A real decision record gives canonical bytes that bindBundleMember
// accepts.

const NOW = new Date("2026-06-10T00:00:00.000Z");
const REF = "design/decisions/foo-rfc.md";
const ADR = `# RFC\n\n**Status:** accepted (P9, 2026-06)\n\n## Summary\n\nSettled.\n`;

let cwd: string;
let stem: string;
let canonicalBytes: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "code-pact-resarch-"));
  await mkdir(join(cwd, "design", "decisions"), { recursive: true });
  await mkdir(join(cwd, ".code-pact", "state", "archive", "decisions"), { recursive: true });
  await writeFile(join(cwd, REF), ADR, "utf8");
  expect((await writeDecisionRecord(cwd, REF, { now: NOW })).kind).toBe("written");
  canonicalBytes = await readFile(decisionRecordPath(cwd, REF), "utf8");
  stem = decisionRecordStem(REF);
});
afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

const indexWith = (bytes: string): BundleMemberIndex =>
  new Map([["decision_record", new Map([[stem, { sha256: sha256Hex(bytes), bytes }]])]]);
const emptyIndex = (): BundleMemberIndex => new Map();
const loose = (r: RawLooseRecord) => () => r;
/** A thunk that fails the test if the resolver loads the index when it must not. */
const indexMustNotLoad = (): BundleMemberIndex => {
  throw new Error("loadBundleIndex must not be called");
};

describe("resolveArchiveRecordBytes — reader-loose-wins isolation", () => {
  it("loose present → resolved from loose; the bundle index is NEVER loaded", async () => {
    const res = await resolveArchiveRecordBytes({
      kind: "decision_record",
      id: stem,
      mode: "reader-loose-wins",
      readLooseRaw: loose({ kind: "present", bytes: canonicalBytes }),
      loadBundleIndex: indexMustNotLoad,
    });
    expect(res).toEqual({ kind: "resolved", bytes: canonicalBytes, source: "loose" });
  });

  it("loose invalid → invalid; the bundle index is NEVER loaded", async () => {
    const res = await resolveArchiveRecordBytes({
      kind: "decision_record",
      id: stem,
      mode: "reader-loose-wins",
      readLooseRaw: loose({ kind: "invalid", error: new Error("EACCES") }),
      loadBundleIndex: indexMustNotLoad,
    });
    expect(res.kind).toBe("invalid");
  });

  it("loose absent + bundle has it → resolved from bundle (self-bound)", async () => {
    const res = await resolveArchiveRecordBytes({
      kind: "decision_record",
      id: stem,
      mode: "reader-loose-wins",
      readLooseRaw: loose({ kind: "absent" }),
      loadBundleIndex: () => indexWith(canonicalBytes),
    });
    expect(res).toEqual({ kind: "resolved", bytes: canonicalBytes, source: "bundle" });
  });

  it("loose absent + empty bundle store → absent", async () => {
    const res = await resolveArchiveRecordBytes({
      kind: "decision_record",
      id: stem,
      mode: "reader-loose-wins",
      readLooseRaw: loose({ kind: "absent" }),
      loadBundleIndex: emptyIndex,
    });
    expect(res).toEqual({ kind: "absent" });
  });
});

describe("resolveArchiveRecordBytes — strict-reconcile", () => {
  it("loose + bundle byte-identical → resolved (loose source)", async () => {
    const res = await resolveArchiveRecordBytes({
      kind: "decision_record",
      id: stem,
      mode: "strict-reconcile",
      readLooseRaw: loose({ kind: "present", bytes: canonicalBytes }),
      loadBundleIndex: () => indexWith(canonicalBytes),
    });
    expect(res).toEqual({ kind: "resolved", bytes: canonicalBytes, source: "loose" });
  });

  it("loose + bundle DIFFER (bundle valid canonical) → throws bundle_stale", async () => {
    const otherBytes = canonicalBytes.replace(REF, "design/decisions/bar-rfc.md");
    // loose differs from the (valid, canonical) bundle member → bundle_stale.
    await expect(
      resolveArchiveRecordBytes({
        kind: "decision_record",
        id: stem,
        mode: "strict-reconcile",
        readLooseRaw: loose({ kind: "present", bytes: otherBytes }),
        loadBundleIndex: () => indexWith(canonicalBytes),
      }),
    ).rejects.toThrow(/bundle_stale/);
  });

  it("bundle-only → resolved (bundle source)", async () => {
    const res = await resolveArchiveRecordBytes({
      kind: "decision_record",
      id: stem,
      mode: "strict-reconcile",
      readLooseRaw: loose({ kind: "absent" }),
      loadBundleIndex: () => indexWith(canonicalBytes),
    });
    expect(res).toEqual({ kind: "resolved", bytes: canonicalBytes, source: "bundle" });
  });

  it("neither loose nor bundle → absent", async () => {
    const res = await resolveArchiveRecordBytes({
      kind: "decision_record",
      id: stem,
      mode: "strict-reconcile",
      readLooseRaw: loose({ kind: "absent" }),
      loadBundleIndex: emptyIndex,
    });
    expect(res).toEqual({ kind: "absent" });
  });
});

describe("resolveArchiveRecordBytes — bundle-fault propagation (caller maps to posture)", () => {
  for (const mode of ["reader-loose-wins", "strict-reconcile"] as const) {
    it(`${mode}: a throwing index load propagates (loose absent)`, async () => {
      await expect(
        resolveArchiveRecordBytes({
          kind: "decision_record",
          id: stem,
          mode,
          readLooseRaw: loose({ kind: "absent" }),
          loadBundleIndex: () => {
            throw archiveBundleError("duplicate_member_conflict", "bundles/x.json");
          },
        }),
      ).rejects.toThrow(/ARCHIVE_BUNDLE_INVALID|Archive bundle/);
    });
  }

  it("self-bind failure (non-canonical bundle bytes) propagates as a throw", async () => {
    const notCanonical = JSON.stringify(JSON.parse(canonicalBytes)); // valid JSON, not 2-space+newline
    expect(notCanonical).not.toBe(canonicalBytes);
    await expect(
      resolveArchiveRecordBytes({
        kind: "decision_record",
        id: stem,
        mode: "reader-loose-wins",
        readLooseRaw: loose({ kind: "absent" }),
        loadBundleIndex: () => indexWith(notCanonical),
      }),
    ).rejects.toThrow();
  });
});
