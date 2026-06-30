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

  it("rejects semantic containment bypass through the generic resolver", async () => {
    const result = await runFixture([
      'import { stat } from "node:fs/promises";',
      'import { resolveSymlinkFreeProjectPath } from "../../src/core/path-safety.ts";',
      "",
      "async function f(profile: any, cwd: string) {",
      "  const p = await resolveSymlinkFreeProjectPath(cwd, profile.instruction_filename);",
      "  await stat(p);",
      "}",
      "",
    ]);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("stat() called on non-authority path");
  });

  it("allows a domain resolver that grants owned read authority", async () => {
    const result = await runFixture([
      'import { stat } from "node:fs/promises";',
      'import { resolveAgentProfilePath } from "../../src/core/agent-profile-path.ts";',
      "",
      "async function f(cwd: string) {",
      '  const p = await resolveAgentProfilePath(cwd, "claude-code");',
      "  await stat(p);",
      "}",
      "",
    ]);
    expect(result.ok).toBe(true);
  });

  it("rejects using read-authority object paths for write sinks", async () => {
    const result = await runFixture([
      'import { writeFile } from "node:fs/promises";',
      'import { classifyManifestFileForRead } from "../../src/core/adapters/manifest-file-ownership.ts";',
      "",
      "async function f(cwd: string, descriptor: any) {",
      '  const ownership = await classifyManifestFileForRead(cwd, descriptor, "CLAUDE.md", "instruction");',
      '  if (ownership.kind === "owned") {',
      '    await writeFile(ownership.absPath, "bad");',
      "  }",
      "}",
      "",
    ]);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("writeFile() called on non-authority path");
  });

  it("allows mutation-authority object paths for write sinks", async () => {
    const result = await runFixture([
      'import { writeFile } from "node:fs/promises";',
      'import { authorizeAdapterMutationPath } from "../../src/core/adapters/manifest-file-ownership.ts";',
      "",
      "async function f(cwd: string, descriptor: any) {",
      '  const ownership = await authorizeAdapterMutationPath(cwd, descriptor, "CLAUDE.md", { expectedRole: "instruction", allowDynamicWrite: false });',
      '  if (ownership.kind === "owned") {',
      '    await writeFile(ownership.absPath, "ok");',
      "  }",
      "}",
      "",
    ]);
    expect(result.ok).toBe(true);
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

  it("does not trust an imported resolver shadowed by a parameter", async () => {
    const result = await runFixture([
      'import { stat } from "node:fs/promises";',
      'import { resolveSymlinkFreeProjectPath } from "../../src/core/path-safety.ts";',
      "",
      "async function f(resolveSymlinkFreeProjectPath: any, cwd: string, profile: any) {",
      "  const p = await resolveSymlinkFreeProjectPath(cwd, profile.instruction_filename);",
      "  await stat(p);",
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

  it("rejects non-path helper confusion from authorized content readers", async () => {
    const result = await runFixture([
      'import { stat } from "node:fs/promises";',
      'import { readAuthorizedRegularFileMaybe } from "../../src/core/adapters/file-state.ts";',
      "",
      "async function f(absPath: string) {",
      '  const value = await readAuthorizedRegularFileMaybe(absPath, "CLAUDE.md");',
      "  if (value !== null) {",
      "    await stat(value);",
      "  }",
      "}",
      "",
    ]);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("stat() called on non-authority path");
  });

  it("rejects resolveWithinProject as containment-only authority", async () => {
    const result = await runFixture([
      'import { stat } from "node:fs/promises";',
      'import { resolveWithinProject } from "../../src/core/path-safety.ts";',
      "",
      "async function f(profile: any, cwd: string) {",
      "  const p = await resolveWithinProject(cwd, profile.instruction_filename);",
      "  await stat(p);",
      "}",
      "",
    ]);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("stat() called on non-authority path");
  });

  it("rejects generic resolveOwnedReadPath as semantic authority", async () => {
    const result = await runFixture([
      'import { readFile } from "node:fs/promises";',
      'import { resolveOwnedReadPath } from "../../src/core/project-fs/owned-read.ts";',
      "",
      "async function f(profile: any, cwd: string) {",
      "  const p = await resolveOwnedReadPath(cwd, profile.instruction_filename);",
      '  await readFile(p, "utf8");',
      "}",
      "",
    ]);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("readFile() called on non-authority path");
  });

  it("intersects branch capabilities so read/write merge cannot write", async () => {
    const result = await runFixture([
      'import { writeFile } from "node:fs/promises";',
      'import { resolveAgentProfilePath, resolveOwnedAgentProfilePath } from "../../src/core/agent-profile-path.ts";',
      "",
      "async function f(cwd: string, cond: boolean) {",
      "  let p: string;",
      "  if (cond) {",
      '    p = await resolveOwnedAgentProfilePath(cwd, "claude-code");',
      "  } else {",
      '    p = await resolveAgentProfilePath(cwd, "claude-code");',
      "  }",
      '  await writeFile(p, "x");',
      "}",
      "",
    ]);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("writeFile() called on non-authority path");
  });

  it("checks rename destination authority separately", async () => {
    const result = await runFixture([
      'import { rename } from "node:fs/promises";',
      'import { resolveOwnedAgentProfilePath } from "../../src/core/agent-profile-path.ts";',
      "",
      "async function f(cwd: string, profile: any) {",
      '  const src = await resolveOwnedAgentProfilePath(cwd, "claude-code");',
      "  await rename(src, profile.instruction_filename);",
      "}",
      "",
    ]);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("rename() called on non-authority path");
  });

  it("does not exempt nested functions that reuse trusted import names", async () => {
    const result = await runFixture([
      'import { readFile } from "node:fs/promises";',
      'import { resolveAgentProfilePath } from "../../src/core/agent-profile-path.ts";',
      "",
      "async function outer(profile: any) {",
      "  async function resolveAgentProfilePath() {",
      '    await readFile(profile.instruction_filename, "utf8");',
      "  }",
      "  await resolveAgentProfilePath();",
      "}",
      "",
    ]);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("readFile() called on non-authority path");
  });

  it("rejects symlink as a filesystem sink", async () => {
    const result = await runFixture([
      'import { symlink } from "node:fs/promises";',
      "",
      "async function f(profile: any) {",
      '  await symlink("/etc/passwd", profile.instruction_filename);',
      "}",
      "",
    ]);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("symlink() called on non-authority path");
  });

  it("allows rename and copy when both path arguments have authority", async () => {
    const result = await runFixture([
      'import { copyFile, rename } from "node:fs/promises";',
      'import { resolveOwnedAgentProfilePath } from "../../src/core/agent-profile-path.ts";',
      "",
      "async function f(cwd: string) {",
      '  const src = await resolveOwnedAgentProfilePath(cwd, "claude-code");',
      '  const dst = await resolveOwnedAgentProfilePath(cwd, "codex");',
      "  await copyFile(src, dst);",
      "  await rename(src, dst);",
      "}",
      "",
    ]);
    expect(result.ok).toBe(true);
  });

  it("rejects unsafe reassignment inside a loop after an authorized assignment", async () => {
    const result = await runFixture([
      'import { writeFile } from "node:fs/promises";',
      'import { resolveOwnedAgentProfilePath } from "../../src/core/agent-profile-path.ts";',
      "",
      "async function f(cwd: string, profile: any, items: string[]) {",
      '  let p = await resolveOwnedAgentProfilePath(cwd, "claude-code");',
      "  for (const _item of items) {",
      "    p = profile.instruction_filename;",
      "  }",
      '  await writeFile(p, "x");',
      "}",
      "",
    ]);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("writeFile() called on non-authority path");
  });

  it("rejects switch without default because the original scope remains reachable", async () => {
    const result = await runFixture([
      'import { writeFile } from "node:fs/promises";',
      'import { resolveOwnedAgentProfilePath } from "../../src/core/agent-profile-path.ts";',
      "",
      "async function f(cwd: string, profile: any, mode: string) {",
      "  let p = profile.instruction_filename;",
      "  switch (mode) {",
      '    case "safe":',
      '      p = await resolveOwnedAgentProfilePath(cwd, "claude-code");',
      "      break;",
      "  }",
      '  await writeFile(p, "x");',
      "}",
      "",
    ]);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("writeFile() called on non-authority path");
  });

  it("rejects sync filesystem APIs", async () => {
    const result = await runFixture([
      'import { readFileSync, writeFileSync } from "node:fs";',
      "",
      "function f(profile: any) {",
      '  readFileSync(profile.instruction_filename, "utf8");',
      '  writeFileSync(profile.instruction_filename, "x");',
      "}",
      "",
    ]);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("readFileSync() called on non-authority path");
    expect(result.output).toContain("writeFileSync() called on non-authority path");
  });

  it("treats numeric open write flags as write authority", async () => {
    const result = await runFixture([
      'import { open } from "node:fs/promises";',
      'import { resolveAgentProfilePath } from "../../src/core/agent-profile-path.ts";',
      "",
      "async function f(cwd: string) {",
      '  const p = await resolveAgentProfilePath(cwd, "claude-code");',
      "  await open(p, 1);",
      "}",
      "",
    ]);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("open() called on non-authority path");
  });

  it("rejects dynamic open flags", async () => {
    const result = await runFixture([
      'import { open } from "node:fs/promises";',
      'import { resolveAgentProfilePath } from "../../src/core/agent-profile-path.ts";',
      "",
      "async function f(cwd: string, flags: string) {",
      '  const p = await resolveAgentProfilePath(cwd, "claude-code");',
      "  await open(p, flags);",
      "}",
      "",
    ]);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("open() called on non-authority path");
  });

  it("rejects direct OwnedPath casts", async () => {
    const result = await runFixture([
      'import { writeFile } from "node:fs/promises";',
      'import type { OwnedWritePath } from "../../src/core/project-fs/branded-paths.ts";',
      "",
      "async function f(profile: any) {",
      "  const p = profile.instruction_filename as OwnedWritePath;",
      '  await writeFile(p, "x");',
      "}",
      "",
    ]);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("direct OwnedPath cast");
  });

  it("rejects brand constructor imports from domain modules", async () => {
    const result = await runFixture([
      'import { brandOwnedWrite } from "../../src/core/project-fs/branded-paths.ts";',
      "",
      "function f(profile: any) {",
      "  return brandOwnedWrite(profile.instruction_filename);",
      "}",
      "",
    ]);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("brand constructor import");
  });
});
