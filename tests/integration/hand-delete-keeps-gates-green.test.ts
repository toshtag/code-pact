import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run as cliRun, ensureCliBuilt, type RunResult } from "../helpers/cli.ts";
import { checkDocLinks } from "../../scripts/check-doc-links.ts";

// Hand-deleting design docs keeps every gate green.
//
// End-to-end on a temp project: archive a completed phase, retire two decisions,
// then `rm -rf design/decisions` by hand. After that, every control-plane gate AND
// the doc-link checker must still pass — because the deleted material's runtime
// truth now lives in `.code-pact/state` (an archive snapshot for the phase, a
// decision-state record for each decision), and the readers/checkers resolve from
// those records instead of the gone files.
//
// The deletion goes through the shipped verbs (`phase archive --write` /
// `decision retire --write`), then a bare directory `rm` on top — so the test
// covers both the verb path and a raw hand-delete of the whole directory.
//
// The headline assertion is the doc-link checker: inbound `.md` links pointing at
// the removed decisions must resolve as *retired* via their records, not report as
// broken. A negative control (the same links, but a decision deleted WITHOUT a
// record) proves that green is carried by the record, not by the checker ignoring
// missing decision links.
//
// No `src/` change: every reader, checker, and verb already shipped; this test
// only proves they compose correctly under a real hand-delete.

let tmpDir: string;
function run(args: string[]): RunResult {
  return cliRun(tmpDir, args, { env: { CODE_PACT_DISABLE_LOCKS: "" } });
}
function json(r: RunResult): { ok?: boolean; data?: Record<string, unknown>; error?: { code?: string } } {
  try {
    return JSON.parse(r.stdout);
  } catch {
    return {};
  }
}
const silent = { write: () => true };
const absent = async (p: string): Promise<boolean> => {
  try {
    await stat(p);
    return false;
  } catch {
    return true;
  }
};

const TASK_FIELDS = `    ambiguity: low
    risk: low
    context_size: small
    write_surface: low
    verification_strength: medium
    expected_duration: short`;

const ROADMAP = `phases:
  - id: P1
    path: design/phases/P1.yaml
    weight: 1
  - id: P2
    path: design/phases/P2.yaml
    weight: 1
`;
// P1 is complete (archivable); its only task P1-T1 is done.
const P1 = `id: P1
name: Foundations
weight: 1
confidence: high
risk: low
status: done
objective: An objective long enough here
definition_of_done:
  - DoD that is clearly long enough
verification:
  commands:
    - "true"
tasks:
  - id: P1-T1
    type: feature
${TASK_FIELDS}
    status: done
`;
// P2 is still active. P2-T1 is active and exercises BOTH deletions at once: it
// references the accepted decision (decision_refs) AND depends on the archived
// phase's task (depends_on P1-T1) — so the test only passes if the decision record
// AND the phase snapshot both resolve correctly.
const P2 = `id: P2
name: Next
weight: 1
confidence: high
risk: low
status: in_progress
objective: An objective long enough here
definition_of_done:
  - DoD that is clearly long enough
verification:
  commands:
    - "true"
tasks:
  - id: P2-T1
    type: feature
${TASK_FIELDS}
    status: in_progress
    description: Implements the next thing
    requires_decision: true
    decision_refs:
      - design/decisions/accepted-rfc.md
    depends_on:
      - P1-T1
  - id: P2-T2
    type: feature
${TASK_FIELDS}
    status: done
    description: A done task that referenced the blocked decision
    acceptance_refs:
      - design/decisions/blocked-rfc.md
`;
const ACCEPTED = "# RFC: Accepted\n\n**Status:** accepted (P1, 2026-06)\n\n## Decision\n\nSettled.\n";
const BLOCKED = "# RFC: Blocked\n\n**Status:** proposed\n\n## Decision\n\nNot yet settled.\n";
const PROGRESS = `events:
  - task_id: P1-T1
    status: done
    at: 2026-06-01T00:00:00.000Z
    actor: agent
  - task_id: P2-T1
    status: started
    at: 2026-06-02T00:00:00.000Z
    actor: agent
  - task_id: P2-T2
    status: done
    at: 2026-06-02T00:00:00.000Z
    actor: agent
`;
// Inbound doc-links into BOTH decisions (plus a #fragment) — the heart of this test.
// After the decisions are gone, these must resolve as retired via the records, not
// report as broken.
const NOTES = `# Notes

See [the accepted decision](../design/decisions/accepted-rfc.md) and
[its decision section](../design/decisions/accepted-rfc.md#decision), plus
[the blocked decision](../design/decisions/blocked-rfc.md).
`;

