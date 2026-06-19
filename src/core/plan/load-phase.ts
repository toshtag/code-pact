import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { Phase } from "../schemas/phase.ts";
import { resolveWithinProject } from "../path-safety.ts";

// The single seam that reads one LIVE phase YAML file off disk and validates it
// as a full `Phase`. This exact body used to be byte-duplicated across ~8
// command/core files; consolidating it (2a) and routing the raw-throwing strict
// readers onto it (2c: resolve-task.ts, phase-reconcile.ts, adapters/claude.ts;
// pack/verify/progress/recommend/task-prepare/task-add/phase-import/phase
// already use it) mirrors the PR0 `loadRoadmap` consolidation one level down.
//
// SCOPE — live phase YAML ONLY; full `Phase` ONLY. This loader must NOT
// synthesize an archived phase. A phase snapshot
// (`.code-pact/state/archive/phases/<id>.json`) is INTENTIONALLY smaller than
// `Phase` — it has no `objective` / `definition_of_done` / `verification` /
// task `description` / prose — so it is NOT a `Phase` and must never be coerced
// into one to be returned from here. The design-docs-ephemeral archived-phase
// support (step 4) belongs in a SEPARATE archived-aware resolver (or a
// `live | archived` discriminated union), designed per caller — never by
// teaching this function to fall back to a snapshot. Callers that legitimately
// resolve archived references differ: `resolve-task.ts` may eventually need
// archived task-id lookup, but `phase-reconcile.ts` rewrites the LIVE file and
// `adapters/claude.ts` reads `verification.commands` (absent from snapshots) —
// neither may ever be fed a snapshot.
//
// Fail-closed by construction: a missing or invalid phase file throws (ENOENT /
// ZodError). A roadmap-referenced phase is a control-plane input, not optional
// context — missing-tolerance, where wanted, is a SEPARATE archived-aware path,
// never a swallowed throw here.
export async function loadPhase(cwd: string, path: string): Promise<Phase> {
  // `path` is the roadmap's (project-controlled) phase ref. Resolve it through
  // the project boundary so a `..`/absolute ref or a symlinked `design/phases/*`
  // cannot read an out-of-project file into the rendered context pack / generated
  // skills (CWE-59) — the same agent-facing-read class as the constitution leak.
  // A path-safety refusal maps to CONFIG_ERROR (fail-closed, structured — this is
  // a control-plane input, NOT an optional source, so it is never swallowed to
  // null). A missing/invalid phase still throws ENOENT/ZodError as before.
  let abs: string;
  try {
    abs = await resolveWithinProject(cwd, path);
  } catch (err) {
    const e = new Error(
      `Phase path "${path}" is not a safe project-relative path: ${(err as Error).message}`,
    );
    (e as NodeJS.ErrnoException).code = "CONFIG_ERROR";
    throw e;
  }
  let raw: string;
  try {
    raw = await readFile(abs, "utf8");
  } catch (err) {
    // ENOENT stays RAW: a missing roadmap-referenced phase is the legitimate
    // archived-fallback signal (resolve-task keys on `code === "ENOENT"`). Any
    // OTHER read failure on a project-controlled path (the phase ref is a
    // directory → EISDIR, an intermediate is a file → ENOTDIR, EACCES, …) is an
    // adversarial input → CONFIG_ERROR, not an uncoded exit-3 internal error.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw err;
    const e = new Error(`Phase at ${abs} cannot be read: ${(err as Error).message}`);
    (e as NodeJS.ErrnoException).code = "CONFIG_ERROR";
    throw e;
  }
  try {
    return Phase.parse(parseYaml(raw) as unknown);
  } catch (err) {
    // Malformed YAML / schema violation on a project-controlled phase → structured.
    const e = new Error(`Phase at ${abs} is malformed (YAML or schema): ${(err as Error).message}`);
    (e as NodeJS.ErrnoException).code = "CONFIG_ERROR";
    throw e;
  }
}
