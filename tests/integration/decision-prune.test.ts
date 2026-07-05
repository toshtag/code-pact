// `decision prune` CLI contract — built-CLI integration.
// PR-C1b: dry-run public command, JSON envelopes, exit codes.
// PR-C2: --write executes the plan (append ledger → rewrite links → delete record last).
// PR-D1: decision_retention policy surfaced as data.policy / data.policy_source; --policy override.

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import {
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
  symlink,
  mkdtemp,
} from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import {
  createTempProject,
  ensureCliBuilt,
  expectJsonOk,
  expectJsonErr,
} from "../helpers/cli.ts";

beforeAll(() => ensureCliBuilt(), 60_000);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const ACCEPTED = "# RFC\n\n**Status:** accepted\n\n## Decision\n\nbody";

const PHASE = (taskStatus: string, decisionRef: string) => `id: P1
name: P1
weight: 10
confidence: high
risk: low
status: ${taskStatus === "done" ? "done" : "planned"}
objective: An objective long enough
definition_of_done:
  - DoD that is clearly long enough
verification:
  commands:
    - pnpm test
tasks:
  - id: P1-T1
    type: feature
    ambiguity: low
    risk: low
    context_size: small
    write_surface: low
    verification_strength: medium
    expected_duration: short
    status: ${taskStatus}
    description: Implements the thing
    decision_refs:
      - ${decisionRef}
`;

async function project(decisionContent: string, taskStatus = "done") {
  const p = await createTempProject({ init: true, prefix: "decprune-int-" });
  cleanups.push(p.cleanup);
  await mkdir(join(p.dir, "design", "decisions"), { recursive: true });
  await mkdir(join(p.dir, "design", "phases"), { recursive: true });
  await writeFile(
    join(p.dir, "design", "decisions", "foo-rfc.md"),
    decisionContent,
  );
  await writeFile(
    join(p.dir, "design", "roadmap.yaml"),
    `phases:\n  - id: P1\n    path: design/phases/P1.yaml\n    weight: 10\n`,
  );
  await writeFile(
    join(p.dir, "design", "phases", "P1.yaml"),
    PHASE(taskStatus, "design/decisions/foo-rfc.md"),
  );
  return p;
}

/** Recursively snapshot every file under `root` as { relPath → content }. */
async function snapshotTree(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(dir: string): Promise<void> {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) await walk(abs);
      else if (e.isFile())
        out[relative(root, abs)] = await readFile(abs, "utf8");
    }
  }
  await walk(root);
  return out;
}