async function scaffold(): Promise<void> {
  const init = run(["init", "--non-interactive", "--locale", "en-US", "--agent", "claude-code", "--json"]);
  if (init.code !== 0) throw new Error(`init failed: ${init.stdout}${init.stderr}`);
  await mkdir(join(tmpDir, "design", "decisions"), { recursive: true });
  await mkdir(join(tmpDir, "design", "phases"), { recursive: true });
  await mkdir(join(tmpDir, "docs"), { recursive: true });
  await writeFile(join(tmpDir, "design", "roadmap.yaml"), ROADMAP, "utf8");
  await writeFile(join(tmpDir, "design", "phases", "P1.yaml"), P1, "utf8");
  await writeFile(join(tmpDir, "design", "phases", "P2.yaml"), P2, "utf8");
  await writeFile(join(tmpDir, "design", "decisions", "accepted-rfc.md"), ACCEPTED, "utf8");
  await writeFile(join(tmpDir, "design", "decisions", "blocked-rfc.md"), BLOCKED, "utf8");
  await mkdir(join(tmpDir, ".code-pact", "state"), { recursive: true });
  await writeFile(join(tmpDir, ".code-pact", "state", "progress.yaml"), PROGRESS, "utf8");
  await writeFile(join(tmpDir, "docs", "notes.md"), NOTES, "utf8");
}

const P1_YAML = () => join(tmpDir, "design", "phases", "P1.yaml");
const ACC_MD = () => join(tmpDir, "design", "decisions", "accepted-rfc.md");
const BLK_MD = () => join(tmpDir, "design", "decisions", "blocked-rfc.md");
const DECISIONS_DIR = () => join(tmpDir, "design", "decisions");

function decisionCheckOk(r: RunResult): boolean {
  const checks = (JSON.parse(r.stdout) as { data?: { checks?: { name: string; ok: boolean }[] } }).data?.checks ?? [];
  return checks.find((c) => c.name === "decision")?.ok === true;
}

