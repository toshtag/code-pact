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
const containedReadResolver = "resolveContained" + "ReadPath";
const containedWriteResolver = "resolveContained" + "WritePath";
const containedDeleteResolver = "resolveContained" + "DeletePath";

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

async function runFixtureUnder(
  relDir: string,
  lines: string[],
): Promise<{
  ok: boolean;
  output: string;
}> {
  const dir = await mkdtemp(join(repoRoot, relDir, "tmp-fs-authority-"));
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
  it("rejects raw fs wildcard re-exports", async () => {
    const result = await runFixture(['export * from "node:fs/promises";', ""]);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("raw fs wildcard re-export");
  });

  it("rejects raw-internal wildcard re-exports", async () => {
    const result = await runFixture([
      'export * from "../../src/core/project-fs/raw-internal.ts";',
      "",
    ]);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("raw-internal wildcard re-export");
  });

  it("rejects namespace imports of brand constructors", async () => {
    const result = await runFixture([
      'import * as brands from "../../src/core/project-fs/branded-paths-internal.ts";',
      'import { readOwnedText } from "../../src/core/project-fs/index.ts";',
      "",
      "async function leak(path: string) {",
      "  return readOwnedText(brands.brandOwnedRead(path));",
      "}",
      "",
    ]);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("brand constructor namespace import");
  });

  it("rejects generic contained read/write/delete resolver fixtures", async () => {
    const read = await runFixture([
      `import { ${containedReadResolver}, readOwnedText } from "../../src/core/project-fs/index.ts";`,
      "",
      "async function leak(cwd: string, userPath: string) {",
      `  return readOwnedText(await ${containedReadResolver}(cwd, userPath));`,
      "}",
      "",
    ]);
    expect(read.ok).toBe(false);
    expect(read.output).toContain(
      "readOwnedText() called on non-authority path",
    );

    const write = await runFixture([
      `import { ${containedWriteResolver}, writeOwnedText } from "../../src/core/project-fs/index.ts";`,
      "",
      "async function overwrite(cwd: string, userPath: string) {",
      `  await writeOwnedText(await ${containedWriteResolver}(cwd, userPath), "owned");`,
      "}",
      "",
    ]);
    expect(write.ok).toBe(false);
    expect(write.output).toContain(
      "writeOwnedText() called on non-authority path",
    );

    const del = await runFixture([
      `import { ${containedDeleteResolver}, unlinkOwned } from "../../src/core/project-fs/index.ts";`,
      "",
      "async function erase(cwd: string, userPath: string) {",
      `  await unlinkOwned(await ${containedDeleteResolver}(cwd, userPath));`,
      "}",
      "",
    ]);
    expect(del.ok).toBe(false);
    expect(del.output).toContain("unlinkOwned() called on non-authority path");
  }, 10_000);

  it("rejects read authority passed to delete and write-open operations", async () => {
    const removedWriteOpen = "openOwned" + "Write";
    const del = await runFixture([
      'import { resolveProjectConfigReadPath, unlinkOwned } from "../../src/core/project-fs/index.ts";',
      "",
      "async function eraseConfig(cwd: string) {",
      "  await unlinkOwned(await resolveProjectConfigReadPath(cwd));",
      "}",
      "",
    ]);
    expect(del.ok).toBe(false);
    expect(del.output).toContain("unlinkOwned() called on non-authority path");

    const writeOpen = await runFixture([
      `import { resolveProjectConfigReadPath, ${removedWriteOpen} } from "../../src/core/project-fs/index.ts";`,
      "",
      "async function truncate(cwd: string) {",
      `  await ${removedWriteOpen}(await resolveProjectConfigReadPath(cwd), "r");`,
      "}",
      "",
    ]);
    expect(writeOpen.ok).toBe(false);
    expect(writeOpen.output).toContain(
      "forbidden public filesystem API import() called",
    );
  });

  it("rejects operation authority escalation through same-domain thin wrappers", async () => {
    const writeToRead = await runFixtureUnder("src/core/adapters", [
      'import { readOwnedText } from "../../project-fs/operations.ts";',
      'import { adapterReadPath } from "../../project-fs/authorities/adapter-authority.ts";',
      'import type { OwnedWritePath } from "../../project-fs/branded-paths.ts";',
      "",
      "async function leak(path: OwnedWritePath) {",
      "  return readOwnedText(adapterReadPath(path));",
      "}",
      "",
    ]);
    expect(writeToRead.ok).toBe(false);
    expect(writeToRead.output).toContain(
      "readOwnedText() called on non-authority path",
    );

    const writeToDelete = await runFixtureUnder("src/core/adapters", [
      'import { unlinkOwned } from "../../project-fs/operations.ts";',
      'import { adapterDeletePath } from "../../project-fs/authorities/adapter-authority.ts";',
      'import type { OwnedWritePath } from "../../project-fs/branded-paths.ts";',
      "",
      "async function erase(path: OwnedWritePath) {",
      "  await unlinkOwned(adapterDeletePath(path));",
      "}",
      "",
    ]);
    expect(writeToDelete.ok).toBe(false);
    expect(writeToDelete.output).toContain(
      "unlinkOwned() called on non-authority path",
    );

    const deleteToRead = await runFixtureUnder("src/core/adapters", [
      'import { readOwnedText } from "../../project-fs/operations.ts";',
      'import { adapterReadPath } from "../../project-fs/authorities/adapter-authority.ts";',
      'import type { OwnedDeletePath } from "../../project-fs/branded-paths.ts";',
      "",
      "async function leak(path: OwnedDeletePath) {",
      "  return readOwnedText(adapterReadPath(path));",
      "}",
      "",
    ]);
    expect(deleteToRead.ok).toBe(false);
    expect(deleteToRead.output).toContain(
      "readOwnedText() called on non-authority path",
    );
  });

  it("rejects renamed generic project authority from content read and owned write sinks", async () => {
    const projectProbeRead = await runFixtureUnder("src/core/pack", [
      'import { readOwnedText } from "../../project-fs/index.ts";',
      'import { resolveProjectProbeReadPath } from "../../project-fs/authorities/project-config-authority.ts";',
      "",
      "async function leak(cwd: string, userPath: string) {",
      "  return readOwnedText(await resolveProjectProbeReadPath(cwd, userPath));",
      "}",
      "",
    ]);
    expect(projectProbeRead.ok).toBe(false);
    expect(projectProbeRead.output).toContain(
      "readOwnedText() called on non-authority path",
    );

    const explicitOutputOwnedWrite = await runFixtureUnder("src/core/pack", [
      'import { writeOwnedText } from "../../project-fs/index.ts";',
      'import { resolveExplicitProjectContextOutputWritePath } from "../../project-fs/authorities/context-output-authority.ts";',
      "",
      "async function overwrite(cwd: string, userPath: string) {",
      '  await writeOwnedText(await resolveExplicitProjectContextOutputWritePath(cwd, userPath), "x");',
      "}",
      "",
    ]);
    expect(explicitOutputOwnedWrite.ok).toBe(false);
    expect(explicitOutputOwnedWrite.output).toContain(
      "writeOwnedText() called on non-authority path",
    );
  });

  it("allows explicit-output and project-presence capabilities only at their narrow sinks", async () => {
    const explicitOutput = await runFixtureUnder("src/core/pack", [
      'import { atomicWriteText } from "../../../io/atomic-text.ts";',
      'import { resolveExplicitProjectContextOutputWritePath } from "../../project-fs/authorities/context-output-authority.ts";',
      "",
      "async function writePack(cwd: string, userPath: string) {",
      '  await atomicWriteText(await resolveExplicitProjectContextOutputWritePath(cwd, userPath), "x");',
      "}",
      "",
    ]);
    expect(explicitOutput.ok).toBe(true);

    const projectPresence = await runFixtureUnder("src/core/plan/checks", [
      'import { accessProjectPresence } from "../../../project-fs/operations.ts";',
      'import { resolveProjectProbeReadPath } from "../../../project-fs/authorities/project-config-authority.ts";',
      "",
      "async function probe(cwd: string, userPath: string) {",
      "  await accessProjectPresence(await resolveProjectProbeReadPath(cwd, userPath));",
      "}",
      "",
    ]);
    expect(projectPresence.ok).toBe(true);
  });

  it("allows same-domain thin wrappers from containment proof", async () => {
    const result = await runFixtureUnder("src/core/adapters", [
      'import { writeOwnedText } from "../../project-fs/operations.ts";',
      'import { adapterWritePath } from "../../project-fs/authorities/adapter-authority.ts";',
      'import { resolveSymlinkFreeProjectPath } from "../../path-safety.ts";',
      "",
      "async function writeGenerated(cwd: string) {",
      '  await writeOwnedText(adapterWritePath(await resolveSymlinkFreeProjectPath(cwd, "CLAUDE.md")), "x");',
      "}",
      "",
    ]);
    expect(result.ok).toBe(true);
  });

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
      'import { statOwned } from "../../src/core/project-fs/index.ts";',
      'import { resolveAgentProfilePath } from "../../src/core/agent-profile-path.ts";',
      "",
      "async function f(cwd: string) {",
      '  const p = await resolveAgentProfilePath(cwd, "claude-code");',
      "  await statOwned(p);",
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
      'import { writeOwnedText } from "../../src/core/project-fs/index.ts";',
      'import { authorizeAdapterMutationPath } from "../../src/core/adapters/manifest-file-ownership.ts";',
      "",
      "async function f(cwd: string, descriptor: any) {",
      '  const ownership = await authorizeAdapterMutationPath(cwd, descriptor, "CLAUDE.md", { expectedRole: "instruction", allowDynamicWrite: false });',
      '  if (ownership.kind === "owned") {',
      '    await writeOwnedText(ownership.absPath, "ok");',
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

  it("rejects a generic symlink-free read candidate as semantic authority", async () => {
    const result = await runFixture([
      'import { readFile } from "node:fs/promises";',
      'import { resolveSymlinkFreeProjectPath } from "../../src/core/path-safety.ts";',
      "",
      "async function resolveSymlinkFreeReadCandidate(cwd: string, relPath: string) {",
      "  return resolveSymlinkFreeProjectPath(cwd, relPath);",
      "}",
      "",
      "async function f(profile: any, cwd: string) {",
      "  const p = await resolveSymlinkFreeReadCandidate(cwd, profile.instruction_filename);",
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
      'import { copyOwnedToOwned, renameOwned, resolveProgressDeletePath, resolveProgressReadPath, resolveProgressWritePath } from "../../src/core/project-fs/index.ts";',
      'import { resolveAgentProfilePath, resolveOwnedAgentProfilePath } from "../../src/core/agent-profile-path.ts";',
      "",
      "async function f(cwd: string) {",
      '  const copySrc = await resolveAgentProfilePath(cwd, "claude-code");',
      '  const copyDst = await resolveOwnedAgentProfilePath(cwd, "codex");',
      "  await copyOwnedToOwned(copySrc, copyDst);",
      '  const renameSrc = await resolveProgressDeletePath(cwd, ".code-pact/state/old.yaml");',
      '  const renameDst = await resolveProgressWritePath(cwd, ".code-pact/state/new.yaml");',
      "  await renameOwned(renameSrc, renameDst);",
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
    expect(result.output).toContain(
      "readFileSync() called on non-authority path",
    );
    expect(result.output).toContain(
      "writeFileSync() called on non-authority path",
    );
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
      'import { brandOwnedWrite } from "../../src/core/project-fs/branded-paths-internal.ts";',
      "",
      "function f(profile: any) {",
      "  return brandOwnedWrite(profile.instruction_filename);",
      "}",
      "",
    ]);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("brand constructor import");
  });

  it("rejects projectFs sink aliases", async () => {
    const result = await runFixture([
      'import { writeFile } from "../../src/core/project-fs/raw-internal.ts";',
      "",
      "async function f(profile: any) {",
      "  const sink = writeFile;",
      '  await sink(profile.instruction_filename, "x");',
      "}",
      "",
    ]);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("writeFile() called on non-authority path");
  });

  it("rejects raw fs import aliases", async () => {
    const result = await runFixture([
      'import { writeFile as dangerousWrite } from "node:fs/promises";',
      "",
      "async function f(profile: any) {",
      '  await dangerousWrite(profile.instruction_filename, "x");',
      "}",
      "",
    ]);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("writeFile() called on non-authority path");
  });

  it("rejects rename aliases with an untrusted destination", async () => {
    const result = await runFixture([
      'import { rename } from "../../src/core/project-fs/raw-internal.ts";',
      'import { resolveOwnedAgentProfilePath } from "../../src/core/agent-profile-path.ts";',
      "",
      "async function f(cwd: string, profile: any) {",
      '  const ownedSource = await resolveOwnedAgentProfilePath(cwd, "claude-code");',
      "  const move = rename;",
      "  await move(ownedSource, profile.instruction_filename);",
      "}",
      "",
    ]);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("rename() called on non-authority path");
  });

  it("rejects unlink aliases", async () => {
    const result = await runFixture([
      'import { unlink } from "../../src/core/project-fs/raw-internal.ts";',
      "",
      "async function f(untrustedPath: string) {",
      "  const remove = unlink;",
      "  await remove(untrustedPath);",
      "}",
      "",
    ]);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("unlink() called on non-authority path");
  });

  it("rejects open aliases with write flags", async () => {
    const result = await runFixture([
      'import { open } from "../../src/core/project-fs/raw-internal.ts";',
      "",
      "async function f(untrustedPath: string) {",
      "  const opener = open;",
      '  await opener(untrustedPath, "w");',
      "}",
      "",
    ]);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("open() called on non-authority path");
  });

  it("rejects object property sink aliases", async () => {
    const result = await runFixture([
      'import { writeFile } from "../../src/core/project-fs/raw-internal.ts";',
      "",
      "async function f(untrustedPath: string) {",
      "  const fsApi = { sink: writeFile };",
      '  await fsApi.sink(untrustedPath, "x");',
      "}",
      "",
    ]);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("writeFile() called on non-authority path");
  });

  it("rejects namespace fs calls", async () => {
    const result = await runFixture([
      'import * as fs from "node:fs/promises";',
      "",
      "async function f(untrustedPath: string) {",
      '  await fs.writeFile(untrustedPath, "x");',
      "}",
      "",
    ]);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("writeFile() called on non-authority path");
  });

  it("rejects dynamic raw fs imports", async () => {
    const result = await runFixture([
      "async function f(untrustedPath: string) {",
      '  const fs = await import("node:fs/promises");',
      '  await fs.writeFile(untrustedPath, "x");',
      "}",
      "",
    ]);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("writeFile() called on non-authority path");
  });

  it("rejects require raw fs imports", async () => {
    const result = await runFixture([
      "async function f(untrustedPath: string) {",
      '  const fs = require("node:fs");',
      '  fs.writeFileSync(untrustedPath, "x");',
      "}",
      "",
    ]);
    expect(result.ok).toBe(false);
    expect(result.output).toContain(
      "writeFileSync() called on non-authority path",
    );
  });

  it("rejects unknown raw fs operations", async () => {
    const result = await runFixture([
      'import { constants as fsConstants } from "node:fs";',
      "",
      "async function f(untrustedPath: string) {",
      "  fsConstants(untrustedPath);",
      "}",
      "",
    ]);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("unknown raw fs operation");
  });

  it("rejects raw-internal imports from non-trusted modules", async () => {
    const dir = await mkdtemp(join(tmpdir(), "code-pact-fs-authority-"));
    const target = join(dir, "probe.ts");
    await writeFile(
      target,
      [
        'import { readFile } from "../../src/core/project-fs/raw-internal.ts";',
        "",
        "async function f(path: string) {",
        '  await readFile(path, "utf8");',
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
      expect(output).toContain("raw-internal import");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects node:fs imports from non-trusted modules", async () => {
    const dir = await mkdtemp(join(tmpdir(), "code-pact-fs-authority-"));
    const target = join(dir, "probe.ts");
    await writeFile(
      target,
      [
        'import { readFile } from "node:fs/promises";',
        "",
        "async function f(path: string) {",
        '  await readFile(path, "utf8");',
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
      expect(output).toContain("node:fs import");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects raw-internal alias imports from non-trusted modules", async () => {
    const dir = await mkdtemp(join(tmpdir(), "code-pact-fs-authority-"));
    const target = join(dir, "probe.ts");
    await writeFile(
      target,
      [
        'import { readFile as readIt } from "../../src/core/project-fs/raw-internal.ts";',
        "",
        "async function f(path: string) {",
        '  await readIt(path, "utf8");',
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
      expect(output).toContain("raw-internal import");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects raw-internal namespace imports from non-trusted modules", async () => {
    const dir = await mkdtemp(join(tmpdir(), "code-pact-fs-authority-"));
    const target = join(dir, "probe.ts");
    await writeFile(
      target,
      [
        'import * as rawFs from "../../src/core/project-fs/raw-internal.ts";',
        "",
        "async function f(path: string) {",
        '  await rawFs.readFile(path, "utf8");',
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
      expect(output).toContain("raw-internal import");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("function-wide allowlist does not auto-approve a new dangerous call site in the same function", async () => {
    const dir = await mkdtemp(join(tmpdir(), "code-pact-fs-authority-"));
    const target = join(dir, "probe.ts");
    const allowlistPath = join(
      dir,
      ".code-pact",
      "fs-authority-allowlist.json",
    );
    const { mkdir: mkdirAsync } = await import("node:fs/promises");
    await mkdirAsync(join(dir, ".code-pact"), { recursive: true });
    await writeFile(
      allowlistPath,
      JSON.stringify({
        "probe.ts#f": [
          {
            operation: "readFile",
            authority: "explicit_user_input",
            reason: "user-supplied config path",
          },
        ],
      }),
      "utf8",
    );
    await writeFile(
      target,
      [
        'import { readFile, writeFile } from "node:fs/promises";',
        "",
        "async function f(profile: any, userPath: string) {",
        '  await readFile(userPath, "utf8");',
        '  await writeFile(profile.instruction_filename, "x");',
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    try {
      await execFileAsync("node", [scriptPath, target], { cwd: dir });
      throw new Error("check-fs-authority unexpectedly passed");
    } catch (err) {
      const output = `${(err as { stdout?: string }).stdout ?? ""}\n${
        (err as { stderr?: string }).stderr ?? ""
      }`;
      expect(output).toContain("writeFile() called on non-authority path");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects raw-internal re-exports from non-trusted modules", async () => {
    const dir = await mkdtemp(join(tmpdir(), "code-pact-fs-authority-"));
    const target = join(dir, "probe.ts");
    await writeFile(
      target,
      [
        'export { readFile } from "../../src/core/project-fs/raw-internal.ts";',
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
      expect(output).toContain("raw-internal import");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects node:fs namespace imports from non-trusted modules", async () => {
    const dir = await mkdtemp(join(tmpdir(), "code-pact-fs-authority-"));
    const target = join(dir, "probe.ts");
    await writeFile(
      target,
      [
        'import * as fs from "node:fs/promises";',
        "",
        "async function f(path: string) {",
        '  await fs.readFile(path, "utf8");',
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
      expect(output).toContain("node:fs import");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("discovery covers all src/**/*.ts including src/io and src/lib subdirectories", async () => {
    try {
      const { stdout } = await execFileAsync("node", [scriptPath], {
        cwd: repoRoot,
      });
      expect(stdout).not.toContain("raw-internal import");
      expect(stdout).not.toContain("node:fs import");
    } catch (err) {
      const output = `${(err as { stdout?: string }).stdout ?? ""}\n${
        (err as { stderr?: string }).stderr ?? ""
      }`;
      expect(output).not.toContain("raw-internal import");
      expect(output).not.toContain("node:fs import");
    }
  }, 10_000);

  it("rejects read authority as a hard-link source", async () => {
    const result = await runFixture([
      "import {",
      "  linkOwned,",
      "  writeOwnedText,",
      "  resolveProjectConfigReadPath,",
      "  resolveProgressWritePath,",
      '} from "../../src/core/project-fs/index.ts";',
      "",
      "async function f(cwd: string) {",
      "  const source =",
      "    await resolveProjectConfigReadPath(cwd);",
      "  const alias =",
      "    await resolveProgressWritePath(",
      "      cwd,",
      '      ".code-pact/state/project-alias.yaml",',
      "    );",
      "  await linkOwned(source, alias);",
      '  await writeOwnedText(alias, "x");',
      "}",
      "",
    ]);

    expect(result.ok).toBe(false);
    expect(result.output).toContain("linkOwned() called on non-authority path");
  });

  it("allows hard links when source and destination both have write authority", async () => {
    const result = await runFixture([
      "import {",
      "  linkOwned,",
      "  resolveProgressWritePath,",
      '} from "../../src/core/project-fs/index.ts";',
      "",
      "async function f(cwd: string) {",
      "  const source =",
      "    await resolveProgressWritePath(",
      "      cwd,",
      '      ".code-pact/state/source.yaml",',
      "    );",
      "  const destination =",
      "    await resolveProgressWritePath(",
      "      cwd,",
      '      ".code-pact/state/destination.yaml",',
      "    );",
      "  await linkOwned(",
      "    source,",
      "    destination,",
      "  );",
      "}",
      "",
    ]);

    expect(result.ok).toBe(true);
  });
});
