import { afterEach, beforeEach, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { phaseFilePresence } from "../../../../../src/core/plan/checks/fs.ts";

// phaseFilePresence (step 4a) distinguishes present / absent / inaccessible so the
// archive readers never tolerate a present-but-unreadable live phase as 'absent'.

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "code-pact-presence-"));
});
afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

it("present file → 'present'", async () => {
  await writeFile(join(cwd, "f.yaml"), "x", "utf8");
  expect(await phaseFilePresence(join(cwd, "f.yaml"))).toBe("present");
});

it("missing file (ENOENT) → 'absent'", async () => {
  expect(await phaseFilePresence(join(cwd, "nope.yaml"))).toBe("absent");
});

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
it.skipIf(isRoot)("present but unreadable (EACCES via non-searchable dir) → 'inaccessible'", async () => {
  const dir = join(cwd, "locked");
  await mkdir(dir);
  await writeFile(join(dir, "f.yaml"), "x", "utf8");
  await chmod(dir, 0o000);
  try {
    expect(await phaseFilePresence(join(dir, "f.yaml"))).toBe("inaccessible");
  } finally {
    await chmod(dir, 0o755);
  }
});