beforeAll(() => ensureCliBuilt(), 60_000);
beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "code-pact-hand-delete-int-"));
});
afterEach(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

describe("hand-deleting a completed phase + rm -rf design/decisions keeps all gates green", () => {
  it("archive + retire via the verbs, then a bare rm of the directory; every gate (incl. check:docs) stays green", async () => {
    await scaffold();
    const notesBefore = await readFile(join(tmpDir, "docs", "notes.md"), "utf8");

    // --- hand-delete through the real verbs ---
    expect(run(["phase", "archive", "P1", "--write", "--json"]).code).toBe(0);
    expect(run(["decision", "retire", "design/decisions/accepted-rfc.md", "--write", "--json"]).code).toBe(0);
    expect(run(["decision", "retire", "design/decisions/blocked-rfc.md", "--write", "--json"]).code).toBe(0);
    // --- then a bare hand-rm of the whole decisions directory (the `rm -rf` path) ---
    await rm(DECISIONS_DIR(), { recursive: true, force: true });

    // The files were really deleted — the live files AND the directory are gone.
    expect(await absent(P1_YAML())).toBe(true);
    expect(await absent(ACC_MD())).toBe(true);
    expect(await absent(BLK_MD())).toBe(true);
    expect(await absent(DECISIONS_DIR())).toBe(true);
    // The records survive under .code-pact/state.
    expect(await absent(join(tmpDir, ".code-pact", "state", "archive", "phases", "P1.json"))).toBe(false);

    // --- the full control-plane gate stays green ---
    expect(json(run(["validate", "--json"])).ok).toBe(true);
    expect(json(run(["doctor", "--json"])).ok).toBe(true);
    const lint = run(["plan", "lint", "--strict", "--json"]);
    expect(json(lint).ok).toBe(true); // strict green — every issue is advisory (affects_exit:false)
    // The decision_ref / acceptance_ref / depends_on issues are present ONLY as
    // affects_exit:false ADVISORIES (the record/snapshot resolves them); NONE is a
    // strict-failing error. (A retired-decision advisory IS the correct retired signal.)
    const issues =
      (JSON.parse(lint.stdout) as {
        data?: {
          issues?: {
            code: string;
            severity: string;
            task_id?: string;
            details?: { retired_decision?: boolean };
          }[];
        };
      }).data?.issues ?? [];
    const errorCodes = issues.filter((i) => i.severity === "error").map((i) => i.code);
    expect(errorCodes).not.toContain("TASK_DECISION_REF_NOT_FOUND");
    expect(errorCodes).not.toContain("PHASE_SNAPSHOT_INVALID");
    expect(errorCodes).not.toContain("TASK_DEPENDS_ON_UNRESOLVED");
    expect(errorCodes).toEqual([]); // no strict-failing error at all
    // The retired accepted decision is not merely error-free — it surfaces a positive
    // signal: the active P2-T1 decision_ref downgrades to a `retired_decision` advisory
    // (warning, affects_exit:false) because the accepted record RELEASES its gate.
    // Asserting the advisory is present (not just that no error fired) proves the link
    // was resolved as *retired*, not silently dropped.
    const retiredAdvisory = issues.find(
      (i) => i.code === "TASK_DECISION_REF_NOT_FOUND" && i.task_id === "P2-T1",
    );
    expect(retiredAdvisory?.severity).toBe("warning");
    expect(retiredAdvisory?.details?.retired_decision).toBe(true);
    expect(json(run(["task", "context", "P2-T1", "--agent", "claude-code", "--json"])).ok).toBe(true);
    const prep = run(["task", "prepare", "P2-T1", "--agent", "claude-code", "--json"]);
    expect(json(prep).ok).toBe(true);
    expect(prep.stdout).not.toContain("wait_for_dependencies");

    // verify's decision check is released — the accepted record carries the active
    // decision_refs gate after the .md is gone. (Read the check verdict, not the exit
    // code: verify may exit non-zero for unrelated checks.)
    expect(decisionCheckOk(run(["verify", "--phase", "P2", "--task", "P2-T1", "--json"]))).toBe(true);

    // --- the headline: the doc-link checker stays green via the retired-decision records ---
    const code = await checkDocLinks({ repoRoot: tmpDir, stdout: silent, stderr: silent });
    expect(code).toBe(0); // inbound links + #fragment resolve as retired, NOT broken

    // The inbound links were NOT rewritten — byte-identical (retire rewrites nothing).
    expect(await readFile(join(tmpDir, "docs", "notes.md"), "utf8")).toBe(notesBefore);
  });
});

describe("negative control: the green is carried by the record, not by a blind checker", () => {
  it("the SAME inbound links with a hand-rm'd decision and NO record → the doc-link checker reports BROKEN", async () => {
    await scaffold();
    // Hand-delete the accepted decision WITHOUT retiring it (no record written).
    await rm(ACC_MD());
    // (blocked-rfc stays live; only accepted-rfc is gone with no record.)
    // Capture stderr so we can PIN that the failure is specifically the recordless
    // accepted-rfc link (not some unrelated init-scaffold link) — proving the
    // positive case's green is record-carried, not coincidental.
    const errLines: string[] = [];
    const err = { write: (s: string) => (errLines.push(s), true) };
    const code = await checkDocLinks({ repoRoot: tmpDir, stdout: silent, stderr: err });
    expect(code).toBe(1); // the link to the recordless deleted decision is BROKEN
    const errText = errLines.join("");
    expect(errText).toContain("accepted-rfc.md"); // the broken link is exactly this one
    expect(errText).not.toContain("blocked-rfc.md"); // the live one is fine (live-wins)
  });
});
