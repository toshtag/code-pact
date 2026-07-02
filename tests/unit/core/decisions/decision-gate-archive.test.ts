import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The inaccessible-live-file cases use an fs mock (deterministic, OS-independent,
// NOT chmod) scoped to the canonical decision path.
const fail = { accessError: null as { code: string } | null };

vi.mock("node:fs/promises", async importActual => {
  const actual = await importActual<typeof import("node:fs/promises")>();
  return {
    ...actual,
    access: vi.fn((...args: Parameters<typeof actual.access>) => {
      if (
        fail.accessError &&
        /design[\\/]decisions[\\/]foo-rfc\.md/.test(String(args[0]))
      ) {
        return Promise.reject(Object.assign(new Error("x"), fail.accessError));
      }
      return (actual.access as (...a: unknown[]) => unknown)(
        ...(args as unknown[]),
      );
    }),
  };
});

import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveRetiredDecisionGate,
  decisionRecordSoftensMissingRef,
} from "../../../../src/core/decisions/decision-gate-archive.ts";
import { resolveDecisionGate } from "../../../../src/core/decisions/adr.ts";
import { writeDecisionRecord } from "../../../../src/core/archive/decision-record.ts";
import {
  archiveBundlesDir,
  decisionRecordPath,
  sha256Hex,
} from "../../../../src/core/archive/paths.ts";
import { decisionRecordStem } from "../../../../src/core/archive/archive-bundle-binding.ts";
import { computeMemberIdsSha256 } from "../../../../src/core/archive/archive-bundle-reader.ts";
import { ARCHIVE_BUNDLE_SCHEMA_VERSION } from "../../../../src/core/schemas/archive-bundle.ts";

