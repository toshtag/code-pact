import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
import { checkDocLinks } from "../../../scripts/check-doc-links.ts";
import { writeDecisionRecord } from "../../../src/core/archive/decision-record.ts";
import {
  decisionRecordPath,
  sha256Hex,
} from "../../../src/core/archive/paths.ts";

// design-docs-ephemeral step 7 PR-A. check-doc-links resolves a link to a
// hand-deleted `design/decisions/**/*.md` as RETIRED (not broken) IFF a valid,
// identity-checked decision-state record backs it — the judgement delegated whole
// to the step-5 `decisionRecordSoftensMissingRef` predicate. These tests drive
// `checkDocLinks({ repoRoot })` over a temp tree and assert the exit code + output.

const NOW = new Date("2026-06-10T00:00:00.000Z");
const XREF = "design/decisions/x-rfc.md";
const ACCEPTED =
  "# RFC: X\n\n**Status:** accepted (P9, 2026-06)\n\n## Decision\n\nSettled.\n";
// `**Status:** proposed` → classifyAdr → adr_status_at_snapshot "blocked"
// (a schema-valid NON-accepted record; never a literal `proposed` in the record).
const BLOCKED =
  "# RFC: X\n\n**Status:** proposed\n\n## Decision\n\nNot yet settled.\n";

/** Capture stdout/stderr writes so we can assert on the report text. */
function makeSink() {
  const lines: string[] = [];
  return { sink: { write: (s: string) => (lines.push(s), true) }, lines };
}

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "check-doc-links-"));
  await mkdir(join(cwd, "design", "decisions"), { recursive: true });
  await mkdir(join(cwd, ".code-pact", "state", "archive", "decisions"), {
    recursive: true,
  });
});
afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

/** A README at repo root with one inbound link to `design/decisions/x-rfc.md`. */
async function writeReadmeLinking(target = XREF): Promise<void> {
  await writeFile(
    join(cwd, "README.md"),
    `# Project\n\nSee [the X decision](${target}) for details.\n`,
    "utf8",
  );
}

/** Write the ADR + its decision-state record, then retire (delete the live .md). */
async function retireWithRecord(adr: string): Promise<void> {
  await writeFile(join(cwd, XREF), adr, "utf8");
  expect((await writeDecisionRecord(cwd, XREF, { now: NOW })).kind).toBe(
    "written",
  );
  await rm(join(cwd, XREF));
}

async function run(): Promise<{ code: number; out: string; err: string }> {
  const o = makeSink();
  const e = makeSink();
  const code = await checkDocLinks({
    repoRoot: cwd,
    stdout: o.sink,
    stderr: e.sink,
  });
  return { code, out: o.lines.join(""), err: e.lines.join("") };
}

