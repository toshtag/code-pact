import { execFile } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const scriptPath = join(repoRoot, "scripts", "check-history-noise.mjs");

describe("check-history-noise", () => {
  it("runs the repository gate through the script entrypoint", async () => {
    const { stdout } = await execFileAsync("node", [scriptPath], {
      cwd: repoRoot,
    });

    expect(stdout).toContain("check-history-noise: OK");
  });
});