const NOW = new Date("2026-06-10T00:00:00.000Z");
const REF = "design/decisions/foo-rfc.md";
const ACCEPTED = `# RFC\n\n**Status:** accepted (P9, 2026-06)\n\n## Summary\n\nSettled.\n`;
const BLOCKED = `# RFC\n\n**Status:** proposed\n\n## Summary\n\nPending.\n`;

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "code-pact-decgate-"));
  await mkdir(join(cwd, "design", "decisions"), { recursive: true });
  await mkdir(join(cwd, ".code-pact", "state", "archive", "decisions"), {
    recursive: true,
  });
});
afterEach(async () => {
  fail.accessError = null;
  vi.restoreAllMocks();
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

/** Write the ADR + its record, then (optionally) delete the live .md to retire it. */
async function setup(adr: string, { retire = true } = {}): Promise<void> {
  await writeFile(join(cwd, REF), adr, "utf8");
  expect((await writeDecisionRecord(cwd, REF, { now: NOW })).kind).toBe(
    "written",
  );
  if (retire) await rm(join(cwd, REF));
}

describe("resolveRetiredDecisionGate (predicate A — gate release, self-guards presence)", () => {
  it("retired + ACCEPTED record → released", async () => {
    await setup(ACCEPTED);
    expect((await resolveRetiredDecisionGate(cwd, REF)).kind).toBe("released");
  });

  it("retired + BLOCKED record → not_released (may_satisfy false)", async () => {
    await setup(BLOCKED);
    expect((await resolveRetiredDecisionGate(cwd, REF)).kind).toBe(
      "not_released",
    );
  });

  it("retired + NO record → not_released", async () => {
    await writeFile(join(cwd, REF), ACCEPTED, "utf8");
    await rm(join(cwd, REF)); // retired, but no record was written
    expect((await resolveRetiredDecisionGate(cwd, REF)).kind).toBe(
      "not_released",
    );
  });

  it("LIVE FILE PRESENT + accepted record → not_released (live-wins; record never consulted)", async () => {
    await setup(ACCEPTED, { retire: false }); // .md still on disk
    expect((await resolveRetiredDecisionGate(cwd, REF)).kind).toBe(
      "not_released",
    );
  });

  it("live file INACCESSIBLE (EACCES) + accepted record → not_released (true-ENOENT only)", async () => {
    await setup(ACCEPTED); // retired + accepted record
    await writeFile(join(cwd, REF), ACCEPTED, "utf8"); // file back on disk...
    fail.accessError = { code: "EACCES" }; // ...but access() reports EACCES
    expect((await resolveRetiredDecisionGate(cwd, REF)).kind).toBe(
      "not_released",
    );
  });

  it("live file inaccessible (EISDIR) + accepted record → not_released", async () => {
    await setup(ACCEPTED);
    await writeFile(join(cwd, REF), ACCEPTED, "utf8");
    fail.accessError = { code: "EISDIR" };
    expect((await resolveRetiredDecisionGate(cwd, REF)).kind).toBe(
      "not_released",
    );
  });

  it("non-normalizing ref (docs/, README/PRUNED, traversal) → not_released, no lookup", async () => {
    await setup(ACCEPTED);
    expect(
      (await resolveRetiredDecisionGate(cwd, "docs/cli-contract.md")).kind,
    ).toBe("not_released");
    expect(
      (await resolveRetiredDecisionGate(cwd, "design/decisions/README.md"))
        .kind,
    ).toBe("not_released");
    expect(
      (await resolveRetiredDecisionGate(cwd, "design/decisions/p3/PRUNED.md"))
        .kind,
    ).toBe("not_released");
  });

  it("canonical match but original_path mismatch (hand-edited raw JSON) → not_released", async () => {
    await setup(ACCEPTED);
    const p = decisionRecordPath(cwd, REF);
    const obj = JSON.parse(await readFile(p, "utf8"));
    // Bypass the schema (which enforces original_path === canonical_ref) by writing
    // raw JSON, to exercise the READER's own re-check.
    obj.original_path = "design/decisions/other.md";
    await writeFile(p, JSON.stringify(obj), "utf8");
    expect((await resolveRetiredDecisionGate(cwd, REF)).kind).toBe(
      "not_released",
    );
  });

  it("path_sha256 mismatch → not_released", async () => {
    await setup(ACCEPTED);
    const p = decisionRecordPath(cwd, REF);
    const obj = JSON.parse(await readFile(p, "utf8"));
    obj.path_sha256 = sha256Hex("design/decisions/something-else.md");
    await writeFile(p, JSON.stringify(obj), "utf8");
    expect((await resolveRetiredDecisionGate(cwd, REF)).kind).toBe(
      "not_released",
    );
  });

  it("SYMLINK ESCAPE: design/decisions -> outside dir (missing outside file) + accepted record → not_released", async () => {
    // Build the record while design/decisions is a real dir, THEN replace the dir
    // with a symlink that escapes the project root. access(canonical) would ENOENT
    // (the outside file is absent), but resolveWithinProject must reject the escape →
    // inaccessible → the record is NEVER consulted (live-wins, parity with the gate).
    await setup(ACCEPTED); // record written; live REF deleted
    const outside = await mkdtemp(join(tmpdir(), "code-pact-outside-dec-"));
    try {
      await rm(join(cwd, "design", "decisions"), {
        recursive: true,
        force: true,
      });
      await symlink(outside, join(cwd, "design", "decisions"));
      expect((await resolveRetiredDecisionGate(cwd, REF)).kind).toBe(
        "not_released",
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("archive decisions symlinked outside + external accepted record → not_released", async () => {
    await writeFile(join(cwd, REF), ACCEPTED, "utf8");
    await rm(join(cwd, REF));

    const outside = await mkdtemp(
      join(tmpdir(), "code-pact-outside-archive-dec-"),
    );
    try {
      await mkdir(join(outside, "design", "decisions"), { recursive: true });
      await mkdir(
        join(outside, ".code-pact", "state", "archive", "decisions"),
        { recursive: true },
      );
      await writeFile(join(outside, REF), ACCEPTED, "utf8");
      expect((await writeDecisionRecord(outside, REF, { now: NOW })).kind).toBe(
        "written",
      );

      await rm(join(cwd, ".code-pact", "state", "archive", "decisions"), {
        recursive: true,
        force: true,
      });
      await symlink(
        join(outside, ".code-pact", "state", "archive", "decisions"),
        join(cwd, ".code-pact", "state", "archive", "decisions"),
      );

      expect((await resolveRetiredDecisionGate(cwd, REF)).kind).toBe(
        "not_released",
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("decisionRecordSoftensMissingRef (predicate B — lint soften, any status)", () => {
  it("retired + BLOCKED record → true (any valid record softens — A not_released, B true)", async () => {
    await setup(BLOCKED);
    expect(await decisionRecordSoftensMissingRef(cwd, REF)).toBe(true);
    expect((await resolveRetiredDecisionGate(cwd, REF)).kind).toBe(
      "not_released",
    );
  });

  it("retired + ACCEPTED record → true", async () => {
    await setup(ACCEPTED);
    expect(await decisionRecordSoftensMissingRef(cwd, REF)).toBe(true);
  });

  it("retired + NO record → false", async () => {
    await writeFile(join(cwd, REF), ACCEPTED, "utf8");
    await rm(join(cwd, REF));
    expect(await decisionRecordSoftensMissingRef(cwd, REF)).toBe(false);
  });

  it("LIVE FILE PRESENT + valid record → false (live-wins)", async () => {
    await setup(BLOCKED, { retire: false });
    expect(await decisionRecordSoftensMissingRef(cwd, REF)).toBe(false);
  });

  it("live file INACCESSIBLE (EACCES) + valid record → false (true-ENOENT only)", async () => {
    await setup(BLOCKED);
    await writeFile(join(cwd, REF), BLOCKED, "utf8");
    fail.accessError = { code: "EACCES" };
    expect(await decisionRecordSoftensMissingRef(cwd, REF)).toBe(false);
  });

  it("non-normalizing ref → false", async () => {
    await setup(BLOCKED);
    expect(
      await decisionRecordSoftensMissingRef(cwd, "docs/cli-contract.md"),
    ).toBe(false);
  });

  it("SYMLINK ESCAPE: design/decisions -> outside dir + valid record → false", async () => {
    await setup(BLOCKED);
    const outside = await mkdtemp(join(tmpdir(), "code-pact-outside-dec-"));
    try {
      await rm(join(cwd, "design", "decisions"), {
        recursive: true,
        force: true,
      });
      await symlink(outside, join(cwd, "design", "decisions"));
      expect(await decisionRecordSoftensMissingRef(cwd, REF)).toBe(false);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("resolveDecisionGate wrapper — record fallback only on retired explicit refs", () => {
  it("active task, decision_refs:[X] retired + accepted record → gate RESOLVES", async () => {
    await setup(ACCEPTED);
    const res = await resolveDecisionGate(cwd, "P1-T1", [REF]);
    expect(res.resolved).toBe(true);
  });

  it("decision_refs:[X] retired + blocked record → gate UNRESOLVED (fail-closed)", async () => {
    await setup(BLOCKED);
    const res = await resolveDecisionGate(cwd, "P1-T1", [REF]);
    expect(res.resolved).toBe(false);
  });

  it("decision_refs:[X] retired + no record → gate UNRESOLVED", async () => {
    await writeFile(join(cwd, REF), ACCEPTED, "utf8");
    await rm(join(cwd, REF));
    const res = await resolveDecisionGate(cwd, "P1-T1", [REF]);
    expect(res.resolved).toBe(false);
  });

  it("decision_refs:[X] LIVE present accepted → resolves via live file (record never read)", async () => {
    await setup(ACCEPTED, { retire: false });
    const res = await resolveDecisionGate(cwd, "P1-T1", [REF]);
    expect(res.resolved).toBe(true);
  });

  it("filename-scan (no decision_refs) + retired dir + record present → UNRESOLVED (no record-backed scan)", async () => {
    await setup(ACCEPTED);
    await rm(join(cwd, "design", "decisions"), {
      recursive: true,
      force: true,
    });
    // A gated task with NO explicit decision_refs cannot be released by a record —
    // there is no canonical key to look up.
    const res = await resolveDecisionGate(cwd, "foo-rfc", undefined);
    expect(res.resolved).toBe(false);
  });

  it("decision_refs:[X] SYMLINK ESCAPE + accepted record → UNRESOLVED (gate fails closed, not record-released)", async () => {
    await setup(ACCEPTED);
    const outside = await mkdtemp(join(tmpdir(), "code-pact-outside-dec-"));
    try {
      await rm(join(cwd, "design", "decisions"), {
        recursive: true,
        force: true,
      });
      await symlink(outside, join(cwd, "design", "decisions"));
      const res = await resolveDecisionGate(cwd, "P1-T1", [REF]);
      expect(res.resolved).toBe(false);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// loose ∪ bundle predicate wiring: a RETIRED + compacted decision (its loose record
// folded into a bundle) still releases a gate / softens a lint, and a corrupt bundle
// is fail-closed (gate) / fail-soft (lint) without throwing.
// ---------------------------------------------------------------------------

async function writeDecisionBundle(
  name: string,
  members: { id: string; bytes: string }[],
): Promise<void> {
  const dir = archiveBundlesDir(cwd);
  await mkdir(dir, { recursive: true });
  const full = members
    .map(m => ({ id: m.id, sha256: sha256Hex(m.bytes), bytes: m.bytes }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  await writeFile(
    join(dir, name),
    JSON.stringify({
      schema_version: ARCHIVE_BUNDLE_SCHEMA_VERSION,
      kind: "decision_record",
      member_ids_sha256: computeMemberIdsSha256(full.map(m => m.id)),
      members: full,
    }),
    "utf8",
  );
}

/** Retire the decision AND compact its loose record into a bundle: write ADR +
 *  record, read the canonical bytes, delete the live .md and the loose record. */
async function setupBundleOnly(adr: string): Promise<void> {
  await writeFile(join(cwd, REF), adr, "utf8");
  expect((await writeDecisionRecord(cwd, REF, { now: NOW })).kind).toBe(
    "written",
  );
  const recPath = decisionRecordPath(cwd, REF);
  const bytes = await readFile(recPath, "utf8");
  await rm(join(cwd, REF)); // retire (live .md gone)
  await rm(recPath); // compact loose record away
  await writeDecisionBundle("bundle-a.json", [
    { id: decisionRecordStem(REF), bytes },
  ]);
}

describe("predicate wiring — loose ∪ bundle (bundle-only retired decision)", () => {
  it("gate-release: retired + bundle-only ACCEPTED record → released", async () => {
    await setupBundleOnly(ACCEPTED);
    expect((await resolveRetiredDecisionGate(cwd, REF)).kind).toBe("released");
  });

  it("gate-release: retired + bundle-only BLOCKED record → not_released (may_satisfy false)", async () => {
    await setupBundleOnly(BLOCKED);
    expect((await resolveRetiredDecisionGate(cwd, REF)).kind).toBe(
      "not_released",
    );
  });

  it("lint-soften: retired + bundle-only record (any status) → softens", async () => {
    await setupBundleOnly(BLOCKED);
    expect(await decisionRecordSoftensMissingRef(cwd, REF)).toBe(true);
  });

  it("isolation: loose record present + unrelated corrupt bundle → still released (loose wins)", async () => {
    await setup(ACCEPTED); // retires live .md but LEAVES the loose record
    await mkdir(archiveBundlesDir(cwd), { recursive: true });
    await writeFile(
      join(archiveBundlesDir(cwd), "bad.json"),
      "{ not json",
      "utf8",
    );
    expect((await resolveRetiredDecisionGate(cwd, REF)).kind).toBe("released");
  });

  it("gate fail-closed: retired, loose gone, Tier-1-corrupt bundle → not_released (no throw)", async () => {
    await writeFile(join(cwd, REF), ACCEPTED, "utf8");
    expect((await writeDecisionRecord(cwd, REF, { now: NOW })).kind).toBe(
      "written",
    );
    await rm(join(cwd, REF));
    await rm(decisionRecordPath(cwd, REF));
    await mkdir(archiveBundlesDir(cwd), { recursive: true });
    await writeFile(
      join(archiveBundlesDir(cwd), "bad.json"),
      "{ not json",
      "utf8",
    );
    expect((await resolveRetiredDecisionGate(cwd, REF)).kind).toBe(
      "not_released",
    );
  });

  it("lint fail-soft: retired, loose gone, Tier-1-corrupt bundle → not softened (no throw)", async () => {
    await writeFile(join(cwd, REF), ACCEPTED, "utf8");
    expect((await writeDecisionRecord(cwd, REF, { now: NOW })).kind).toBe(
      "written",
    );
    await rm(join(cwd, REF));
    await rm(decisionRecordPath(cwd, REF));
    await mkdir(archiveBundlesDir(cwd), { recursive: true });
    await writeFile(
      join(archiveBundlesDir(cwd), "bad.json"),
      "{ not json",
      "utf8",
    );
    expect(await decisionRecordSoftensMissingRef(cwd, REF)).toBe(false);
  });

  it("bundle member self-binds but path_sha256 ≠ ref → not_released (bindBundleMember is NOT full authority)", async () => {
    // The schema enforces canonical_ref === original_path but NOT path_sha256 ===
    // sha256Hex(ref) — that authority lives in recordMatchingRef. Replace ONLY the
    // path_sha256 value (same-length hex) so the bytes stay canonical: bindBundleMember
    // passes (valid schema + identity + canonical), and only recordMatchingRef rejects.
    await writeFile(join(cwd, REF), ACCEPTED, "utf8");
    expect((await writeDecisionRecord(cwd, REF, { now: NOW })).kind).toBe(
      "written",
    );
    const recPath = decisionRecordPath(cwd, REF);
    const canonical = await readFile(recPath, "utf8");
    const tampered = canonical.replace(
      sha256Hex(REF),
      sha256Hex("design/decisions/elsewhere.md"),
    );
    expect(tampered).not.toBe(canonical);
    await rm(join(cwd, REF)); // retire
    await rm(recPath); // compact loose away
    await writeDecisionBundle("bundle-a.json", [
      { id: decisionRecordStem(REF), bytes: tampered },
    ]);
    expect((await resolveRetiredDecisionGate(cwd, REF)).kind).toBe(
      "not_released",
    );
  });
});

// ---------------------------------------------------------------------------
// Nested archive fallback — a retired NESTED decision (under a subdirectory of
// design/decisions/) resolves from its archive record with exact canonical-ref
// matching. A record for a different nested path must NOT release.
// ---------------------------------------------------------------------------

describe("nested archive fallback — exact canonical-ref match for nested paths", () => {
  const NESTED_REF = "design/decisions/sub/nested-rfc.md";
  const NESTED_ACCEPTED = `# RFC\n\n**Status:** accepted (P9, 2026-06)\n\n## Summary\n\nSettled.\n`;
  const NESTED_BLOCKED = `# RFC\n\n**Status:** proposed\n\n## Summary\n\nPending.\n`;
  let nestedCwd: string;

  beforeEach(async () => {
    nestedCwd = await mkdtemp(join(tmpdir(), "code-pact-nested-archive-"));
    await mkdir(join(nestedCwd, "design", "decisions", "sub"), {
      recursive: true,
    });
    await mkdir(
      join(nestedCwd, ".code-pact", "state", "archive", "decisions"),
      { recursive: true },
    );
  });
  afterEach(async () => {
    if (nestedCwd) await rm(nestedCwd, { recursive: true, force: true });
  });

  it("retired nested + accepted record → released (exact canonical match)", async () => {
    await writeFile(join(nestedCwd, NESTED_REF), NESTED_ACCEPTED, "utf8");
    expect(
      (await writeDecisionRecord(nestedCwd, NESTED_REF, { now: NOW })).kind,
    ).toBe("written");
    await rm(join(nestedCwd, NESTED_REF));
    expect((await resolveRetiredDecisionGate(nestedCwd, NESTED_REF)).kind).toBe(
      "released",
    );
  });

  it("retired nested + blocked record → not_released (may_satisfy false)", async () => {
    await writeFile(join(nestedCwd, NESTED_REF), NESTED_BLOCKED, "utf8");
    expect(
      (await writeDecisionRecord(nestedCwd, NESTED_REF, { now: NOW })).kind,
    ).toBe("written");
    await rm(join(nestedCwd, NESTED_REF));
    expect((await resolveRetiredDecisionGate(nestedCwd, NESTED_REF)).kind).toBe(
      "not_released",
    );
  });

  it("retired nested + record for a DIFFERENT nested path → not_released (no cross-path release)", async () => {
    const otherNested = "design/decisions/sub/other-rfc.md";
    await writeFile(join(nestedCwd, NESTED_REF), NESTED_ACCEPTED, "utf8");
    await writeFile(join(nestedCwd, otherNested), NESTED_ACCEPTED, "utf8");
    // Write records for both paths
    expect(
      (await writeDecisionRecord(nestedCwd, NESTED_REF, { now: NOW })).kind,
    ).toBe("written");
    expect(
      (await writeDecisionRecord(nestedCwd, otherNested, { now: NOW })).kind,
    ).toBe("written");
    // Retire both
    await rm(join(nestedCwd, NESTED_REF));
    await rm(join(nestedCwd, otherNested));
    // Delete NESTED_REF's record so only otherNested's record remains
    await rm(decisionRecordPath(nestedCwd, NESTED_REF));
    // The gate for NESTED_REF must not be released by otherNested's record
    expect((await resolveRetiredDecisionGate(nestedCwd, NESTED_REF)).kind).toBe(
      "not_released",
    );
  });

  it("retired deeply nested + accepted record → released", async () => {
    const deepRef = "design/decisions/deep/path/deep-rfc.md";
    await mkdir(join(nestedCwd, "design", "decisions", "deep", "path"), {
      recursive: true,
    });
    await writeFile(join(nestedCwd, deepRef), NESTED_ACCEPTED, "utf8");
    expect(
      (await writeDecisionRecord(nestedCwd, deepRef, { now: NOW })).kind,
    ).toBe("written");
    await rm(join(nestedCwd, deepRef));
    expect((await resolveRetiredDecisionGate(nestedCwd, deepRef)).kind).toBe(
      "released",
    );
  });

  it("resolveDecisionGate wrapper: retired nested + accepted record → gate RESOLVES", async () => {
    await writeFile(join(nestedCwd, NESTED_REF), NESTED_ACCEPTED, "utf8");
    expect(
      (await writeDecisionRecord(nestedCwd, NESTED_REF, { now: NOW })).kind,
    ).toBe("written");
    await rm(join(nestedCwd, NESTED_REF));
    const res = await resolveDecisionGate(nestedCwd, "P1-T1", [NESTED_REF]);
    expect(res.resolved).toBe(true);
    expect(res.considered[0]!.acceptance).toBe("accepted");
  });
});

// ---------------------------------------------------------------------------
// Live nested unsafe path never falls back to accepted archive record — a
// nested subdirectory replaced by a symlink that escapes the project root must
// NOT be treated as "absent" (which would consult the record). The
// symlink-escape-aware decisionFilePresence must return "inaccessible" →
// not_released, preserving parity with the live gate's fail-closed behavior.
// ---------------------------------------------------------------------------

describe("live nested unsafe path never falls back to accepted archive record", () => {
  const NESTED_REF = "design/decisions/sub/nested-rfc.md";
  const NESTED_ACCEPTED = `# RFC\n\n**Status:** accepted (P9, 2026-06)\n\n## Summary\n\nSettled.\n`;
  let unsafeCwd: string;

  beforeEach(async () => {
    unsafeCwd = await mkdtemp(join(tmpdir(), "code-pact-unsafe-nested-"));
    await mkdir(join(unsafeCwd, "design", "decisions", "sub"), {
      recursive: true,
    });
    await mkdir(
      join(unsafeCwd, ".code-pact", "state", "archive", "decisions"),
      { recursive: true },
    );
  });
  afterEach(async () => {
    if (unsafeCwd) await rm(unsafeCwd, { recursive: true, force: true });
  });

  it("subdirectory symlinked outside + accepted record → not_released (inaccessible, not absent)", async () => {
    // Write the ADR + record, then retire
    await writeFile(join(unsafeCwd, NESTED_REF), NESTED_ACCEPTED, "utf8");
    expect(
      (await writeDecisionRecord(unsafeCwd, NESTED_REF, { now: NOW })).kind,
    ).toBe("written");
    await rm(join(unsafeCwd, NESTED_REF));

    // Replace the subdirectory with a symlink to outside the project root
    const outside = await mkdtemp(join(tmpdir(), "code-pact-outside-sub-"));
    try {
      await rm(join(unsafeCwd, "design", "decisions", "sub"), {
        recursive: true,
        force: true,
      });
      await symlink(outside, join(unsafeCwd, "design", "decisions", "sub"));
      // The gate must NOT release — the path is inaccessible (symlink escape),
      // not absent, so the record is never consulted.
      expect(
        (await resolveRetiredDecisionGate(unsafeCwd, NESTED_REF)).kind,
      ).toBe("not_released");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("subdirectory symlinked outside + accepted record → gate UNRESOLVED (fail-closed parity)", async () => {
    await writeFile(join(unsafeCwd, NESTED_REF), NESTED_ACCEPTED, "utf8");
    expect(
      (await writeDecisionRecord(unsafeCwd, NESTED_REF, { now: NOW })).kind,
    ).toBe("written");
    await rm(join(unsafeCwd, NESTED_REF));

    const outside = await mkdtemp(
      join(tmpdir(), "code-pact-outside-sub-gate-"),
    );
    try {
      await rm(join(unsafeCwd, "design", "decisions", "sub"), {
        recursive: true,
        force: true,
      });
      await symlink(outside, join(unsafeCwd, "design", "decisions", "sub"));
      const res = await resolveDecisionGate(unsafeCwd, "P1-T1", [NESTED_REF]);
      expect(res.resolved).toBe(false);
      expect(res.considered[0]!.acceptance).not.toBe("accepted");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("decisionRecordSoftensMissingRef: subdirectory symlinked outside + valid record → false (inaccessible)", async () => {
    await writeFile(join(unsafeCwd, NESTED_REF), NESTED_ACCEPTED, "utf8");
    expect(
      (await writeDecisionRecord(unsafeCwd, NESTED_REF, { now: NOW })).kind,
    ).toBe("written");
    await rm(join(unsafeCwd, NESTED_REF));

    const outside = await mkdtemp(
      join(tmpdir(), "code-pact-outside-sub-soften-"),
    );
    try {
      await rm(join(unsafeCwd, "design", "decisions", "sub"), {
        recursive: true,
        force: true,
      });
      await symlink(outside, join(unsafeCwd, "design", "decisions", "sub"));
      expect(await decisionRecordSoftensMissingRef(unsafeCwd, NESTED_REF)).toBe(
        false,
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
