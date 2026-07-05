import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run as cliRun, ensureCliBuilt, type RunResult } from "../helpers/cli.ts";

let tmpDir: string;

function run(args: string[]): RunResult {
  return cliRun(tmpDir, args);
}

const PHASE_YAML = `id: P1
name: Phase 1
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
  - id: P1-T1
    type: feature
    ambiguity: low
    risk: low
    context_size: small
    write_surface: low
    verification_strength: weak
    expected_duration: short
    status: done
    reads:
      - src/old.ts
      - src/keep.ts
    writes:
      - src/old.ts
`;

beforeAll(() => {
  ensureCliBuilt();
}, 60_000);

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "code-pact-plan-sync-int-"));
  await mkdir(join(tmpDir, "design", "phases"), { recursive: true });
  await writeFile(join(tmpDir, "design", "phases", "P1.yaml"), PHASE_YAML, "utf8");
});

afterEach(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

type SyncJson = {
  ok: boolean;
  error?: { code: string; message: string };
  data?: {
    mode: "check" | "write";
    renames: Array<{ from: string; to: string }>;
    changes: Array<{ file: string; task_id: string; field: string; from: string; to: string }>;
    files_changed: string[];
    written: string[];
    skipped: Array<{ file: string; reason: string }>;
  };
};

describe("plan sync-paths", () => {
  it("dry-run --json: reports changes, exits 0, leaves the file unchanged", async () => {
    const res = run([
      "plan",
      "sync-paths",
      "--rename",
      "src/old.ts=src/new.ts",
      "--json",
    ]);
    expect(res.code).toBe(0);
    expect(res.stderr).toBe("");
    const parsed = JSON.parse(res.stdout) as SyncJson;
    expect(parsed.ok).toBe(true);
    expect(parsed.data?.mode).toBe("check");
    expect(parsed.data?.changes).toHaveLength(2); // reads + writes
    expect(parsed.data?.written).toEqual([]);

    // File on disk is untouched.
    const onDisk = await readFile(
      join(tmpDir, "design", "phases", "P1.yaml"),
      "utf8",
    );
    expect(onDisk).toBe(PHASE_YAML);
  });

  it("--write --json: applies the rename to disk, exits 0", async () => {
    const res = run([
      "plan",
      "sync-paths",
      "--rename",
      "src/old.ts=src/new.ts",
      "--write",
      "--json",
    ]);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout) as SyncJson;
    expect(parsed.ok).toBe(true);
    expect(parsed.data?.mode).toBe("write");
    expect(parsed.data?.written).toEqual(["design/phases/P1.yaml"]);

    const onDisk = await readFile(
      join(tmpDir, "design", "phases", "P1.yaml"),
      "utf8",
    );
    expect(onDisk).toContain("src/new.ts");
    expect(onDisk).not.toContain("src/old.ts");
    expect(onDisk).toContain("src/keep.ts");
  });

  it("missing --rename: CONFIG_ERROR, exit 2", async () => {
    const res = run(["plan", "sync-paths", "--json"]);
    expect(res.code).toBe(2);
    const parsed = JSON.parse(res.stdout) as SyncJson;
    expect(parsed.ok).toBe(false);
    expect(parsed.error?.code).toBe("CONFIG_ERROR");
  });

  it("invalid --rename (no '='): CONFIG_ERROR, exit 2", async () => {
    const res = run(["plan", "sync-paths", "--rename", "justastring", "--json"]);
    expect(res.code).toBe(2);
    const parsed = JSON.parse(res.stdout) as SyncJson;
    expect(parsed.error?.code).toBe("CONFIG_ERROR");
  });

  it("identical old=new: CONFIG_ERROR, exit 2", async () => {
    const res = run([
      "plan",
      "sync-paths",
      "--rename",
      "src/x.ts=src/x.ts",
      "--json",
    ]);
    expect(res.code).toBe(2);
    const parsed = JSON.parse(res.stdout) as SyncJson;
    expect(parsed.error?.code).toBe("CONFIG_ERROR");
  });

  it("unknown flag (e.g. --wriet typo) → CONFIG_ERROR, exit 2 (never a silent dry-run)", () => {
    const res = run([
      "plan",
      "sync-paths",
      "--rename",
      "src/old.ts=src/new.ts",
      "--wriet",
      "--json",
    ]);
    expect(res.code).toBe(2);
    const parsed = JSON.parse(res.stdout) as SyncJson;
    expect(parsed.error?.code).toBe("CONFIG_ERROR");
  });

  it("stray positional → CONFIG_ERROR, exit 2", () => {
    const res = run([
      "plan",
      "sync-paths",
      "--rename",
      "src/old.ts=src/new.ts",
      "unexpected",
      "--json",
    ]);
    expect(res.code).toBe(2);
    const parsed = JSON.parse(res.stdout) as SyncJson;
    expect(parsed.error?.code).toBe("CONFIG_ERROR");
  });

  it("conflicting --rename for one source → CONFIG_ERROR, exit 2", () => {
    const res = run([
      "plan",
      "sync-paths",
      "--rename",
      "src/a.ts=src/b.ts",
      "--rename",
      "src/a.ts=src/c.ts",
      "--json",
    ]);
    expect(res.code).toBe(2);
    const parsed = JSON.parse(res.stdout) as SyncJson;
    expect(parsed.error?.code).toBe("CONFIG_ERROR");
  });

  it("bare --rename (no value) → CONFIG_ERROR, exit 2", () => {
    const res = run(["plan", "sync-paths", "--rename", "--json"]);
    expect(res.code).toBe(2);
    const parsed = JSON.parse(res.stdout) as SyncJson;
    expect(parsed.error?.code).toBe("CONFIG_ERROR");
  });

  it("human mode dry-run: summary on stderr, stdout empty, exit 0", async () => {
    const res = run([
      "plan",
      "sync-paths",
      "--rename",
      "src/old.ts=src/new.ts",
    ]);
    expect(res.code).toBe(0);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("would update");
    expect(res.stderr).toContain("Re-run with --write");
  });
});
