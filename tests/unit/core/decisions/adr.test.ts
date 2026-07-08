import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  readDecisionAdrFiles,
  readLiveDecisionDir,
  readLiveDecisionFile,
  hasDecisionAdrForTaskId,
  isAbsentDecisionsDirError,
  isDecisionRequiredForTask,
  parseAdrStatus,
  classifyAdr,
  parseAdrCommitments,
  resolveDecisionGate,
  makeDecisionResolver,
  classifyDecisionAdrs,
  type DecisionDirLister,
} from "../../../../src/core/decisions/adr.ts";
import { loadDeclaredDecisions } from "../../../../src/core/pack/loaders.ts";

describe("hasDecisionAdrForTaskId", () => {
  it("matches a .md whose name includes the task id", () => {
    expect(hasDecisionAdrForTaskId(["P1-T1-decision.md"], "P1-T1")).toBe(true);
  });

  it("ignores non-.md files", () => {
    expect(hasDecisionAdrForTaskId(["P1-T1-decision.txt"], "P1-T1")).toBe(
      false,
    );
  });

  it("returns false when no file includes the task id", () => {
    expect(hasDecisionAdrForTaskId(["P2-T1-decision.md"], "P1-T1")).toBe(false);
  });

  // Characterization test — pins the substring-collision compatibility that
  // verify already has and that lint now shares. "P1-T1" resolves against
  // "P1-T10-decision.md". This is a known limitation, not a goal; changing it
  // must be a deliberate change to BOTH verify and the lint advisory.
  it("matches by substring (P1-T1 resolves against P1-T10-decision.md)", () => {
    expect(hasDecisionAdrForTaskId(["P1-T10-decision.md"], "P1-T1")).toBe(true);
  });
});

describe("readDecisionAdrFiles", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "adr-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("returns [] when design/decisions/ is absent (ENOENT)", async () => {
    expect(await readDecisionAdrFiles(cwd)).toEqual([]);
  });

  it("returns [] when design/decisions is a file, not a dir (ENOTDIR)", async () => {
    await mkdir(join(cwd, "design"), { recursive: true });
    await writeFile(join(cwd, "design", "decisions"), "not a directory");
    expect(await readDecisionAdrFiles(cwd)).toEqual([]);
  });

  it("returns canonical decision paths when the directory exists", async () => {
    await mkdir(join(cwd, "design", "decisions"), { recursive: true });
    await writeFile(join(cwd, "design", "decisions", "P1-T1-rfc.md"), "x");
    expect(await readDecisionAdrFiles(cwd)).toContain(
      "design/decisions/P1-T1-rfc.md",
    );
  });

  it("excludes non-decision files (README.md, PRUNED.md ledger) from the candidate scan", async () => {
    await mkdir(join(cwd, "design", "decisions"), { recursive: true });
    await writeFile(join(cwd, "design", "decisions", "P1-T1-rfc.md"), "x");
    await writeFile(join(cwd, "design", "decisions", "README.md"), "index");
    await writeFile(join(cwd, "design", "decisions", "PRUNED.md"), "ledger");
    const files = await readDecisionAdrFiles(cwd);
    expect(files).toContain("design/decisions/P1-T1-rfc.md");
    expect(files).not.toContain("design/decisions/README.md");
    expect(files).not.toContain("design/decisions/PRUNED.md");
  });
});

// Step 2b characterization: the two LIVE decision-read primitives that the pack
// loaders now share. These pin "live-only, fail-closed" — the contract step 5's
// gate-aware / lint-aware wrappers will compose ON TOP of (never inside).
describe("readLiveDecisionDir / readLiveDecisionFile (live decision-read seam)", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "adr-seam-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("readLiveDecisionDir reports present=false / [] for an absent dir (ENOENT)", async () => {
    expect(await readLiveDecisionDir(cwd)).toEqual({
      present: false,
      entries: [],
    });
  });

  it("readLiveDecisionDir reports present=true with NON_DECISION_FILES filtered out", async () => {
    await mkdir(join(cwd, "design", "decisions"), { recursive: true });
    await writeFile(join(cwd, "design", "decisions", "P1-T1-rfc.md"), "x");
    await writeFile(join(cwd, "design", "decisions", "README.md"), "index");
    await writeFile(join(cwd, "design", "decisions", "PRUNED.md"), "ledger");
    const dir = await readLiveDecisionDir(cwd);
    expect(dir.present).toBe(true);
    expect(dir.entries).toContain("design/decisions/P1-T1-rfc.md");
    expect(dir.entries).not.toContain("design/decisions/README.md");
    expect(dir.entries).not.toContain("design/decisions/PRUNED.md");
  });

  it("readLiveDecisionFile returns ok for a safe in-project decision file", async () => {
    await mkdir(join(cwd, "design", "decisions"), { recursive: true });
    await writeFile(
      join(cwd, "design", "decisions", "a.md"),
      "**Status:** accepted\n",
    );
    const r = await readLiveDecisionFile(cwd, "design/decisions/a.md");
    expect(r.kind).toBe("ok");
    expect(r.kind === "ok" && r.content).toContain("accepted");
  });

  it("readLiveDecisionFile returns missing for a non-existent file (no throw)", async () => {
    await mkdir(join(cwd, "design", "decisions"), { recursive: true });
    const r = await readLiveDecisionFile(cwd, "design/decisions/nope.md");
    expect(r.kind).toBe("missing");
  });

  it("readLiveDecisionFile returns unsafe for a traversal path (escapes project root)", async () => {
    const r = await readLiveDecisionFile(cwd, "../outside.md");
    expect(r.kind).toBe("unsafe");
  });

  it("readLiveDecisionFile accepts a nested ADR under the decision namespace", async () => {
    await mkdir(join(cwd, "design", "decisions", "p3"), { recursive: true });
    await writeFile(
      join(cwd, "design", "decisions", "p3", "adr.md"),
      "nested body",
    );
    const r = await readLiveDecisionFile(cwd, "design/decisions/p3/adr.md");
    expect(r.kind).toBe("ok");
    expect(r.kind === "ok" && r.content).toBe("nested body");
  });
});

