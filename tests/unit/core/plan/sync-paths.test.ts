import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { runSyncPaths } from "../../../../src/core/plan/sync-paths.ts";

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "code-pact-sync-paths-"));
  await mkdir(join(cwd, "design", "phases"), { recursive: true });
});

afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

function phaseYaml(
  id: string,
  reads: string[],
  writes: string[],
): string {
  const list = (items: string[]) =>
    items.length === 0 ? " []" : `\n${items.map((i) => `      - ${i}`).join("\n")}`;
  return `id: ${id}
name: Phase ${id}
weight: 10
confidence: high
risk: low
status: done
objective: test phase
definition_of_done:
  - tests pass
verification:
  commands:
    - echo ok
tasks:
  - id: ${id}-T1
    type: feature
    ambiguity: low
    risk: low
    context_size: small
    write_surface: low
    verification_strength: weak
    expected_duration: short
    status: done
    reads:${list(reads)}
    writes:${list(writes)}
`;
}

async function writePhase(id: string, reads: string[], writes: string[]): Promise<void> {
  await writeFile(
    join(cwd, "design", "phases", `${id}.yaml`),
    phaseYaml(id, reads, writes),
    "utf8",
  );
}

async function readTaskField(
  id: string,
  field: "reads" | "writes",
): Promise<string[]> {
  const raw = await readFile(join(cwd, "design", "phases", `${id}.yaml`), "utf8");
  const doc = parseYaml(raw) as { tasks: { reads?: string[]; writes?: string[] }[] };
  return doc.tasks[0]?.[field] ?? [];
}

describe("runSyncPaths", () => {
  it("renames a path in both reads and writes (write mode)", async () => {
    await writePhase("P1", ["src/a.ts", "src/keep.ts"], ["src/a.ts"]);

    const result = await runSyncPaths({
      cwd,
      renames: [{ from: "src/a.ts", to: "src/b.ts" }],
      mode: "write",
    });

    expect(result.changes).toHaveLength(2);
    expect(result.files_changed).toEqual(["design/phases/P1.yaml"]);
    expect(result.written).toEqual(["design/phases/P1.yaml"]);
    expect(await readTaskField("P1", "reads")).toEqual(["src/b.ts", "src/keep.ts"]);
    expect(await readTaskField("P1", "writes")).toEqual(["src/b.ts"]);
  });

  it("check mode reports changes but writes nothing", async () => {
    await writePhase("P1", ["src/a.ts"], []);

    const result = await runSyncPaths({
      cwd,
      renames: [{ from: "src/a.ts", to: "src/b.ts" }],
      mode: "check",
    });

    expect(result.changes).toHaveLength(1);
    expect(result.files_changed).toEqual(["design/phases/P1.yaml"]);
    expect(result.written).toEqual([]);
    // File on disk is untouched.
    expect(await readTaskField("P1", "reads")).toEqual(["src/a.ts"]);
  });

  it("collapses duplicates a rename introduces (merge), preserving order", async () => {
    await writePhase(
      "P1",
      ["src/start.ts", "src/block.ts", "src/resume.ts", "src/other.ts"],
      [],
    );

    const result = await runSyncPaths({
      cwd,
      renames: [
        { from: "src/start.ts", to: "src/merged.ts" },
        { from: "src/block.ts", to: "src/merged.ts" },
        { from: "src/resume.ts", to: "src/merged.ts" },
      ],
      mode: "write",
    });

    // Three entries were affected, but they collapse to one.
    expect(result.changes).toHaveLength(3);
    expect(await readTaskField("P1", "reads")).toEqual([
      "src/merged.ts",
      "src/other.ts",
    ]);
  });

  it("no matching entry → no change, no write", async () => {
    await writePhase("P1", ["src/a.ts"], ["src/a.ts"]);

    const result = await runSyncPaths({
      cwd,
      renames: [{ from: "src/missing.ts", to: "src/new.ts" }],
      mode: "write",
    });

    expect(result.changes).toEqual([]);
    expect(result.files_changed).toEqual([]);
    expect(result.written).toEqual([]);
  });

  it("leaves a pre-existing duplicate untouched when no rename matches", async () => {
    // A list with a pre-existing duplicate and NO matching rename must not be
    // rewritten or silently de-duplicated (regression: applyToList used to flip
    // `changed` for any duplicate, rename-introduced or not).
    await writePhase("P1", ["src/dup.ts", "src/dup.ts"], []);
    const before = await readFile(
      join(cwd, "design", "phases", "P1.yaml"),
      "utf8",
    );

    const result = await runSyncPaths({
      cwd,
      renames: [{ from: "src/missing.ts", to: "src/new.ts" }],
      mode: "write",
    });

    expect(result.changes).toEqual([]);
    expect(result.files_changed).toEqual([]);
    expect(result.written).toEqual([]);
    const after = await readFile(
      join(cwd, "design", "phases", "P1.yaml"),
      "utf8",
    );
    expect(after).toBe(before);
  });

  it("only rewrites the phase files that actually changed", async () => {
    await writePhase("P1", ["src/a.ts"], []);
    await writePhase("P2", ["src/unrelated.ts"], []);

    const result = await runSyncPaths({
      cwd,
      renames: [{ from: "src/a.ts", to: "src/b.ts" }],
      mode: "write",
    });

    expect(result.written).toEqual(["design/phases/P1.yaml"]);
  });

  it("write mode produces a minimal diff (only the changed entry moves)", async () => {
    await writePhase("P1", ["src/a.ts", "src/keep.ts"], []);
    const before = await readFile(
      join(cwd, "design", "phases", "P1.yaml"),
      "utf8",
    );

    await runSyncPaths({
      cwd,
      renames: [{ from: "src/a.ts", to: "src/b.ts" }],
      mode: "write",
    });

    const after = await readFile(
      join(cwd, "design", "phases", "P1.yaml"),
      "utf8",
    );
    // Exactly one line differs: src/a.ts -> src/b.ts.
    const diff = before
      .split("\n")
      .filter((line, i) => line !== after.split("\n")[i]);
    expect(diff).toEqual(["      - src/a.ts"]);
  });

  it("skips an unparseable phase file and still processes the rest", async () => {
    await writePhase("P1", ["src/a.ts"], []);
    await writeFile(
      join(cwd, "design", "phases", "P2.yaml"),
      "id: P2\nthis is: : not valid phase yaml\n",
      "utf8",
    );

    const result = await runSyncPaths({
      cwd,
      renames: [{ from: "src/a.ts", to: "src/b.ts" }],
      mode: "write",
    });

    expect(result.written).toEqual(["design/phases/P1.yaml"]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.file).toBe("design/phases/P2.yaml");
  });
});
