import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const scriptPath = join(repoRoot, "scripts", "check-fs-authority.mjs");

async function runFixture(lines: string[]): Promise<{
  ok: boolean;
  output: string;
}> {
  const dir = await mkdtemp(join(repoRoot, "tests", "tmp-fs-authority-"));
  const target = join(dir, "probe.ts");
  await writeFile(target, lines.join("\n"), "utf8");
  try {
    await execFileAsync("node", [scriptPath, target], { cwd: repoRoot });
    return { ok: true, output: "" };
  } catch (err) {
    return {
      ok: false,
      output: `${(err as { stdout?: string }).stdout ?? ""}\n${
        (err as { stderr?: string }).stderr ?? ""
      }`,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("check-fs-authority", () => {
  it("does not let a later same-name authority variable bless an earlier unsafe sink", async () => {
    const dir = await mkdtemp(join(tmpdir(), "code-pact-fs-authority-"));
    const target = join(dir, "probe.ts");
    await writeFile(
      target,
      [
        'import { stat } from "node:fs/promises";',
        'import { resolveSymlinkFreeProjectPath } from "../src/core/path-safety.ts";',
        "",
        "type AgentProfile = { instruction_filename: string };",
        "",
        "async function unsafe(profile: AgentProfile): Promise<void> {",
        "  const alias = profile.instruction_filename;",
        "  await stat(alias);",
        "}",
        "",
        "async function safeLater(cwd: string): Promise<void> {",
        '  const alias = await resolveSymlinkFreeProjectPath(cwd, "CLAUDE.md");',
        "  await stat(alias);",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    try {
      await execFileAsync("node", [scriptPath, target]);
      throw new Error("check-fs-authority unexpectedly passed");
    } catch (err) {
      const output = `${(err as { stdout?: string }).stdout ?? ""}\n${
        (err as { stderr?: string }).stderr ?? ""
      }`;
      expect(output).toContain("stat() called on non-authority path");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects branch state where any path can remain unauthorized", async () => {
    const result = await runFixture([
      'import { stat } from "node:fs/promises";',
      'import { resolveSymlinkFreeProjectPath } from "../../src/core/path-safety.ts";',
      "",
      "async function f(profile: any, cwd: string, cond: boolean) {",
      "  let p: string;",
      "  if (cond) {",
      "    p = profile.instruction_filename;",
      "  } else {",
      '    p = await resolveSymlinkFreeProjectPath(cwd, "CLAUDE.md");',
      "  }",
      "  await stat(p);",
      "}",
      "",
    ]);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("stat() called on non-authority path");
  });

  it("does not trust a same-name local resolver", async () => {
    const result = await runFixture([
      'import { stat } from "node:fs/promises";',
      "",
      "async function resolveSymlinkFreeProjectPath(_cwd: string, path: string) {",
      "  return path;",
      "}",
      "",
      "async function f(profile: any, cwd: string) {",
      "  await stat(await resolveSymlinkFreeProjectPath(cwd, profile.instruction_filename));",
      "}",
      "",
    ]);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("stat() called on non-authority path");
  });

  it("rejects unsafe reassignment after an authorized assignment", async () => {
    const result = await runFixture([
      'import { readdir } from "node:fs/promises";',
      'import { resolveSymlinkFreeProjectPath } from "../../src/core/path-safety.ts";',
      "",
      "async function f(profile: any, cwd: string) {",
      '  let p = await resolveSymlinkFreeProjectPath(cwd, "CLAUDE.md");',
      "  p = profile.hook_dir;",
      "  await readdir(p);",
      "}",
      "",
    ]);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("readdir() called on non-authority path");
  });

  it("rejects arbitrary object absPath properties", async () => {
    const result = await runFixture([
      'import { stat } from "node:fs/promises";',
      "",
      "async function f(profile: any) {",
      "  await stat({ absPath: profile.instruction_filename }.absPath);",
      "}",
      "",
    ]);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("stat() called on non-authority path");
  });

  it("rejects switch branch bypass — unauthorized case persists", async () => {
    const result = await runFixture([
      'import { stat } from "node:fs/promises";',
      'import { resolveSymlinkFreeProjectPath } from "../../src/core/path-safety.ts";',
      "",
      "async function f(profile: any, cwd: string, mode: string) {",
      "  let p: string;",
      "  switch (mode) {",
      '    case "safe":',
      '      p = await resolveSymlinkFreeProjectPath(cwd, "CLAUDE.md");',
      "      break;",
      "    default:",
      "      p = profile.instruction_filename;",
      "      break;",
      "  }",
      "  await stat(p);",
      "}",
      "",
    ]);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("stat() called on non-authority path");
  });

  it("rejects non-path helper confusion — function returning boolean treated as authority", async () => {
    const result = await runFixture([
      'import { stat } from "node:fs/promises";',
      'import { resolveSymlinkFreeProjectPath } from "../../src/core/path-safety.ts";',
      "",
      "async function isSafe(_cwd: string, _path: string): Promise<boolean> {",
      "  return true;",
      "}",
      "",
      "async function f(profile: any, cwd: string) {",
      "  const safe = await isSafe(cwd, profile.instruction_filename);",
      "  if (safe) {",
      "    await stat(profile.instruction_filename);",
      "  }",
      "}",
      "",
    ]);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("stat() called on non-authority path");
  });
});