describe("checkDocLinks — archive-record-aware (step 7 PR-A)", () => {
  it("A5 parity: a LIVE decision target resolves via the filesystem, no record consulted", async () => {
    await writeFile(join(cwd, XREF), ACCEPTED, "utf8"); // live .md present
    await writeReadmeLinking();
    const r = await run();
    expect(r.code).toBe(0);
    expect(r.out).toContain("OK —");
    expect(r.err).toBe("");
  });

  it("retired + ACCEPTED record → resolved as retired (not broken)", async () => {
    await retireWithRecord(ACCEPTED);
    await writeReadmeLinking();
    const r = await run();
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
  });

  it("retired + NON-ACCEPTED (blocked) record → still resolved (lint-soften 'any valid record')", async () => {
    await retireWithRecord(BLOCKED);
    await writeReadmeLinking();
    const r = await run();
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
  });

  it("retired + NO record → BROKEN (the second-chance does not blanket-suppress missing targets)", async () => {
    await writeFile(join(cwd, XREF), ACCEPTED, "utf8");
    await rm(join(cwd, XREF)); // deleted, but NO record was written
    await writeReadmeLinking();
    const r = await run();
    expect(r.code).toBe(1);
    expect(r.err).toContain("target file does not exist");
    expect(r.err).toContain(XREF);
  });

  it("retired + CORRUPT record (JSON garbage) → BROKEN, fail-closed (invalid never silences)", async () => {
    await retireWithRecord(ACCEPTED);
    await writeFile(decisionRecordPath(cwd, XREF), "{ not json", "utf8");
    await writeReadmeLinking();
    const r = await run();
    expect(r.code).toBe(1);
    expect(r.err).toContain("target file does not exist");
  });

  it("nested / non-decision .md target with no file + no record → BROKEN (normalize gate holds)", async () => {
    await writeFile(
      join(cwd, "README.md"),
      `# P\n\nSee [nested](design/decisions/p3/nested.md).\n`,
      "utf8",
    );
    const r = await run();
    expect(r.code).toBe(1);
    expect(r.err).toContain("design/decisions/p3/nested.md");
  });

  it("identity mismatch: schema-valid record for ANOTHER decision at x-rfc's path → BROKEN (blocker 1)", async () => {
    // Build a valid record for a DIFFERENT decision, then drop it at x-rfc's record
    // path. The reader re-checks canonical_ref/original_path/path_sha256 vs the
    // looked-up ref, so this identity-mismatched record must NOT retire the link.
    const otherRef = "design/decisions/other-rfc.md";
    await writeFile(join(cwd, otherRef), ACCEPTED, "utf8");
    expect((await writeDecisionRecord(cwd, otherRef, { now: NOW })).kind).toBe(
      "written",
    );
    const otherRecord = await readFile(
      decisionRecordPath(cwd, otherRef),
      "utf8",
    );
    // Place the OTHER decision's record at x-rfc's expected record path verbatim.
    await writeFile(decisionRecordPath(cwd, XREF), otherRecord, "utf8");
    await rm(join(cwd, XREF), { force: true }); // x-rfc.md never existed; ensure absent
    await rm(join(cwd, otherRef));
    await writeReadmeLinking(XREF);
    const r = await run();
    expect(r.code).toBe(1);
    expect(r.err).toContain(XREF);
  });

  it("identity mismatch: matching canonical_ref but wrong path_sha256 → BROKEN (blocker 1)", async () => {
    await retireWithRecord(ACCEPTED);
    const p = decisionRecordPath(cwd, XREF);
    const obj = JSON.parse(await readFile(p, "utf8"));
    obj.path_sha256 = sha256Hex("design/decisions/something-else.md");
    await writeFile(p, JSON.stringify(obj), "utf8");
    await writeReadmeLinking();
    const r = await run();
    expect(r.code).toBe(1);
    expect(r.err).toContain(XREF);
  });

  it("backslash link path + valid record → BROKEN, never retired (POSIX: a backslash is a filename byte, not a separator)", async () => {
    // On a POSIX FS, `design\decisions\x-rfc.md` is a single literal filename that
    // does not exist; the adapter must NOT let the predicate's `\`→`/` normalization
    // soften it against the valid forward-slash record. (Codex fail-open finding.)
    await retireWithRecord(ACCEPTED); // valid record for design/decisions/x-rfc.md
    await writeFile(
      join(cwd, "README.md"),
      "# P\n\nSee [x](design\\decisions\\x-rfc.md) for details.\n",
      "utf8",
    );
    const r = await run();
    expect(r.code).toBe(1);
    expect(r.err).toContain("target file does not exist");
  });

  it("retired link is counted exactly ONCE in the resolved tally (no double-increment)", async () => {
    // One inbound link to a retired-but-recorded decision → the OK summary must read
    // "1 relative .md link(s) resolved", not 2. (Claude double-`checked++` finding.)
    await retireWithRecord(ACCEPTED);
    await writeReadmeLinking();
    const r = await run();
    expect(r.code).toBe(0);
    expect(r.out).toContain("1 relative .md link(s) resolved");
  });

  it("ancestor symlink escape → BROKEN, never retired (PR #413 regression class, blocker 2)", async () => {
    // Build the record while design/decisions is a real dir, THEN replace the dir
    // with a symlink that escapes the repo root. The outside x-rfc.md is absent, so
    // access(canonical) would ENOENT — but the predicate's symlink-aware presence
    // reports the path inaccessible (not true-ENOENT), so the record is NEVER
    // consulted and the link stays broken.
    await retireWithRecord(ACCEPTED); // record written; live .md deleted
    const outside = await mkdtemp(join(tmpdir(), "check-doc-links-outside-"));
    try {
      await rm(join(cwd, "design", "decisions"), {
        recursive: true,
        force: true,
      });
      await symlink(outside, join(cwd, "design", "decisions"));
      await writeReadmeLinking();
      const r = await run();
      expect(r.code).toBe(1);
      expect(r.err).toContain("target file does not exist");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("checkDocLinks — archived CHANGELOG history is excluded as a SOURCE (verbatim point-in-time content)", () => {
  async function writeHistory(rel: string, body: string): Promise<void> {
    await mkdir(join(cwd, "docs", "maintainers", "history"), {
      recursive: true,
    });
    await writeFile(
      join(cwd, "docs", "maintainers", "history", rel),
      body,
      "utf8",
    );
  }

  it("a broken link INSIDE CHANGELOG-<major>.md does not fail (the archive is not scanned as a source)", async () => {
    await writeHistory(
      "CHANGELOG-1.md",
      "# Changelog (v1.x)\n\nSee [a doc that has since moved](does-not-exist.md).\n",
    );
    const r = await run();
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
  });

  it("a link TO an archived CHANGELOG still resolves (excluded as source, valid as target)", async () => {
    await writeHistory(
      "CHANGELOG-1.md",
      "# Changelog (v1.x)\n\nArchived verbatim.\n",
    );
    await writeFile(
      join(cwd, "README.md"),
      "# P\n\nOlder releases: [v1.x](docs/maintainers/history/CHANGELOG-1.md).\n",
      "utf8",
    );
    const r = await run();
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
  });

  it("a NON-CHANGELOG history doc IS still scanned (the exclusion is narrow, not all of history/)", async () => {
    await writeHistory(
      "some-backlog.md",
      "# Backlog\n\nSee [a gone target](nope.md).\n",
    );
    const r = await run();
    expect(r.code).toBe(1);
    expect(r.err).toContain("nope.md");
  });
});
