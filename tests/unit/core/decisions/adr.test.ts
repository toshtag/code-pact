import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readDecisionAdrFiles,
  hasDecisionAdrForTaskId,
  isAbsentDecisionsDirError,
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
