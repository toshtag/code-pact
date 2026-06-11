import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The inaccessible-live-file cases use an fs mock (deterministic, OS-independent,
// NOT chmod) scoped to the canonical decision path.
const fail = { accessError: null as { code: string } | null };

vi.mock("node:fs/promises", async (importActual) => {
  const actual = await importActual<typeof import("node:fs/promises")>();
  return {
    ...actual,
    access: vi.fn((...args: Parameters<typeof actual.access>) => {
      if (fail.accessError && /design[\\/]decisions[\\/]foo-rfc\.md/.test(String(args[0]))) {
        return Promise.reject(Object.assign(new Error("x"), fail.accessError));
      }
      return (actual.access as (...a: unknown[]) => unknown)(...(args as unknown[]));
    }),
  };
});

import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveRetiredDecisionGate,
  decisionRecordSoftensMissingRef,
} from "../../../../src/core/decisions/decision-gate-archive.ts";
import { resolveDecisionGate } from "../../../../src/core/decisions/adr.ts";
import { writeDecisionRecord } from "../../../../src/core/archive/decision-record.ts";
import { decisionRecordPath, sha256Hex } from "../../../../src/core/archive/paths.ts";

const NOW = new Date("2026-06-10T00:00:00.000Z");
const REF = "design/decisions/foo-rfc.md";
const ACCEPTED = `# RFC\n\n**Status:** accepted (P9, 2026-06)\n\n## Summary\n\nSettled.\n`;
const BLOCKED = `# RFC\n\n**Status:** proposed\n\n## Summary\n\nPending.\n`;

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "code-pact-decgate-"));
  await mkdir(join(cwd, "design", "decisions"), { recursive: true });
  await mkdir(join(cwd, ".code-pact", "state", "archive", "decisions"), { recursive: true });
});
afterEach(async () => {
  fail.accessError = null;
  vi.restoreAllMocks();
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

/** Write the ADR + its record, then (optionally) delete the live .md to retire it. */
async function setup(adr: string, { retire = true } = {}): Promise<void> {
  await writeFile(join(cwd, REF), adr, "utf8");
  expect((await writeDecisionRecord(cwd, REF, { now: NOW })).kind).toBe("written");
  if (retire) await rm(join(cwd, REF));
}

describe("resolveRetiredDecisionGate (predicate A — gate release, self-guards presence)", () => {
  it("retired + ACCEPTED record → released", async () => {
    await setup(ACCEPTED);
    expect((await resolveRetiredDecisionGate(cwd, REF)).kind).toBe("released");
  });

  it("retired + BLOCKED record → not_released (may_satisfy false)", async () => {
    await setup(BLOCKED);
    expect((await resolveRetiredDecisionGate(cwd, REF)).kind).toBe("not_released");
  });

  it("retired + NO record → not_released", async () => {
    await writeFile(join(cwd, REF), ACCEPTED, "utf8");
    await rm(join(cwd, REF)); // retired, but no record was written
    expect((await resolveRetiredDecisionGate(cwd, REF)).kind).toBe("not_released");
  });

  it("LIVE FILE PRESENT + accepted record → not_released (live-wins; record never consulted)", async () => {
    await setup(ACCEPTED, { retire: false }); // .md still on disk
    expect((await resolveRetiredDecisionGate(cwd, REF)).kind).toBe("not_released");
  });

  it("live file INACCESSIBLE (EACCES) + accepted record → not_released (true-ENOENT only)", async () => {
    await setup(ACCEPTED); // retired + accepted record
    await writeFile(join(cwd, REF), ACCEPTED, "utf8"); // file back on disk...
    fail.accessError = { code: "EACCES" }; // ...but access() reports EACCES
    expect((await resolveRetiredDecisionGate(cwd, REF)).kind).toBe("not_released");
  });

  it("live file inaccessible (EISDIR) + accepted record → not_released", async () => {
    await setup(ACCEPTED);
    await writeFile(join(cwd, REF), ACCEPTED, "utf8");
    fail.accessError = { code: "EISDIR" };
    expect((await resolveRetiredDecisionGate(cwd, REF)).kind).toBe("not_released");
  });

  it("non-normalizing ref (docs/, nested, traversal) → not_released, no lookup", async () => {
    await setup(ACCEPTED);
    expect((await resolveRetiredDecisionGate(cwd, "docs/cli-contract.md")).kind).toBe("not_released");
    expect((await resolveRetiredDecisionGate(cwd, "design/decisions/p3/nested.md")).kind).toBe(
      "not_released",
    );
  });

  it("canonical match but original_path mismatch (hand-edited raw JSON) → not_released", async () => {
    await setup(ACCEPTED);
    const p = decisionRecordPath(cwd, REF);
    const obj = JSON.parse(await readFile(p, "utf8"));
    // Bypass the schema (which enforces original_path === canonical_ref) by writing
    // raw JSON, to exercise the READER's own re-check.
    obj.original_path = "design/decisions/other.md";
    await writeFile(p, JSON.stringify(obj), "utf8");
    expect((await resolveRetiredDecisionGate(cwd, REF)).kind).toBe("not_released");
  });

  it("path_sha256 mismatch → not_released", async () => {
    await setup(ACCEPTED);
    const p = decisionRecordPath(cwd, REF);
    const obj = JSON.parse(await readFile(p, "utf8"));
    obj.path_sha256 = sha256Hex("design/decisions/something-else.md");
    await writeFile(p, JSON.stringify(obj), "utf8");
    expect((await resolveRetiredDecisionGate(cwd, REF)).kind).toBe("not_released");
  });

  it("SYMLINK ESCAPE: design/decisions -> outside dir (missing outside file) + accepted record → not_released", async () => {
    // Build the record while design/decisions is a real dir, THEN replace the dir
    // with a symlink that escapes the project root. access(canonical) would ENOENT
    // (the outside file is absent), but resolveWithinProject must reject the escape →
    // inaccessible → the record is NEVER consulted (live-wins, parity with the gate).
    await setup(ACCEPTED); // record written; live REF deleted
    const outside = await mkdtemp(join(tmpdir(), "code-pact-outside-dec-"));
    try {
      await rm(join(cwd, "design", "decisions"), { recursive: true, force: true });
      await symlink(outside, join(cwd, "design", "decisions"));
      expect((await resolveRetiredDecisionGate(cwd, REF)).kind).toBe("not_released");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("decisionRecordSoftensMissingRef (predicate B — lint soften, any status)", () => {
  it("retired + BLOCKED record → true (any valid record softens — A not_released, B true)", async () => {
    await setup(BLOCKED);
    expect(await decisionRecordSoftensMissingRef(cwd, REF)).toBe(true);
    expect((await resolveRetiredDecisionGate(cwd, REF)).kind).toBe("not_released");
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
    expect(await decisionRecordSoftensMissingRef(cwd, "docs/cli-contract.md")).toBe(false);
  });

  it("SYMLINK ESCAPE: design/decisions -> outside dir + valid record → false", async () => {
    await setup(BLOCKED);
    const outside = await mkdtemp(join(tmpdir(), "code-pact-outside-dec-"));
    try {
      await rm(join(cwd, "design", "decisions"), { recursive: true, force: true });
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
    await rm(join(cwd, "design", "decisions"), { recursive: true, force: true });
    // A gated task with NO explicit decision_refs cannot be released by a record —
    // there is no canonical key to look up.
    const res = await resolveDecisionGate(cwd, "foo-rfc", undefined);
    expect(res.resolved).toBe(false);
  });

  it("decision_refs:[X] SYMLINK ESCAPE + accepted record → UNRESOLVED (gate fails closed, not record-released)", async () => {
    await setup(ACCEPTED);
    const outside = await mkdtemp(join(tmpdir(), "code-pact-outside-dec-"));
    try {
      await rm(join(cwd, "design", "decisions"), { recursive: true, force: true });
      await symlink(outside, join(cwd, "design", "decisions"));
      const res = await resolveDecisionGate(cwd, "P1-T1", [REF]);
      expect(res.resolved).toBe(false);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