describe("decision prune — CLI (dry-run)", () => {
  it("eligible accepted target → exit 0, full success envelope shape (JSON)", async () => {
    const p = await project(ACCEPTED, "done");
    const res = p.run([
      "decision",
      "prune",
      "design/decisions/foo-rfc.md",
      "--json",
    ]);
    const env = expectJsonOk<{
      mode: string;
      decision: string;
      eligible: boolean;
      blocks: unknown[];
      referencing_tasks: {
        task_id: string;
        phase_id: string;
        status: string;
        via: string;
      }[];
      plan: {
        remove_file: string;
        append_ledger: boolean;
        link_rewrite: { status: string; items: unknown[] };
      };
      warnings: unknown[];
    }>(res);
    expect(res.code).toBe(0);
    expect(env.data.mode).toBe("dry-run");
    expect(env.data.decision).toBe("design/decisions/foo-rfc.md");
    expect(env.data.eligible).toBe(true);
    expect(env.data.blocks).toEqual([]);
    expect(env.data.plan).toEqual({
      remove_file: "design/decisions/foo-rfc.md",
      append_ledger: true,
      link_rewrite: { status: "ready", items: [] },
    });
    expect(Array.isArray(env.data.warnings)).toBe(true);
    expect(env.data.referencing_tasks[0]).toMatchObject({
      task_id: "P1-T1",
      phase_id: "P1",
      status: "done",
      via: "decision_refs",
    });
  });

  it("eligible with a real inbound link → non-empty link_rewrite.items[] with the full field shape (JSON)", async () => {
    const p = await project(ACCEPTED, "done");
    await mkdir(join(p.dir, "docs"), { recursive: true });
    await writeFile(
      join(p.dir, "docs", "x.md"),
      "# X\n\nSee [d](../design/decisions/foo-rfc.md).\n",
    );
    const res = p.run([
      "decision",
      "prune",
      "design/decisions/foo-rfc.md",
      "--json",
    ]);
    const env = expectJsonOk<{
      plan: {
        link_rewrite: { status: string; items: Record<string, unknown>[] };
      };
    }>(res);
    expect(env.data.plan.link_rewrite.status).toBe("ready");
    const item = env.data.plan.link_rewrite.items.find(
      i => i.source_file === "docs/x.md",
    );
    expect(item).toBeDefined();
    expect(Object.keys(item!).sort()).toEqual(
      [
        "column",
        "line",
        "link_kind",
        "link_text",
        "normalized_target",
        "raw_href",
        "raw_link",
        "rewrite_action",
        "source_file",
      ].sort(),
    );
    expect(item).toMatchObject({
      link_kind: "inline",
      rewrite_action: "delink",
      normalized_target: "design/decisions/foo-rfc.md",
    });
  });

  it("ineligible → data.plan is null and data.blocks[].gate is populated (JSON)", async () => {
    const p = await project("# RFC\n\n**Status:** proposed\n\nx", "done");
    const res = p.run([
      "decision",
      "prune",
      "design/decisions/foo-rfc.md",
      "--json",
    ]);
    const env = expectJsonErr(res);
    const data = env.data as {
      eligible: boolean;
      plan: unknown;
      blocks: { gate: string }[];
    };
    expect(data.eligible).toBe(false);
    expect(data.plan).toBeNull();
    expect(data.blocks.map(b => b.gate)).toContain("target_not_accepted");
  });

  it("proposed target → exit 2, DECISION_PRUNE_NOT_ELIGIBLE with data.blocks", async () => {
    const p = await project("# RFC\n\n**Status:** proposed\n\nx", "done");
    const res = p.run([
      "decision",
      "prune",
      "design/decisions/foo-rfc.md",
      "--json",
    ]);
    const env = expectJsonErr(res);
    expect(env.error.code).toBe("DECISION_PRUNE_NOT_ELIGIBLE");
    expect(Array.isArray((env.data as { blocks?: unknown[] }).blocks)).toBe(
      true,
    );
    expect(res.code).toBe(2);
  });

  it("not-done referencing task → exit 2, DECISION_PRUNE_NOT_ELIGIBLE", async () => {
    const p = await project(ACCEPTED, "in_progress");
    const res = p.run([
      "decision",
      "prune",
      "design/decisions/foo-rfc.md",
      "--json",
    ]);
    expect(expectJsonErr(res).error.code).toBe("DECISION_PRUNE_NOT_ELIGIBLE");
    expect(res.code).toBe(2);
  });

  it("non-decision target → exit 2, DECISION_PRUNE_NOT_ELIGIBLE", async () => {
    const p = await project(ACCEPTED, "done");
    const res = p.run(["decision", "prune", "docs/cli-contract.md", "--json"]);
    expect(expectJsonErr(res).error.code).toBe("DECISION_PRUNE_NOT_ELIGIBLE");
    expect(res.code).toBe(2);
  });

  it("missing path → exit 2, CONFIG_ERROR", async () => {
    const p = await project(ACCEPTED, "done");
    const res = p.run(["decision", "prune", "--json"]);
    expect(expectJsonErr(res).error.code).toBe("CONFIG_ERROR");
    expect(res.code).toBe(2);
  });

  it("multiple paths → exit 2, CONFIG_ERROR", async () => {
    const p = await project(ACCEPTED, "done");
    const res = p.run(["decision", "prune", "a.md", "b.md", "--json"]);
    expect(expectJsonErr(res).error.code).toBe("CONFIG_ERROR");
    expect(res.code).toBe(2);
  });

  it("unreadable plan graph (invalid roadmap) → exit 2, plan_artifacts_unreadable", async () => {
    const p = await project(ACCEPTED, "done");
    await writeFile(join(p.dir, "design", "roadmap.yaml"), ":\n  not: [valid");
    const res = p.run([
      "decision",
      "prune",
      "design/decisions/foo-rfc.md",
      "--json",
    ]);
    const env = expectJsonErr(res);
    expect(env.error.code).toBe("DECISION_PRUNE_NOT_ELIGIBLE");
    const gates = (
      (env.data as { blocks?: { gate: string }[] }).blocks ?? []
    ).map(b => b.gate);
    expect(gates).toContain("plan_artifacts_unreadable");
    expect(res.code).toBe(2);
  });

  it("`decision --help` → Usage + Subcommands, exit 0", async () => {
    const p = await project(ACCEPTED, "done");
    const res = p.run(["decision", "--help"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("Usage:");
    expect(res.stdout).toContain("prune");
  });

  it("dry-run surfaces the retention policy (default keep-full / default) in the envelope", async () => {
    const p = await project(ACCEPTED, "done");
    const res = p.run([
      "decision",
      "prune",
      "design/decisions/foo-rfc.md",
      "--json",
    ]);
    const env = expectJsonOk<{ policy: string; policy_source: string }>(res);
    expect(env.data.policy).toBe("keep-full");
    expect(env.data.policy_source).toBe("default");
  });

  it("--policy overrides the policy for the invocation (source 'override')", async () => {
    const p = await project(ACCEPTED, "done");
    const res = p.run([
      "decision",
      "prune",
      "design/decisions/foo-rfc.md",
      "--policy",
      "prune-on-ship",
      "--json",
    ]);
    const env = expectJsonOk<{ policy: string; policy_source: string }>(res);
    expect(res.code).toBe(0);
    expect(env.data.policy).toBe("prune-on-ship");
    expect(env.data.policy_source).toBe("override");
  });

  it("an out-of-enum --policy → exit 2, CONFIG_ERROR", async () => {
    const p = await project(ACCEPTED, "done");
    const res = p.run([
      "decision",
      "prune",
      "design/decisions/foo-rfc.md",
      "--policy",
      "bogus",
      "--json",
    ]);
    expect(expectJsonErr(res).error.code).toBe("CONFIG_ERROR");
    expect(res.code).toBe(2);
  });

  it("`decision prune --help` → Usage / Options / Examples / --json, exit 0", async () => {
    const p = await project(ACCEPTED, "done");
    const res = p.run(["decision", "prune", "--help"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("Usage:");
    expect(res.stdout).toContain("Options:");
    expect(res.stdout).toContain("Examples:");
    expect(res.stdout).toContain("--json");
    // matches cli-contract: applicable gates, not "every failing gate"
    expect(res.stdout).toContain("every applicable failing gate");
    expect(res.stdout).not.toContain("every failing gate under");
  });

  it("human eligible → dry-run summary on stdout, exit 0", async () => {
    const p = await project(ACCEPTED, "done");
    const res = p.run(["decision", "prune", "design/decisions/foo-rfc.md"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("ELIGIBLE");
    expect(res.stdout).toContain("dry-run");
  });

  it("human ineligible → NOT ELIGIBLE on stderr, exit 2", async () => {
    const p = await project("# RFC\n\n**Status:** proposed\n\nx", "done");
    const res = p.run(["decision", "prune", "design/decisions/foo-rfc.md"]);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("NOT ELIGIBLE");
  });

  it("dry-run is ZERO-WRITE (eligible / human) — whole-project snapshot", async () => {
    const p = await project(ACCEPTED, "done");
    // Add an inbound link so the plan is non-trivial (items populated) — the
    // dry-run must STILL not touch it.
    await mkdir(join(p.dir, "docs"), { recursive: true });
    await writeFile(
      join(p.dir, "docs", "x.md"),
      "# X\n\nSee [d](../design/decisions/foo-rfc.md).\n",
    );
    const before = await snapshotTree(p.dir);

    for (const args of [
      ["decision", "prune", "design/decisions/foo-rfc.md", "--json"], // eligible
      ["decision", "prune", "design/decisions/foo-rfc.md"], // eligible, human
    ]) {
      p.run(args);
    }

    expect(await snapshotTree(p.dir)).toEqual(before); // entire tree byte-identical
  });

  it("--write applies the plan: removes the record, delinks the body link, appends the ledger (JSON)", async () => {
    const p = await project(ACCEPTED, "done");
    await mkdir(join(p.dir, "docs"), { recursive: true });
    await writeFile(
      join(p.dir, "docs", "x.md"),
      "# X\n\nSee [d](../design/decisions/foo-rfc.md).\n",
    );

    const res = p.run([
      "decision",
      "prune",
      "design/decisions/foo-rfc.md",
      "--write",
      "--json",
    ]);
    const env = expectJsonOk<{
      mode: string;
      decision: string;
      removed_file: string;
      link_rewrites_applied: { source_file: string; rewrite_action: string }[];
      ledger_row: string;
      ledger_action: string;
      warnings: unknown[];
    }>(res);
    expect(res.code).toBe(0);
    expect(env.data.mode).toBe("write");
    expect(env.data.removed_file).toBe("design/decisions/foo-rfc.md");
    expect(env.data.ledger_action).toBe("appended");
    expect(env.data.link_rewrites_applied.map(r => r.source_file)).toContain(
      "docs/x.md",
    );

    // disk effects: record gone, link delinked, ledger row present + readable
    await expect(
      readFile(join(p.dir, "design", "decisions", "foo-rfc.md"), "utf8"),
    ).rejects.toThrow();
    expect(await readFile(join(p.dir, "docs", "x.md"), "utf8")).toBe(
      "# X\n\nSee d.\n",
    );
    const ledger = await readFile(
      join(p.dir, "design", "decisions", "PRUNED.md"),
      "utf8",
    );
    expect(ledger).toContain("`design/decisions/foo-rfc.md`");
    // NO leftover temp file from the atomic writes
    const tree = await snapshotTree(p.dir);
    expect(Object.keys(tree).some(f => /\.tmp-|\.prune-tmp/.test(f))).toBe(
      false,
    );
  });

  it("a commit-time write failure → DECISION_PRUNE_WRITE_FAILED JSON (exit 2, not an internal exit 3)", async () => {
    const p = await project(ACCEPTED, "done");
    await mkdir(join(p.dir, "docs"), { recursive: true });
    await writeFile(
      join(p.dir, "docs", "x.md"),
      "See [d](../design/decisions/foo-rfc.md).\n",
    );
    // PRUNED.md as a directory makes the ledger step fail (EISDIR).
    await mkdir(join(p.dir, "design", "decisions", "PRUNED.md"), {
      recursive: true,
    });

    const res = p.run([
      "decision",
      "prune",
      "design/decisions/foo-rfc.md",
      "--write",
      "--json",
    ]);
    const env = expectJsonErr(res);
    expect(res.code).toBe(2);
    expect(env.error.code).toBe("DECISION_PRUNE_WRITE_FAILED");
    expect(env.data).toMatchObject({
      mode: "write",
      phase: "append_ledger",
      partial_applied: false,
    });
    // ledger-first ordering → the inbound doc was never touched
    expect(await readFile(join(p.dir, "docs", "x.md"), "utf8")).toBe(
      "See [d](../design/decisions/foo-rfc.md).\n",
    );
    expect(
      await readFile(join(p.dir, "design", "decisions", "foo-rfc.md"), "utf8"),
    ).toContain("accepted");
  });

  it("a second --write after the record is gone → DECISION_PRUNE_NOT_ELIGIBLE (target_missing)", async () => {
    const p = await project(ACCEPTED, "done");
    p.run([
      "decision",
      "prune",
      "design/decisions/foo-rfc.md",
      "--write",
      "--json",
    ]); // first prune
    const res = p.run([
      "decision",
      "prune",
      "design/decisions/foo-rfc.md",
      "--write",
      "--json",
    ]);
    const env = expectJsonErr(res);
    expect(env.error.code).toBe("DECISION_PRUNE_NOT_ELIGIBLE");
    const gates = (
      (env.data as { blocks?: { gate: string }[] }).blocks ?? []
    ).map(b => b.gate);
    expect(gates).toContain("target_missing");
    expect(res.code).toBe(2);
  });

  it("--write on an ineligible target writes nothing (whole-project snapshot)", async () => {
    const p = await project("# RFC\n\n**Status:** proposed\n\nx", "done");
    const before = await snapshotTree(p.dir);
    const res = p.run([
      "decision",
      "prune",
      "design/decisions/foo-rfc.md",
      "--write",
      "--json",
    ]);
    expect(expectJsonErr(res).error.code).toBe("DECISION_PRUNE_NOT_ELIGIBLE");
    expect(res.code).toBe(2);
    expect(await snapshotTree(p.dir)).toEqual(before);
  });

  it("ineligible runs are also ZERO-WRITE (whole-project snapshot)", async () => {
    const p = await project("# RFC\n\n**Status:** proposed\n\nx", "done");
    const before = await snapshotTree(p.dir);
    p.run(["decision", "prune", "design/decisions/foo-rfc.md", "--json"]);
    p.run(["decision", "prune", "design/decisions/foo-rfc.md"]);
    expect(await snapshotTree(p.dir)).toEqual(before);
  });

  it("cluster-level errors honor --json (unknown subcommand)", async () => {
    const p = await project(ACCEPTED, "done");
    for (const args of [
      ["decision", "nope", "--json"],
      ["decision", "--json"],
    ]) {
      const res = p.run(args);
      expect(res.code).toBe(2);
      expect(expectJsonErr(res).error.code).toBe("CONFIG_ERROR");
    }
  });

  it("top-level `--help` lists the decision command (discoverability)", async () => {
    const p = await project(ACCEPTED, "done");
    const res = p.run(["--help"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("decision");
  });
});

describe("decision prune — symlinked roadmap cannot bypass the referencing-task gate (security)", () => {
  it("a roadmap symlinked OUTSIDE that hides a referencing not-done task → prune fails closed, decision preserved", async () => {
    // SECURITY (Blocker 2): collectPlanArtifacts feeds prune's referencing-task
    // gate. P1-T1 is NOT done and references foo-rfc.md, so prune is normally
    // BLOCKED. If the roadmap could be symlinked to an external EMPTY roadmap, the
    // referencing task would vanish and prune would wrongly become eligible —
    // deleting a still-referenced decision. With the roadmap read contained, the
    // symlink escape becomes a graph-file FileIssue → plan_artifacts_unreadable →
    // fail-closed; the decision is never deleted.
    const p = await project(ACCEPTED, "planned"); // P1-T1 planned (not done) → baseline blocked
    const decisionPath = join(p.dir, "design", "decisions", "foo-rfc.md");
    const before = await readFile(decisionPath, "utf8");

    const outside = await mkdtemp(join(tmpdir(), "decprune-out-"));
    cleanups.push(() => rm(outside, { recursive: true, force: true }));
    await writeFile(join(outside, "roadmap.yaml"), "phases: []\n"); // valid, empty → hides P1-T1
    await rm(join(p.dir, "design", "roadmap.yaml"), { force: true });
    await symlink(
      join(outside, "roadmap.yaml"),
      join(p.dir, "design", "roadmap.yaml"),
    );

    const res = p.run([
      "decision",
      "prune",
      "design/decisions/foo-rfc.md",
      "--write",
      "--json",
    ]);
    // Not eligible (fail-closed) — never a clean success that deletes the file.
    expect(res.code).not.toBe(0);
    const parsed = JSON.parse(res.stdout) as { ok: boolean };
    expect(parsed.ok).toBe(false);
    // The decision is byte-identical: the external roadmap did NOT authorize a prune.
    expect(await readFile(decisionPath, "utf8")).toBe(before);
  });
});

describe("decision prune — nested decision paths", () => {
  it("nested accepted decision with no referencing task → eligible to prune", async () => {
    const p = await createTempProject({
      init: true,
      prefix: "decprune-nested-",
    });
    cleanups.push(p.cleanup);
    await mkdir(join(p.dir, "design", "decisions", "sub"), { recursive: true });
    await mkdir(join(p.dir, "design", "phases"), { recursive: true });
    await writeFile(
      join(p.dir, "design", "decisions", "sub", "nested-rfc.md"),
      ACCEPTED,
    );
    await writeFile(
      join(p.dir, "design", "roadmap.yaml"),
      `phases:\n  - id: P1\n    path: design/phases/P1.yaml\n    weight: 10\n`,
    );
    await writeFile(
      join(p.dir, "design", "phases", "P1.yaml"),
      `id: P1
name: P1
weight: 10
confidence: high
risk: low
status: done
objective: An objective long enough
definition_of_done:
  - DoD that is clearly long enough
verification:
  commands:
    - pnpm test
tasks:
  - id: P1-T1
    type: feature
    ambiguity: low
    risk: low
    context_size: small
    write_surface: low
    verification_strength: medium
    expected_duration: short
    status: done
    description: Implements the thing
`,
    );

    const res = p.run([
      "decision",
      "prune",
      "design/decisions/sub/nested-rfc.md",
      "--json",
    ]);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout) as {
      ok: boolean;
      data: { eligible: boolean };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.eligible).toBe(true);
  });

  it("nested accepted decision with a not-done referencing task → blocked", async () => {
    const p = await createTempProject({
      init: true,
      prefix: "decprune-nested-block-",
    });
    cleanups.push(p.cleanup);
    await mkdir(join(p.dir, "design", "decisions", "sub"), { recursive: true });
    await mkdir(join(p.dir, "design", "phases"), { recursive: true });
    const nestedPath = "design/decisions/sub/nested-rfc.md";
    await writeFile(join(p.dir, nestedPath), ACCEPTED);
    await writeFile(
      join(p.dir, "design", "roadmap.yaml"),
      `phases:\n  - id: P1\n    path: design/phases/P1.yaml\n    weight: 10\n`,
    );
    await writeFile(
      join(p.dir, "design", "phases", "P1.yaml"),
      PHASE("planned", nestedPath),
    );

    const res = p.run(["decision", "prune", nestedPath, "--json"]);
    expect(expectJsonErr(res).error.code).toBe("DECISION_PRUNE_NOT_ELIGIBLE");
    expect(res.code).toBe(2);
  });

  it("nested decision --write prunes the file and appends to PRUNED.md", async () => {
    const p = await createTempProject({
      init: true,
      prefix: "decprune-nested-write-",
    });
    cleanups.push(p.cleanup);
    await mkdir(join(p.dir, "design", "decisions", "sub"), { recursive: true });
    await mkdir(join(p.dir, "design", "phases"), { recursive: true });
    const nestedPath = "design/decisions/sub/nested-rfc.md";
    await writeFile(join(p.dir, nestedPath), ACCEPTED);
    await writeFile(
      join(p.dir, "design", "roadmap.yaml"),
      `phases:\n  - id: P1\n    path: design/phases/P1.yaml\n    weight: 10\n`,
    );
    await writeFile(
      join(p.dir, "design", "phases", "P1.yaml"),
      `id: P1
name: P1
weight: 10
confidence: high
risk: low
status: done
objective: An objective long enough
definition_of_done:
  - DoD that is clearly long enough
verification:
  commands:
    - pnpm test
tasks:
  - id: P1-T1
    type: feature
    ambiguity: low
    risk: low
    context_size: small
    write_surface: low
    verification_strength: medium
    expected_duration: short
    status: done
    description: Implements the thing
`,
    );

    const res = p.run(["decision", "prune", nestedPath, "--write", "--json"]);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout) as { ok: boolean };
    expect(parsed.ok).toBe(true);

    // The nested .md is deleted.
    const { access } = await import("node:fs/promises");
    try {
      await access(join(p.dir, nestedPath));
      expect.unreachable("file should be deleted");
    } catch {
      // expected — file is gone
    }

    // PRUNED.md has the nested path appended.
    const pruned = await readFile(
      join(p.dir, "design", "decisions", "PRUNED.md"),
      "utf8",
    );
    expect(pruned).toContain(nestedPath);
  });

  it("nested decision --write rewrites inbound links pointing to the nested path", async () => {
    const p = await createTempProject({
      init: true,
      prefix: "decprune-nested-link-",
    });
    cleanups.push(p.cleanup);
    await mkdir(join(p.dir, "design", "decisions", "sub"), { recursive: true });
    await mkdir(join(p.dir, "design", "phases"), { recursive: true });
    await mkdir(join(p.dir, "docs"), { recursive: true });
    const nestedPath = "design/decisions/sub/nested-rfc.md";
    await writeFile(join(p.dir, nestedPath), ACCEPTED);
    await writeFile(
      join(p.dir, "design", "roadmap.yaml"),
      `phases:\n  - id: P1\n    path: design/phases/P1.yaml\n    weight: 10\n`,
    );
    await writeFile(
      join(p.dir, "design", "phases", "P1.yaml"),
      PHASE("done", nestedPath),
    );
    // Inbound link from docs/x.md to the nested decision
    await writeFile(
      join(p.dir, "docs", "x.md"),
      "# X\n\nSee [d](../design/decisions/sub/nested-rfc.md).\n",
    );

    // Dry-run: link_rewrite.items should contain the nested target
    const dryRes = p.run(["decision", "prune", nestedPath, "--json"]);
    const dryEnv = expectJsonOk<{
      plan: {
        link_rewrite: { status: string; items: Record<string, unknown>[] };
      };
    }>(dryRes);
    expect(dryEnv.data.plan.link_rewrite.status).toBe("ready");
    const item = dryEnv.data.plan.link_rewrite.items.find(
      i => i.source_file === "docs/x.md",
    );
    expect(item).toBeDefined();
    expect(item).toMatchObject({
      link_kind: "inline",
      rewrite_action: "delink",
      normalized_target: nestedPath,
    });

    // --write: the inbound link is rewritten (delinked)
    const writeRes = p.run([
      "decision",
      "prune",
      nestedPath,
      "--write",
      "--json",
    ]);
    expect(writeRes.code).toBe(0);
    const after = await readFile(join(p.dir, "docs", "x.md"), "utf8");
    expect(after).not.toContain("nested-rfc.md");
  });
});