// Step 2b characterization: the live gate stays fail-closed on an ABSENT
// design/decisions, with the unchanged reason. Pins that exporting/renaming the
// dir-listing seam did not loosen the gate (it must never resolve from absence).
describe("resolveDecisionGate — absent design/decisions fail-closed", () => {
  it("does not resolve and reports the dir-missing reason when requires_decision is true", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "adr-fc-"));
    try {
      const res = await resolveDecisionGate(cwd, "P1-T1");
      expect(res.resolved).toBe(false);
      expect(res.dirPresent).toBe(false);
      expect(res.reason).toContain(
        "design/decisions/ does not exist but requires_decision is true",
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("isAbsentDecisionsDirError", () => {
  it("is true for ENOENT and ENOTDIR (the normal no-ADR states)", () => {
    expect(isAbsentDecisionsDirError({ code: "ENOENT" })).toBe(true);
    expect(isAbsentDecisionsDirError({ code: "ENOTDIR" })).toBe(true);
  });

  it("is false for other errors so readDecisionAdrFiles rethrows them", () => {
    expect(isAbsentDecisionsDirError({ code: "EACCES" })).toBe(false);
    expect(isAbsentDecisionsDirError(new Error("boom"))).toBe(false);
    expect(isAbsentDecisionsDirError(null)).toBe(false);
    expect(isAbsentDecisionsDirError("nope")).toBe(false);
  });
});

describe("isDecisionRequiredForTask", () => {
  it("is true when the task requires a decision", () => {
    expect(isDecisionRequiredForTask({}, { requires_decision: true })).toBe(
      true,
    );
  });
  it("is true when the phase requires a decision (parity with verify)", () => {
    expect(isDecisionRequiredForTask({ requires_decision: true }, {})).toBe(
      true,
    );
  });
  it("is false when neither does", () => {
    expect(isDecisionRequiredForTask({}, {})).toBe(false);
    expect(
      isDecisionRequiredForTask(
        { requires_decision: false },
        { requires_decision: false },
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Status-aware resolution (RFC §3-C)
// ---------------------------------------------------------------------------

describe("parseAdrStatus", () => {
  it("reads the bold-line status, stripping a glued paren/comma", () => {
    expect(
      parseAdrStatus("# T\n\n**Status:** accepted (P16, 2026-05)\n"),
    ).toEqual({
      word: "accepted",
      source: "bold-line",
    });
  });

  it("is case-insensitive on both the label and the word", () => {
    expect(parseAdrStatus("**status:** Proposed\n").word).toBe("proposed");
  });

  it("handles CRLF line endings", () => {
    expect(parseAdrStatus("# T\r\n\r\n**Status:** proposed\r\n").word).toBe(
      "proposed",
    );
  });

  it("returns word=null with source=none when there is no status line", () => {
    expect(parseAdrStatus("# Decision\nSome body.\n")).toEqual({
      word: null,
      source: "none",
    });
  });

  it("reads frontmatter status", () => {
    expect(parseAdrStatus("---\nstatus: accepted\n---\n# T\n")).toEqual({
      word: "accepted",
      source: "frontmatter",
    });
  });

  it("frontmatter status wins over the bold line when both are present", () => {
    const content = "---\nstatus: proposed\n---\n# T\n\n**Status:** accepted\n";
    expect(parseAdrStatus(content)).toEqual({
      word: "proposed",
      source: "frontmatter",
    });
  });
});

describe("classifyAdr", () => {
  it("empty / whitespace-only file → empty (never resolves)", () => {
    expect(classifyAdr("").acceptance).toBe("empty");
    expect(classifyAdr("   \n\t").acceptance).toBe("empty");
  });

  it("non-empty file with no status line → accepted (lenient backward-compat)", () => {
    expect(classifyAdr("# Decision\nSome body.\n").acceptance).toBe("accepted");
  });

  it("explicit accepted → accepted", () => {
    expect(classifyAdr("**Status:** accepted (P1, 2026)\n").acceptance).toBe(
      "accepted",
    );
  });

  it("each blocking status → blocked", () => {
    for (const w of ["proposed", "draft", "rejected", "superseded"]) {
      expect(classifyAdr(`**Status:** ${w}\n`).acceptance).toBe("blocked");
    }
  });

  it("explicit UNKNOWN status (typo) → unknown_status (does NOT resolve)", () => {
    expect(classifyAdr("**Status:** acceptd\n").acceptance).toBe(
      "unknown_status",
    );
  });
});

describe("resolveDecisionGate — filename scan (any-accepted-wins)", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "adr-resolve-"));
    await mkdir(join(cwd, "design", "decisions"), { recursive: true });
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });
  const writeAdr = (name: string, content: string) =>
    writeFile(join(cwd, "design", "decisions", name), content);

  it("an accepted ADR resolves; reason names the file", async () => {
    await writeAdr("P1-T1-rfc.md", "**Status:** accepted (P1, 2026)\n");
    const res = await resolveDecisionGate(cwd, "P1-T1");
    expect(res.resolved).toBe(true);
    expect(res.via).toBe("filename-scan");
    expect(res.reason).toContain("P1-T1-rfc.md");
  });

  it("a proposed ADR does not resolve; reason says why", async () => {
    await writeAdr("P1-T1-rfc.md", "**Status:** proposed\n");
    const res = await resolveDecisionGate(cwd, "P1-T1");
    expect(res.resolved).toBe(false);
    expect(res.considered[0]!.acceptance).toBe("blocked");
    expect(res.reason).toContain('is "proposed"');
  });

  it("an empty ADR does not resolve", async () => {
    await writeAdr("P1-T1-rfc.md", "   \n");
    const res = await resolveDecisionGate(cwd, "P1-T1");
    expect(res.resolved).toBe(false);
    expect(res.considered[0]!.acceptance).toBe("empty");
  });

  it("an unknown-status ADR does not resolve", async () => {
    await writeAdr("P1-T1-rfc.md", "**Status:** acceptd\n");
    const res = await resolveDecisionGate(cwd, "P1-T1");
    expect(res.resolved).toBe(false);
    expect(res.considered[0]!.acceptance).toBe("unknown_status");
  });

  it("a non-empty no-status ADR still resolves (backward compat)", async () => {
    await writeAdr("P1-T1-rfc.md", "# Decision\nSome body.\n");
    expect((await resolveDecisionGate(cwd, "P1-T1")).resolved).toBe(true);
  });

  it("no matching ADR → unresolved with the canonical reason", async () => {
    const res = await resolveDecisionGate(cwd, "P1-T1");
    expect(res.resolved).toBe(false);
    expect(res.reason).toBe(
      'No ADR found for task "P1-T1" in design/decisions/',
    );
  });

  it("absent design/decisions/ → unresolved, dirPresent=false, specific message", async () => {
    const bare = await mkdtemp(join(tmpdir(), "adr-bare-"));
    try {
      const res = await resolveDecisionGate(bare, "P1-T1");
      expect(res.resolved).toBe(false);
      expect(res.dirPresent).toBe(false);
      expect(res.reason).toContain("does not exist");
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });

  it("substring collision: P1-T1 proposed + P1-T10 accepted → resolved (any-accepted-wins)", async () => {
    await writeAdr("P1-T1-rfc.md", "**Status:** proposed\n");
    await writeAdr("P1-T10-rfc.md", "**Status:** accepted (P1, 2026)\n");
    expect((await resolveDecisionGate(cwd, "P1-T1")).resolved).toBe(true);
  });

  it("all matches proposed → unresolved", async () => {
    await writeAdr("P1-T1-a.md", "**Status:** proposed\n");
    await writeAdr("P1-T1-b.md", "**Status:** draft\n");
    expect((await resolveDecisionGate(cwd, "P1-T1")).resolved).toBe(false);
  });
});

describe("resolveDecisionGate — decision_refs (all-must-be-accepted)", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "adr-refs-"));
    await mkdir(join(cwd, "design", "decisions"), { recursive: true });
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });
  const writeAdr = (name: string, content: string) =>
    writeFile(join(cwd, "design", "decisions", name), content);

  it("all refs accepted → resolved (via decision_refs)", async () => {
    await writeAdr("a.md", "**Status:** accepted (P1, 2026)\n");
    await writeAdr("b.md", "**Status:** accepted (P1, 2026)\n");
    const res = await resolveDecisionGate(cwd, "P1-T1", [
      "design/decisions/a.md",
      "design/decisions/b.md",
    ]);
    expect(res.resolved).toBe(true);
    expect(res.via).toBe("decision_refs");
  });

  it("accepted + proposed → unresolved (one bad ref fails the contract)", async () => {
    await writeAdr("a.md", "**Status:** accepted (P1, 2026)\n");
    await writeAdr("b.md", "**Status:** proposed\n");
    const res = await resolveDecisionGate(cwd, "P1-T1", [
      "design/decisions/a.md",
      "design/decisions/b.md",
    ]);
    expect(res.resolved).toBe(false);
    expect(res.reason).toContain('is "proposed"');
  });

  it("accepted + missing → unresolved, missing entry, no throw", async () => {
    await writeAdr("a.md", "**Status:** accepted (P1, 2026)\n");
    const res = await resolveDecisionGate(cwd, "P1-T1", [
      "design/decisions/a.md",
      "design/decisions/gone.md",
    ]);
    expect(res.resolved).toBe(false);
    const missing = res.considered.find(c => c.path.endsWith("gone.md"));
    expect(missing?.acceptance).toBe("missing");
  });

  it("explicit ref to a directory named *.md → unreadable, unresolved, no throw", async () => {
    await mkdir(join(cwd, "design", "decisions", "P1-T1.md"), {
      recursive: true,
    });
    const res = await resolveDecisionGate(cwd, "P1-T1", [
      "design/decisions/P1-T1.md",
    ]);
    expect(res.resolved).toBe(false);
    expect(res.considered).toEqual([
      {
        path: "design/decisions/P1-T1.md",
        status: null,
        accepted: false,
        acceptance: "unreadable",
      },
    ]);
  });

  it("accepted + empty → unresolved", async () => {
    await writeAdr("a.md", "**Status:** accepted (P1, 2026)\n");
    await writeAdr("b.md", "\n");
    const res = await resolveDecisionGate(cwd, "P1-T1", [
      "design/decisions/a.md",
      "design/decisions/b.md",
    ]);
    expect(res.resolved).toBe(false);
  });
});

