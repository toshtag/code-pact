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
});
