import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliPath, ensureCliBuilt } from "../helpers/cli.ts";

let tmpDir: string;

type RunResult = { code: number; stdout: string; stderr: string };

function run(args: string[]): RunResult {
  const res = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: tmpDir,
    encoding: "utf8",
    env: process.env,
  });
  return {
    code: res.status ?? -1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

beforeAll(() => {
  ensureCliBuilt();
}, 60_000);

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "code-pact-plan-analyze-int-"));
  await mkdir(join(tmpDir, "design", "phases"), { recursive: true });
  await mkdir(join(tmpDir, ".code-pact", "state"), { recursive: true });
});

afterAll(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

type AnalyzeJson = {
  ok: boolean;
  error?: { code: string; message: string };
  data?: {
    summary: {
      phases: number;
      tasks: number;
      errors: number;
      warnings: number;
      hidden: number;
    };
    strict: boolean;
    include_historical: boolean;
    issues: Array<{
      code: string;
      severity: string;
      task_id?: string;
      details?: Record<string, unknown>;
    }>;
  };
};

function parseAnalyze(stdout: string): AnalyzeJson {
  return JSON.parse(stdout) as AnalyzeJson;
}

async function writeFixture(args: {
  phases: Array<{
    id: string;
    status?: "planned" | "in_progress" | "done" | "cancelled";
    tasks: Array<{ id: string; status?: "planned" | "in_progress" | "done" | "cancelled" }>;
  }>;
  events: Array<{
    task_id: string;
    status: "started" | "blocked" | "resumed" | "done" | "failed";
    reason?: string;
  }>;
}): Promise<void> {
  const roadmap = `phases:\n${args.phases
    .map(
      (p) =>
        `  - id: ${p.id}\n    path: design/phases/${p.id}.yaml\n    weight: 10`,
    )
    .join("\n")}\n`;
  await writeFile(join(tmpDir, "design", "roadmap.yaml"), roadmap, "utf8");
  for (const p of args.phases) {
    const tasksBlock = p.tasks
      .map(
        (t) => `  - id: ${t.id}
    type: feature
    ambiguity: low
    risk: low
    context_size: small
    write_surface: low
    verification_strength: medium
    expected_duration: short
    status: ${t.status ?? "planned"}`,
      )
      .join("\n");
    const yaml = `id: ${p.id}
name: ${p.id}
weight: 10
confidence: medium
risk: low
status: ${p.status ?? "planned"}
objective: An objective long enough
definition_of_done:
  - thing is done
verification:
  commands:
    - pnpm test
tasks:
${tasksBlock}
`;
    await writeFile(
      join(tmpDir, "design", "phases", `${p.id}.yaml`),
      yaml,
      "utf8",
    );
  }
  const progressBody =
    args.events.length === 0
      ? "events: []\n"
      : `events:\n${args.events
          .map(
            (e, i) =>
              `  - task_id: ${e.task_id}\n    status: ${e.status}\n    at: "2026-05-18T0${i}:00:00+00:00"\n    actor: agent${
                e.reason ? `\n    reason: ${e.reason}` : ""
              }`,
          )
          .join("\n")}\n`;
  await writeFile(
    join(tmpDir, ".code-pact", "state", "progress.yaml"),
    progressBody,
    "utf8",
  );
}

describe("plan analyze", () => {
  it("clean tree: ok=true, exit 0, no drift", async () => {
    await writeFixture({
      phases: [
        { id: "P1", tasks: [{ id: "P1-T1", status: "done" }] },
      ],
      events: [
        { task_id: "P1-T1", status: "started" },
        { task_id: "P1-T1", status: "done" },
      ],
    });

    const res = run(["plan", "analyze", "--json"]);
    expect(res.code).toBe(0);
    const parsed = parseAnalyze(res.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.data?.summary.errors).toBe(0);
    expect(parsed.data?.summary.warnings).toBe(0);
    expect(parsed.data?.issues).toEqual([]);
  });

  // CRITICAL regression test: a fixture mirroring pre-v0.6 history
  // (done tasks with no progress events) must NOT fail analyze in
  // default mode. This is the safety property that keeps self-dogfooding
  // green on code-pact's own design/.
  it("historical fixture (design done + no events): exit 0 by default, hidden=N", async () => {
    await writeFixture({
      phases: [
        {
          id: "P1",
          status: "done",
          tasks: [
            { id: "P1-T1", status: "done" },
            { id: "P1-T2", status: "done" },
          ],
        },
      ],
      events: [],
    });

    const res = run(["plan", "analyze", "--json"]);
    expect(res.code).toBe(0);
    const parsed = parseAnalyze(res.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.data?.summary.errors).toBe(0);
    expect(parsed.data?.summary.warnings).toBe(0);
    expect(parsed.data?.summary.hidden).toBeGreaterThan(0);
    expect(parsed.data?.issues).toEqual([]);
  });

  it("--include-historical surfaces historical issues but still exits 0", async () => {
    await writeFixture({
      phases: [
        {
          id: "P1",
          status: "done",
          tasks: [{ id: "P1-T1", status: "done" }],
        },
      ],
      events: [],
    });

    const res = run(["plan", "analyze", "--include-historical", "--json"]);
    expect(res.code).toBe(0);
    const parsed = parseAnalyze(res.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.data?.include_historical).toBe(true);
    const historical = parsed.data?.issues.find(
      (i) =>
        i.code === "STATUS_DRIFT" &&
        i.details?.["kind"] === "done-historical",
    );
    expect(historical).toBeDefined();
  });

  it("done + blocked: exit 1, PLAN_ANALYZE_FAILED, single STATUS_DRIFT (kind=done-blocked-conflict)", async () => {
    await writeFixture({
      phases: [
        { id: "P1", tasks: [{ id: "P1-T1", status: "done" }] },
      ],
      events: [
        { task_id: "P1-T1", status: "started" },
        { task_id: "P1-T1", status: "blocked", reason: "wait" },
      ],
    });

    const res = run(["plan", "analyze", "--json"]);
    expect(res.code).toBe(1);
    const parsed = parseAnalyze(res.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error?.code).toBe("PLAN_ANALYZE_FAILED");
    const drifts = parsed.data?.issues.filter(
      (i) => i.code === "STATUS_DRIFT" && i.task_id === "P1-T1",
    );
    expect(drifts).toHaveLength(1);
    expect(drifts?.[0]?.details?.["kind"]).toBe("done-blocked-conflict");
  });

  it("warnings-only stays exit 0; --strict promotes to exit 1", async () => {
    // design planned + derived done = warning kind=done-but-design-not-done
    await writeFixture({
      phases: [
        { id: "P1", tasks: [{ id: "P1-T1", status: "planned" }] },
      ],
      events: [
        { task_id: "P1-T1", status: "started" },
        { task_id: "P1-T1", status: "done" },
      ],
    });

    const lenient = run(["plan", "analyze", "--json"]);
    expect(lenient.code).toBe(0);
    expect(parseAnalyze(lenient.stdout).ok).toBe(true);

    const strict = run(["plan", "analyze", "--strict", "--json"]);
    expect(strict.code).toBe(1);
    const strictParsed = parseAnalyze(strict.stdout);
    expect(strictParsed.ok).toBe(false);
    expect(strictParsed.error?.code).toBe("PLAN_ANALYZE_FAILED");
  });

  it("orphan progress event is a warning that does not break exit 0", async () => {
    await writeFixture({
      phases: [
        { id: "P1", tasks: [{ id: "P1-T1", status: "done" }] },
      ],
      events: [
        { task_id: "P1-T1", status: "started" },
        { task_id: "P1-T1", status: "done" },
        { task_id: "GHOST", status: "started" },
      ],
    });

    const res = run(["plan", "analyze", "--json"]);
    expect(res.code).toBe(0);
    const parsed = parseAnalyze(res.stdout);
    expect(
      parsed.data?.issues.some(
        (i) => i.code === "ORPHAN_PROGRESS_EVENT" && i.task_id === "GHOST",
      ),
    ).toBe(true);
  });

  it("corrupt event file: wraps the ledger-read failure into PLAN_ANALYZE_FAILED (never leaks EVENT_FILE_ID_MISMATCH as the top-level code)", async () => {
    await writeFixture({
      phases: [{ id: "P1", tasks: [{ id: "P1-T1", status: "planned" }] }],
      events: [],
    });
    // A name that parses as a valid event-file name but whose 64-hex id does not
    // match the body — the strict loader throws EVENT_FILE_ID_MISMATCH.
    const eventsDir = join(tmpDir, ".code-pact", "state", "events");
    await mkdir(eventsDir, { recursive: true });
    const wrongId = "0".repeat(64);
    await writeFile(
      join(eventsDir, `20260518T000000000Z-${wrongId}.yaml`),
      `task_id: P1-T1\nstatus: done\nat: "2026-05-18T00:00:00.000Z"\nactor: agent\n`,
      "utf8",
    );

    const res = run(["plan", "analyze", "--json"]);
    expect(res.code).toBe(1);
    const parsed = parseAnalyze(res.stdout);
    expect(parsed.ok).toBe(false);
    // Wrapped — NOT surfaced as a public EVENT_FILE_ID_MISMATCH command error.
    expect(parsed.error?.code).toBe("PLAN_ANALYZE_FAILED");
    expect(parsed.error?.code).not.toBe("EVENT_FILE_ID_MISMATCH");
    // The original cause is preserved in the message.
    expect(parsed.error?.message ?? "").toContain("filename id");
  });
});