describe("resolveDecisionGate — decision_refs path safety (fail-closed)", () => {
  let cwd: string;
  let outsideDir: string;
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "adr-safety-"));
    outsideDir = await mkdtemp(join(tmpdir(), "adr-outside-"));
    await mkdir(join(cwd, "design", "decisions"), { recursive: true });
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  });

  it("traversal ref ('../outside.md') → unsafe_path, unresolved, no throw, file never read", async () => {
    // An accepted ADR sits just outside the project root; the gate must NOT
    // read it and must NOT resolve — the path is fail-closed at the boundary.
    await writeFile(join(outsideDir, "outside.md"), "**Status:** accepted\n");
    const res = await resolveDecisionGate(cwd, "P1-T1", ["../outside.md"]);
    expect(res.resolved).toBe(false);
    const entry = res.considered.find(c => c.path.includes("outside.md"));
    expect(entry?.acceptance).toBe("unsafe_path");
    expect(entry?.accepted).toBe(false);
    expect(res.reason).toContain("unsafe path");
  });

  it("symlink escape inside design/decisions/ → unsafe_path, unresolved", async () => {
    // A symlink in design/decisions/ that points to an accepted ADR outside
    // the project must not resolve the gate.
    await writeFile(join(outsideDir, "target.md"), "**Status:** accepted\n");
    await symlink(
      join(outsideDir, "target.md"),
      join(cwd, "design", "decisions", "escape.md"),
    );
    const res = await resolveDecisionGate(cwd, "P1-T1", [
      "design/decisions/escape.md",
    ]);
    expect(res.resolved).toBe(false);
    const entry = res.considered.find(c => c.path.includes("escape.md"));
    expect(entry?.acceptance).toBe("unsafe_path");
  });

  it("one safe-accepted + one traversal ref → unresolved (all-must-be-accepted, fail-closed)", async () => {
    await writeFile(
      join(cwd, "design", "decisions", "a.md"),
      "**Status:** accepted\n",
    );
    await writeFile(join(outsideDir, "b.md"), "**Status:** accepted\n");
    const res = await resolveDecisionGate(cwd, "P1-T1", [
      "design/decisions/a.md",
      "../b.md",
    ]);
    expect(res.resolved).toBe(false);
    expect(res.considered.find(c => c.path.includes("b.md"))?.acceptance).toBe(
      "unsafe_path",
    );
  });

  it("makeDecisionResolver is fail-closed on a traversal ref too", async () => {
    await writeFile(join(outsideDir, "outside.md"), "**Status:** accepted\n");
    const resolver = await makeDecisionResolver(cwd);
    const res = await resolver.resolve("P1-T1", ["../outside.md"]);
    expect(res.resolved).toBe(false);
    expect(
      res.considered.find(c => c.path.includes("outside.md"))?.acceptance,
    ).toBe("unsafe_path");
  });

  // SECURITY (Blocker 1): an IN-PROJECT non-decision file. Path-safety alone
  // would PASS (.env is inside the root, no `..`, no symlink), and `.env` has
  // no status line — so WITHOUT the namespace guard the gate would read it,
  // classify it "accepted" (lenient no-status rule), and RELEASE the
  // requires_decision gate. The namespace check (isDecisionRefPath) closes it:
  // out-of-namespace → unsafe_path, never read, never resolves.
  it("in-project .env ref → unsafe_path, never read, gate NOT released", async () => {
    await writeFile(join(cwd, ".env"), "API_TOKEN=secret-marker\n");
    const res = await resolveDecisionGate(cwd, "P1-T1", [".env"]);
    expect(res.resolved).toBe(false);
    const entry = res.considered.find(c => c.path.includes(".env"));
    expect(entry?.acceptance).toBe("unsafe_path");
    expect(entry?.accepted).toBe(false);
    // The secret content must never surface in the resolution result.
    expect(JSON.stringify(res)).not.toContain("secret-marker");
  });

  it("in-project doc outside design/decisions/ → unsafe_path, gate NOT released", async () => {
    await mkdir(join(cwd, "docs"), { recursive: true });
    await writeFile(join(cwd, "docs", "cli-contract.md"), "# no status line\n");
    const res = await resolveDecisionGate(cwd, "P1-T1", [
      "docs/cli-contract.md",
    ]);
    expect(res.resolved).toBe(false);
    expect(
      res.considered.find(c => c.path.includes("cli-contract.md"))?.acceptance,
    ).toBe("unsafe_path");
  });

  it("loadDeclaredDecisions never renders an in-project .env into the pack", async () => {
    await writeFile(join(cwd, ".env"), "API_TOKEN=secret-marker\n");
    const docs = await loadDeclaredDecisions(cwd, [".env"]);
    expect(docs).toEqual([]);
  });
});

