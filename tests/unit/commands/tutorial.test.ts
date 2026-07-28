import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runTutorial } from "../../../src/commands/tutorial.ts";

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

let parent: string;

beforeEach(async () => {
  parent = await mkdtemp(join(tmpdir(), "code-pact-tutorial-test-"));
});

afterEach(async () => {
  if (parent) await rm(parent, { recursive: true, force: true });
});

describe("runTutorial", () => {
  it("walks the full per-task loop in order and cleans up the sandbox", async () => {
    let out = "";
    const result = await runTutorial({
      locale: "en-US",
      sandboxParent: parent,
      write: (s) => {
        out += s;
      },
    });

    // Seven narrated steps in canonical order.
    expect(result.steps.map((s) => s.command)).toEqual([
      "init --sample-phase",
      "task prepare TUTORIAL-T1",
      "task start TUTORIAL-T1",
      "task prepare TUTORIAL-T2",
      "task complete TUTORIAL-T1",
      "task finalize TUTORIAL-T1 --write",
      "task prepare TUTORIAL-T2",
    ]);

    // The dependency gate is demonstrated: T2 is blocked on T1 first, then
    // becomes ready after T1 completes.
    const blockedStep = result.steps[3]!;
    expect(blockedStep.result).toContain("TUTORIAL-T1");
    const readyStep = result.steps[6]!;
    expect(readyStep.result).toContain("start_task");

    // Verify actually ran and passed (proves this is a real run, not canned).
    expect(result.steps[4]!.result).toMatch(/verify passed \(\d+ checks?\)/);

    // Human narration was emitted.
    expect(out).toContain("code-pact tutorial");
    expect(out).toContain("nothing was written to your project");

    // Sandbox was deleted.
    expect(result.kept).toBe(false);
    expect(await exists(result.sandbox)).toBe(false);
  });

  it("keeps the sandbox when keep is set", async () => {
    const result = await runTutorial({
      locale: "en-US",
      sandboxParent: parent,
      keep: true,
      write: () => {},
    });
    expect(result.kept).toBe(true);
    expect(await exists(result.sandbox)).toBe(true);
  });

  it("emits no prose in JSON mode but still returns steps", async () => {
    let out = "";
    const result = await runTutorial({
      locale: "en-US",
      sandboxParent: parent,
      json: true,
      write: (s) => {
        out += s;
      },
    });
    expect(out).toBe("");
    expect(result.steps).toHaveLength(7);
    expect(await exists(result.sandbox)).toBe(false);
  });

  it("narrates in Japanese when locale is ja-JP", async () => {
    let out = "";
    await runTutorial({
      locale: "ja-JP",
      sandboxParent: parent,
      write: (s) => {
        out += s;
      },
    });
    expect(out).toContain("タスクの進め方");
    expect(out).toContain("何も書き込んでいません");
  });
});

describe("sample phase review contracts", () => {
  it("generates a valid contract for each tutorial task, in both modes", async () => {
    const { readFile } = await import("node:fs/promises");
    const { parse } = await import("yaml");
    const { Phase } = await import("../../../src/core/schemas/phase.ts");
    const { validateReviewContractForTask } = await import(
      "../../../src/core/review-contract.ts"
    );

    const result = await runTutorial({
      locale: "en-US",
      sandboxParent: parent,
      keep: true,
      write: () => {},
    });

    // Parsed through the real Phase schema, so an unknown key or a bad enum in
    // the generated contract fails here rather than reaching a user's project.
    const phase = Phase.parse(
      parse(
        await readFile(
          join(result.sandbox, "design", "phases", "TUTORIAL-walkthrough.yaml"),
          "utf8",
        ),
      ),
    );

    const t1 = phase.tasks?.find((t) => t.id === "TUTORIAL-T1");
    const t2 = phase.tasks?.find((t) => t.id === "TUTORIAL-T2");

    // The sample is the worked example of both modes: a `feature` task cannot
    // use `minimal`, and a low-risk `docs` task is exactly what can.
    expect(t1?.review_contract?.mode).toBe("boundary");
    expect(t2?.review_contract?.mode).toBe("minimal");

    // Valid against the same rules `task add` and `task lock` apply.
    expect(validateReviewContractForTask(t1!)).toEqual([]);
    expect(validateReviewContractForTask(t2!)).toEqual([]);

    await rm(result.sandbox, { recursive: true, force: true });
  });
});
