import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTempProject,
  ensureCliBuilt,
  expectJsonErr,
  type RunResult,
} from "../helpers/cli.ts";

beforeAll(() => ensureCliBuilt(), 60_000);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function snapshotTree(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile()) {
        out[abs.slice(root.length + 1)] = await readFile(abs, "utf8");
      }
    }
  }
  await walk(root);
  return out;
}

function expectContainedRefusal(res: RunResult, name: string, forbidden: string): void {
  expect(res.code, name).toBe(2);
  expectJsonErr(res, "CONFIG_ERROR");
  expect(res.stdout + res.stderr, name).not.toContain(forbidden);
  expect(res.stdout + res.stderr, name).not.toMatch(/internal error/i);
}

const SPEC_MD = [
  "# Imported spec",
  "",
  "### Setup",
  "",
  "- [ ] Do the contained write check",
  "",
].join("\n");

describe("design write containment", () => {
  it("mutating design commands refuse an external symlinked design directory", async () => {
    const p = await createTempProject({ prefix: "code-pact-design-write-containment-" });
    cleanups.push(p.cleanup);

    await mkdir(join(p.dir, "docs"), { recursive: true });
    await writeFile(join(p.dir, "docs", "tasks.md"), SPEC_MD, "utf8");

    const outside = await mkdtemp(join(tmpdir(), "code-pact-design-outside-"));
    cleanups.push(() => rm(outside, { recursive: true, force: true }));
    const marker = "OUTSIDE_DESIGN_MARKER_SHOULD_NOT_LEAK";
    await writeFile(join(outside, "brief.md"), `${marker}  \n`, "utf8");

    await rm(join(p.dir, "design"), { recursive: true, force: true });
    await symlink(outside, join(p.dir, "design"));
    const beforeOutside = await snapshotTree(outside);

    const cases: Array<{ name: string; args: string[] }> = [
      {
        name: "phase add",
        args: [
          "phase",
          "add",
          "--id",
          "P2",
          "--name",
          "Contained write",
          "--objective",
          "Refuse writing through an external design symlink",
          "--weight",
          "10",
          "--json",
        ],
      },
      {
        name: "plan brief",
        args: [
          "plan",
          "brief",
          "--force",
          "--what",
          "A contained write test",
          "--who",
          "security reviewers",
          "--differentiator",
          "refuses symlink escapes",
          "--json",
        ],
      },
      {
        name: "plan constitution",
        args: [
          "plan",
          "constitution",
          "--force",
          "--description",
          "A contained write test",
          "--principle",
          "Never write through external design symlinks",
          "--json",
        ],
      },
      {
        name: "spec import",
        args: [
          "spec",
          "import",
          "--from",
          "docs/tasks.md",
          "--phase-id",
          "P2",
          "--write",
          "--json",
        ],
      },
      {
        name: "plan normalize",
        args: ["plan", "normalize", "--write", "--json"],
      },
      {
        name: "plan sync-paths",
        args: [
          "plan",
          "sync-paths",
          "--rename",
          "src/old.ts=src/new.ts",
          "--write",
          "--json",
        ],
      },
    ];

    for (const c of cases) {
      expectContainedRefusal(p.run(c.args), c.name, marker);
      expect(await snapshotTree(outside), c.name).toEqual(beforeOutside);
    }
  });
});