describe("makeDecisionResolver", () => {
  it("reads the directory once and resolves multiple tasks consistently", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "adr-batch-"));
    try {
      await mkdir(join(cwd, "design", "decisions"), { recursive: true });
      await writeFile(
        join(cwd, "design", "decisions", "P1-T1-rfc.md"),
        "**Status:** accepted (P1, 2026)\n",
      );
      await writeFile(
        join(cwd, "design", "decisions", "P1-T2-rfc.md"),
        "**Status:** proposed\n",
      );
      const resolver = await makeDecisionResolver(cwd);
      expect((await resolver.resolve("P1-T1")).resolved).toBe(true);
      expect((await resolver.resolve("P1-T2")).resolved).toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("classifyDecisionAdrs", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "adr-classify-dir-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });
  const writeAdr = async (name: string, content: string) => {
    await mkdir(join(cwd, "design", "decisions"), { recursive: true });
    await writeFile(join(cwd, "design", "decisions", name), content, "utf8");
  };

  it("returns [] when design/decisions/ is absent", async () => {
    expect(await classifyDecisionAdrs(cwd)).toEqual([]);
  });

  it("classifies each .md with acceptance + status + statusSource", async () => {
    await writeAdr("accepted.md", "**Status:** accepted (P1, 2026)\n");
    await writeAdr("proposed.md", "**Status:** proposed\n");
    await writeAdr("typo.md", "**Status:** acceptd\n");
    await writeAdr("nostatus.md", "# Decision\nbody\n");
    await writeAdr("empty.md", "\n");

    const byFile = Object.fromEntries(
      (await classifyDecisionAdrs(cwd)).map(a => [a.file, a]),
    );
    expect(byFile["design/decisions/accepted.md"]!.acceptance).toBe("accepted");
    expect(byFile["design/decisions/proposed.md"]!.acceptance).toBe("blocked");
    expect(byFile["design/decisions/typo.md"]).toMatchObject({
      acceptance: "unknown_status",
      status: "acceptd",
      statusSource: "bold-line",
    });
    expect(byFile["design/decisions/nostatus.md"]!.acceptance).toBe("accepted");
    expect(byFile["design/decisions/empty.md"]!.acceptance).toBe("empty");
  });

  it("frontmatter typo wins over an accepted bold line", async () => {
    await writeAdr(
      "fm.md",
      "---\nstatus: acceptd\n---\n\n**Status:** accepted\n",
    );
    const [entry] = await classifyDecisionAdrs(cwd);
    expect(entry).toMatchObject({
      acceptance: "unknown_status",
      status: "acceptd",
      statusSource: "frontmatter",
    });
  });

  it("ignores non-.md entries", async () => {
    await writeAdr("real.md", "**Status:** accepted\n");
    await writeAdr(".DS_Store", "binary-ish\n");
    const files = (await classifyDecisionAdrs(cwd)).map(a => a.file);
    expect(files).toEqual(["design/decisions/real.md"]);
  });

  it("skips (does not crash on) a DIRECTORY named *.md — hostile repo, EISDIR", async () => {
    await writeAdr("real.md", "**Status:** accepted\n");
    // A directory named like an ADR: a bare readFile would throw EISDIR (exit 3).
    await mkdir(join(cwd, "design", "decisions", "evil.md"), {
      recursive: true,
    });
    const files = (await classifyDecisionAdrs(cwd)).map(a => a.file);
    expect(files).toEqual(["design/decisions/real.md"]); // evil.md skipped, no throw
  });

  it("skips an ADR whose file symlink-escapes the project (contained read)", async () => {
    const outside = await mkdtemp(join(tmpdir(), "adr-classify-out-"));
    try {
      await writeFile(
        join(outside, "secret.md"),
        "**Status:** accepted\nSECRET\n",
        "utf8",
      );
      await mkdir(join(cwd, "design", "decisions"), { recursive: true });
      await symlink(
        join(outside, "secret.md"),
        join(cwd, "design", "decisions", "leak.md"),
      );
      const files = (await classifyDecisionAdrs(cwd)).map(a => a.file);
      expect(files).toEqual([]); // the escaping symlink is `unsafe` → skipped
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("parseAdrCommitments", () => {
  it("returns hasSection:false / no items when the section is absent", () => {
    expect(parseAdrCommitments("# T\n\n## Decision\n\nBody.\n")).toEqual({
      hasSection: false,
      items: [],
    });
  });

  it("returns hasSection:true / no items when the section has zero checkboxes", () => {
    const content =
      "## Implementation commitments\n\nProse only, no checkboxes.\n";
    expect(parseAdrCommitments(content)).toEqual({
      hasSection: true,
      items: [],
    });
  });

  it("extracts mixed checked/unchecked items (`- [ ]` / `- [x]` / `- [X]`)", () => {
    const content = [
      "# Decision",
      "",
      "## Implementation commitments",
      "",
      "- [ ] Migrate call sites of foo()",
      "- [x] Update docs/cli-contract.md",
      "- [X] Add a regression test",
      "",
    ].join("\n");
    expect(parseAdrCommitments(content).items).toEqual([
      { text: "Migrate call sites of foo()", done: false },
      { text: "Update docs/cli-contract.md", done: true },
      { text: "Add a regression test", done: true },
    ]);
  });

  it("accepts `*` bullets as well as `-`", () => {
    const content =
      "## Implementation commitments\n\n* [ ] Star-bulleted item\n";
    expect(parseAdrCommitments(content).items).toEqual([
      { text: "Star-bulleted item", done: false },
    ]);
  });

  it("ignores non-checkbox prose inside the section", () => {
    const content = [
      "## Implementation commitments",
      "",
      "Some explanatory prose.",
      "- [ ] A real item",
      "- a plain bullet, not a checkbox",
      "",
    ].join("\n");
    expect(parseAdrCommitments(content).items).toEqual([
      { text: "A real item", done: false },
    ]);
  });

  it("handles CRLF line endings identically", () => {
    const content = "## Implementation commitments\r\n\r\n- [x] Done item\r\n";
    expect(parseAdrCommitments(content)).toEqual({
      hasSection: true,
      items: [{ text: "Done item", done: true }],
    });
  });

  it("stops at the next h2 (items after it are excluded)", () => {
    const content = [
      "## Implementation commitments",
      "- [ ] In section",
      "## Consequences",
      "- [ ] In a later section, not a commitment",
      "",
    ].join("\n");
    expect(parseAdrCommitments(content).items).toEqual([
      { text: "In section", done: false },
    ]);
  });

  it("matches the heading case-insensitively", () => {
    const content = "## implementation COMMITMENTS\n\n- [ ] item\n";
    expect(parseAdrCommitments(content)).toEqual({
      hasSection: true,
      items: [{ text: "item", done: false }],
    });
  });

  it("does NOT match an h3 `### Implementation commitments`", () => {
    const content = "### Implementation commitments\n\n- [ ] item\n";
    expect(parseAdrCommitments(content)).toEqual({
      hasSection: false,
      items: [],
    });
  });

  it("does NOT match a heading with trailing text after the title", () => {
    const content = "## Implementation commitments and more\n\n- [ ] item\n";
    expect(parseAdrCommitments(content)).toEqual({
      hasSection: false,
      items: [],
    });
  });

  it("tolerates leading whitespace before `##` (same h2 detection as the rest of the codebase)", () => {
    // Pins the current behavior: the heading/h2 regexes use `^\s*##` everywhere
    // (parseAdrStatus's siblings, plan-lint's ADR_H2_PATTERN), so a slightly
    // indented heading is still treated as the section.
    const content = "  ## Implementation commitments\n\n- [ ] item\n";
    expect(parseAdrCommitments(content)).toEqual({
      hasSection: true,
      items: [{ text: "item", done: false }],
    });
  });

  it("ignores a checkbox item with empty text (`- [ ] ` with nothing after)", () => {
    const content = "## Implementation commitments\n\n- [ ] \n- [ ] real\n";
    expect(parseAdrCommitments(content).items).toEqual([
      { text: "real", done: false },
    ]);
  });

  it("does not mistake a front-matter `status:` for body, and reads the body section", () => {
    const content =
      "---\nstatus: accepted\n---\n# T\n\n## Implementation commitments\n\n- [ ] item\n";
    expect(parseAdrCommitments(content)).toEqual({
      hasSection: true,
      items: [{ text: "item", done: false }],
    });
  });

  it("reads only the FIRST matching section", () => {
    const content = [
      "## Implementation commitments",
      "- [ ] first",
      "## Other",
      "## Implementation commitments",
      "- [ ] second",
      "",
    ].join("\n");
    expect(parseAdrCommitments(content).items).toEqual([
      { text: "first", done: false },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Nested decision gate tests — decision_refs pointing into subdirectories
// under design/decisions/. The namespace contract (DecisionRefPath) allows
// nested paths; the gate must resolve them identically to top-level refs.
// ---------------------------------------------------------------------------

describe("resolveDecisionGate — nested decision_refs", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "adr-nested-"));
    await mkdir(join(cwd, "design", "decisions", "sub"), { recursive: true });
    await mkdir(join(cwd, "design", "decisions", "deep", "path"), {
      recursive: true,
    });
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("nested accepted ref → resolved", async () => {
    await writeFile(
      join(cwd, "design", "decisions", "sub", "nested-accepted.md"),
      "**Status:** accepted (P1, 2026)\n",
    );
    const res = await resolveDecisionGate(cwd, "P1-T1", [
      "design/decisions/sub/nested-accepted.md",
    ]);
    expect(res.resolved).toBe(true);
    expect(res.via).toBe("decision_refs");
    expect(res.considered).toHaveLength(1);
    expect(res.considered[0]!.acceptance).toBe("accepted");
  });

  it("nested proposed ref → unresolved", async () => {
    await writeFile(
      join(cwd, "design", "decisions", "sub", "nested-proposed.md"),
      "**Status:** proposed\n",
    );
    const res = await resolveDecisionGate(cwd, "P1-T1", [
      "design/decisions/sub/nested-proposed.md",
    ]);
    expect(res.resolved).toBe(false);
    expect(res.considered[0]!.acceptance).toBe("blocked");
  });

  it("nested missing ref → unresolved, acceptance=missing", async () => {
    const res = await resolveDecisionGate(cwd, "P1-T1", [
      "design/decisions/sub/does-not-exist.md",
    ]);
    expect(res.resolved).toBe(false);
    expect(res.considered[0]!.acceptance).toBe("missing");
  });

  it("deeply nested accepted ref → resolved", async () => {
    await writeFile(
      join(cwd, "design", "decisions", "deep", "path", "deep-adr.md"),
      "**Status:** accepted (P1, 2026)\n",
    );
    const res = await resolveDecisionGate(cwd, "P1-T1", [
      "design/decisions/deep/path/deep-adr.md",
    ]);
    expect(res.resolved).toBe(true);
    expect(res.considered[0]!.acceptance).toBe("accepted");
  });

  it("mixed top-level accepted + nested accepted → resolved", async () => {
    await writeFile(
      join(cwd, "design", "decisions", "top.md"),
      "**Status:** accepted (P1, 2026)\n",
    );
    await writeFile(
      join(cwd, "design", "decisions", "sub", "nested.md"),
      "**Status:** accepted (P1, 2026)\n",
    );
    const res = await resolveDecisionGate(cwd, "P1-T1", [
      "design/decisions/top.md",
      "design/decisions/sub/nested.md",
    ]);
    expect(res.resolved).toBe(true);
  });

  it("mixed top-level accepted + nested proposed → unresolved (all-must-be-accepted)", async () => {
    await writeFile(
      join(cwd, "design", "decisions", "top.md"),
      "**Status:** accepted (P1, 2026)\n",
    );
    await writeFile(
      join(cwd, "design", "decisions", "sub", "nested.md"),
      "**Status:** proposed\n",
    );
    const res = await resolveDecisionGate(cwd, "P1-T1", [
      "design/decisions/top.md",
      "design/decisions/sub/nested.md",
    ]);
    expect(res.resolved).toBe(false);
  });

  it("same basename in different directories does not collide", async () => {
    await writeFile(
      join(cwd, "design", "decisions", "ADR-001.md"),
      "**Status:** accepted (P1, 2026)\n",
    );
    await writeFile(
      join(cwd, "design", "decisions", "sub", "ADR-001.md"),
      "**Status:** proposed\n",
    );
    const resTop = await resolveDecisionGate(cwd, "P1-T1", [
      "design/decisions/ADR-001.md",
    ]);
    expect(resTop.resolved).toBe(true);

    const resNested = await resolveDecisionGate(cwd, "P1-T1", [
      "design/decisions/sub/ADR-001.md",
    ]);
    expect(resNested.resolved).toBe(false);
    expect(resNested.considered[0]!.acceptance).toBe("blocked");
  });

  it("nested README.md ref → unsafe_path (not a decision record)", async () => {
    await writeFile(
      join(cwd, "design", "decisions", "sub", "README.md"),
      "# Index\n",
    );
    const res = await resolveDecisionGate(cwd, "P1-T1", [
      "design/decisions/sub/README.md",
    ]);
    expect(res.resolved).toBe(false);
    expect(res.considered[0]!.acceptance).toBe("unsafe_path");
  });
});

// ---------------------------------------------------------------------------
// Nested quality scan tests — classifyDecisionAdrs on nested subdirectories.
// Pins that nested ADRs get the same quality classification as top-level ones.
// ---------------------------------------------------------------------------

describe("classifyDecisionAdrs — nested quality scan", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "adr-nested-quality-"));
    await mkdir(join(cwd, "design", "decisions", "sub"), { recursive: true });
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("nested ADR with unknown status is reported as unknown_status", async () => {
    await writeFile(
      join(cwd, "design", "decisions", "sub", "typo.md"),
      "**Status:** acceptd\n",
    );
    const results = await classifyDecisionAdrs(cwd);
    const entry = results.find(r => r.file === "design/decisions/sub/typo.md");
    expect(entry).toBeDefined();
    expect(entry!.acceptance).toBe("unknown_status");
  });

  it("nested accepted ADR with empty commitments is reported", async () => {
    await writeFile(
      join(cwd, "design", "decisions", "sub", "thin.md"),
      "**Status:** accepted (P1, 2026)\n\n## Decision\n\nSettled.\n",
    );
    const results = await classifyDecisionAdrs(cwd);
    const entry = results.find(r => r.file === "design/decisions/sub/thin.md");
    expect(entry).toBeDefined();
    expect(entry!.acceptance).toBe("accepted");
  });

  it("nested accepted thin ADR (status only, no body) is reported as accepted", async () => {
    await writeFile(
      join(cwd, "design", "decisions", "sub", "minimal.md"),
      "**Status:** accepted\n",
    );
    const results = await classifyDecisionAdrs(cwd);
    const entry = results.find(
      r => r.file === "design/decisions/sub/minimal.md",
    );
    expect(entry).toBeDefined();
    expect(entry!.acceptance).toBe("accepted");
  });

  it("nested README.md variants are never classified as decision records", async () => {
    await writeFile(
      join(cwd, "design", "decisions", "sub", "README.md"),
      "# Index\n",
    );
    await writeFile(
      join(cwd, "design", "decisions", "sub", "readme.md"),
      "# Index lowercase\n",
    );
    const results = await classifyDecisionAdrs(cwd);
    expect(
      results.find(r => r.file === "design/decisions/sub/README.md"),
    ).toBeUndefined();
    expect(
      results.find(r => r.file === "design/decisions/sub/readme.md"),
    ).toBeUndefined();
  });

  it("same basename in two directories remains distinct", async () => {
    await mkdir(join(cwd, "design", "decisions", "other"), { recursive: true });
    await writeFile(
      join(cwd, "design", "decisions", "sub", "dup.md"),
      "**Status:** accepted\n",
    );
    await writeFile(
      join(cwd, "design", "decisions", "other", "dup.md"),
      "**Status:** proposed\n",
    );
    const results = await classifyDecisionAdrs(cwd);
    const subEntry = results.find(
      r => r.file === "design/decisions/sub/dup.md",
    );
    const otherEntry = results.find(
      r => r.file === "design/decisions/other/dup.md",
    );
    expect(subEntry).toBeDefined();
    expect(otherEntry).toBeDefined();
    expect(subEntry!.acceptance).toBe("accepted");
    expect(otherEntry!.acceptance).toBe("blocked");
  });
});

// ---------------------------------------------------------------------------
// Nested filename-scan tests — the gate resolves via substring basename match
// (no explicit decision_refs) on nested subdirectory paths. Pins that nested
// ADRs are first-class filename-scan candidates, not just explicit-ref targets.
// ---------------------------------------------------------------------------

describe("resolveDecisionGate — nested filename-scan", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "adr-nested-scan-"));
    await mkdir(join(cwd, "design", "decisions", "sub"), { recursive: true });
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("nested accepted ADR matching task id via filename-scan → resolved", async () => {
    await writeFile(
      join(cwd, "design", "decisions", "sub", "P1-T1-rfc.md"),
      "**Status:** accepted (P1, 2026)\n",
    );
    const res = await resolveDecisionGate(cwd, "P1-T1", undefined);
    expect(res.resolved).toBe(true);
    expect(res.via).toBe("filename-scan");
    expect(res.considered).toHaveLength(1);
    expect(res.considered[0]!.acceptance).toBe("accepted");
    expect(res.considered[0]!.path).toBe("design/decisions/sub/P1-T1-rfc.md");
  });

  it("nested proposed ADR matching task id via filename-scan → unresolved (blocked)", async () => {
    await writeFile(
      join(cwd, "design", "decisions", "sub", "P1-T1-rfc.md"),
      "**Status:** proposed\n",
    );
    const res = await resolveDecisionGate(cwd, "P1-T1", undefined);
    expect(res.resolved).toBe(false);
    expect(res.via).toBe("filename-scan");
    expect(res.considered[0]!.acceptance).toBe("blocked");
  });

  it("nested ADR not matching task id → not considered (no false positive)", async () => {
    await writeFile(
      join(cwd, "design", "decisions", "sub", "P2-T3-other.md"),
      "**Status:** accepted (P2, 2026)\n",
    );
    const res = await resolveDecisionGate(cwd, "P1-T1", undefined);
    expect(res.resolved).toBe(false);
    expect(res.considered).toHaveLength(0);
  });

  it("deeply nested accepted ADR matching task id → resolved", async () => {
    await mkdir(join(cwd, "design", "decisions", "deep", "path"), {
      recursive: true,
    });
    await writeFile(
      join(cwd, "design", "decisions", "deep", "path", "P1-T1-deep.md"),
      "**Status:** accepted (P1, 2026)\n",
    );
    const res = await resolveDecisionGate(cwd, "P1-T1", undefined);
    expect(res.resolved).toBe(true);
    expect(res.via).toBe("filename-scan");
  });

  it("mixed top-level + nested both matching → resolved (any accepted)", async () => {
    await writeFile(
      join(cwd, "design", "decisions", "P1-T1-top.md"),
      "**Status:** proposed\n",
    );
    await writeFile(
      join(cwd, "design", "decisions", "sub", "P1-T1-nested.md"),
      "**Status:** accepted (P1, 2026)\n",
    );
    const res = await resolveDecisionGate(cwd, "P1-T1", undefined);
    expect(res.resolved).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Directory-list error propagation — an unreadable design/decisions/ directory
// (EACCES, not ENOENT/ENOTDIR) must throw DECISION_SCAN_UNREADABLE, not be
// silently swallowed as "no decisions".
// ---------------------------------------------------------------------------

describe("listLiveDecisionFiles — directory-list EACCES → DECISION_SCAN_UNREADABLE", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "adr-eacces-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  const permissionDenied = (): NodeJS.ErrnoException =>
    Object.assign(new Error("permission denied"), { code: "EACCES" });

  it("EACCES on design/decisions/ → throws with DECISION_SCAN_UNREADABLE", async () => {
    await mkdir(join(cwd, "design", "decisions"), { recursive: true });
    const listFn: DecisionDirLister = async () => {
      throw permissionDenied();
    };

    await expect(readLiveDecisionDir(cwd, listFn)).rejects.toMatchObject({
      code: "DECISION_SCAN_UNREADABLE",
    });
  });

  it("EACCES on a nested subdirectory → throws with DECISION_SCAN_UNREADABLE", async () => {
    await mkdir(join(cwd, "design", "decisions", "sub"), { recursive: true });
    await writeFile(
      join(cwd, "design", "decisions", "sub", "P1-T1.md"),
      "**Status:** accepted\n",
    );
    const listFn: DecisionDirLister = async path => {
      if (basename(String(path)) === "sub") {
        throw permissionDenied();
      }
      return readdir(String(path), { withFileTypes: true });
    };

    await expect(readLiveDecisionDir(cwd, listFn)).rejects.toMatchObject({
      code: "DECISION_SCAN_UNREADABLE",
    });
  });

  it("DECISION_SCAN_UNREADABLE propagates through resolveDecisionGate (filename-scan)", async () => {
    await mkdir(join(cwd, "design", "decisions"), { recursive: true });
    const listFn: DecisionDirLister = async () => {
      throw permissionDenied();
    };

    const result = await resolveDecisionGate(cwd, "P1-T1", undefined, listFn);
    expect(result.resolved).toBe(false);
    expect(result.reason).toContain("DECISION_SCAN_UNREADABLE");
  });
});
