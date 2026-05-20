// Byte-identical pack regression test.
//
// The accepted P10 RFC promises that `task context` output is
// byte-identical to v1.0.2 for any task that declares none of the
// new optional fields (depends_on / decision_refs / reads / writes /
// acceptance_refs). This test locks that promise against a golden
// fixture captured from project-a/P2-E1-T1 — a v1.0.2-shaped task in
// the existing test corpus.
//
// When this test fails:
//
// 1. If the failure is because pack rendering changed for a v1.0.2-
//    shaped task, the change is a backward-compatibility break. Either
//    revert the change or document why a v2 contract cut is needed.
// 2. If the failure is because the golden file is intentionally out
//    of date (e.g. the existing v1.0 surface itself moved), update
//    the golden along with the RFC / contract docs that explain the
//    move and reference the corresponding `cli-contract.md` revision.
//
// The golden file lives under tests/fixtures/golden/ so a diff in code
// review surfaces the exact byte-level change.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildContextPack } from "../../src/core/pack/index.ts";

const fixtureDir = new URL("../fixtures/project-a", import.meta.url).pathname;
const goldenPath = new URL(
  "../fixtures/golden/pack-v1.0.2-shaped.md",
  import.meta.url,
).pathname;

describe("buildContextPack — byte-identical for v1.0.2-shaped tasks (P10 contract)", () => {
  let work: string;

  beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), "code-pact-pack-byte-identical-"));
    await cp(fixtureDir, work, { recursive: true });
    // Make sure no stale .context/ from previous runs leaks into the test.
    await rm(join(work, ".context"), { recursive: true, force: true });
  });

  afterEach(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it("matches the captured v1.0.2 golden for project-a/P2-E1-T1", async () => {
    const pack = await buildContextPack({
      cwd: work,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
    });
    const golden = await readFile(goldenPath, "utf8");
    expect(pack.content).toBe(golden);
  });
});
