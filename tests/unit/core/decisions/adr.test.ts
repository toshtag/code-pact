import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readDecisionAdrFiles,
  hasDecisionAdrForTaskId,
  isAbsentDecisionsDirError,
  isDecisionRequiredForTask,
  parseAdrStatus,
  classifyAdr,
  resolveDecisionGate,
  makeDecisionResolver,
} from "../../../../src/core/decisions/adr.ts";

describe("hasDecisionAdrForTaskId", () => {
  it("matches a .md whose name includes the task id", () => {
    expect(hasDecisionAdrForTaskId(["P1-T1-decision.md"], "P1-T1")).toBe(true);
  });

  it("ignores non-.md files", () => {
    expect(hasDecisionAdrForTaskId(["P1-T1-decision.txt"], "P1-T1")).toBe(false);
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

  it("returns the decision filenames when the directory exists", async () => {
    await mkdir(join(cwd, "design", "decisions"), { recursive: true });
    await writeFile(join(cwd, "design", "decisions", "P1-T1-rfc.md"), "x");
    expect(await readDecisionAdrFiles(cwd)).toContain("P1-T1-rfc.md");
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
    expect(isDecisionRequiredForTask({}, { requires_decision: true })).toBe(true);
  });
  it("is true when the phase requires a decision (parity with verify)", () => {
    expect(isDecisionRequiredForTask({ requires_decision: true }, {})).toBe(true);
  });
  it("is false when neither does", () => {
    expect(isDecisionRequiredForTask({}, {})).toBe(false);
    expect(
      isDecisionRequiredForTask({ requires_decision: false }, { requires_decision: false }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Status-aware resolution (RFC §3-C)
// ---------------------------------------------------------------------------

describe("parseAdrStatus", () => {
  it("reads the bold-line status, stripping a glued paren/comma", () => {
    expect(parseAdrStatus("# T\n\n**Status:** accepted (P16, 2026-05)\n")).toEqual({
      word: "accepted",
      source: "bold-line",
    });
  });

  it("is case-insensitive on both the label and the word", () => {
    expect(parseAdrStatus("**status:** Proposed\n").word).toBe("proposed");
  });

  it("handles CRLF line endings", () => {
    expect(parseAdrStatus("# T\r\n\r\n**Status:** proposed\r\n").word).toBe("proposed");
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
    expect(parseAdrStatus(content)).toEqual({ word: "proposed", source: "frontmatter" });
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
    expect(classifyAdr("**Status:** accepted (P1, 2026)\n").acceptance).toBe("accepted");
  });

  it("each blocking status → blocked", () => {
    for (const w of ["proposed", "draft", "rejected", "superseded"]) {
      expect(classifyAdr(`**Status:** ${w}\n`).acceptance).toBe("blocked");
    }
  });

  it("explicit UNKNOWN status (typo) → unknown_status (does NOT resolve)", () => {
    expect(classifyAdr("**Status:** acceptd\n").acceptance).toBe("unknown_status");
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
    expect(res.reason).toBe('No ADR found for task "P1-T1" in design/decisions/');
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
    const missing = res.considered.find((c) => c.path.endsWith("gone.md"));
    expect(missing?.acceptance).toBe("missing");
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
