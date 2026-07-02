import { mkdirOwned } from "../project-fs/operations.ts";
import {
  resolvePhaseWritePath,
  resolveRoadmapWritePath,
} from "../project-fs/authority-resolvers.ts";
import { resolveProjectScaffoldWritePath } from "../project-fs/authorities/project-config-authority.ts";
import { stringify as toYaml } from "yaml";
import { atomicWriteText } from "../../io/atomic-text.ts";
import { Phase } from "../schemas/phase.ts";
import type { Task } from "../schemas/task.ts";
import { Roadmap, PhaseRef } from "../schemas/roadmap.ts";
import { loadRoadmap } from "../plan/roadmap.ts";
import { assertSafePlanId } from "../schemas/plan-id.ts";

export type Confidence = "low" | "medium" | "high";
export type Risk = "low" | "medium" | "high";

/**
 * Reserved phase ids. Only the sample-phase generator
 * (`writeSamplePhase` in `src/commands/init.ts`) may create a phase with
 * one of these ids, via the internal `_isSampleCreation: true` bypass.
 * Every other call site (flag-based `phase add`, interactive `phase new`
 * wizard, `phase import`) is rejected with CONFIG_ERROR (exit 2).
 *
 * Kept as a small constant array rather than a config field so adding to
 * the list requires an RFC update — that intentional friction matches the
 * "scope discipline" decision.
 */
export const RESERVED_PHASE_IDS: readonly string[] = ["TUTORIAL"];

export type CreatePhaseInput = {
  cwd: string;
  id: string;
  name: string;
  weight: number;
  objective: string;
  confidence?: Confidence;
  risk?: Risk;
  verifyCommands?: string[];
  doneCriteria?: string[];
  /**
   * Optional initial tasks to embed in the generated phase YAML.
   * Used by `phase import`; the flag-based `phase add` and the
   * interactive wizard omit this and grow tasks separately later.
   */
  tasks?: Task[];
  nonGoals?: string[];
  requiresDecision?: boolean;
  /**
   * Internal-only escape hatch. The sample-phase
   * generator in `src/commands/init.ts` sets this to `true` so it can
   * create the reserved-id `TUTORIAL` phase. Public callers MUST omit
   * the field — passing it from a non-bootstrap path is a contract
   * violation. Not exposed through any CLI flag.
   */
  _isSampleCreation?: boolean;
};

export type CreatePhaseResult = {
  path: string;
  ref: PhaseRef;
};

async function saveRoadmap(cwd: string, roadmap: Roadmap): Promise<void> {
  const path = await resolveRoadmapWritePath(cwd);
  await atomicWriteText(path, toYaml(roadmap));
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

/**
 * Domain service for adding a phase. Both the flag-based `phase add` CLI
 * handler and the interactive `phase new` wizard go through this entry
 * point so the rules (id-collision check, slug derivation, file layout,
 * roadmap append) live in one place.
 *
 * Throws an Error with `.code === "DUPLICATE_PHASE_ID"` when the id is
 * already present in roadmap.yaml.
 */
export async function createPhase(
  opts: CreatePhaseInput,
): Promise<CreatePhaseResult> {
  const {
    cwd,
    id,
    name,
    weight,
    objective,
    confidence = "medium",
    risk = "medium",
    verifyCommands = ["pnpm test"],
    doneCriteria = ["All tasks are done"],
  } = opts;

  // Identifier safety (write chokepoint). `id` becomes a path segment below
  // (`design/phases/<id>-<slug>.yaml`); an id like `../evil` would escape the
  // phases dir. Validate BEFORE any path construction so a traversal attempt
  // never reaches atomicWriteText. (The read schemas already enforce this for
  // existing files; this closes the create path.)
  assertSafePlanId(id, "Phase id");

  // Reserved-id check. Block creation of phases with a
  // reserved id unless the internal `_isSampleCreation: true` bypass is
  // set — only `writeSamplePhase` (init's sample-phase generator) does so.
  if (RESERVED_PHASE_IDS.includes(id) && opts._isSampleCreation !== true) {
    const err = new Error(
      `Phase id "${id}" is reserved for the sample-phase artifact created by \`init --sample-phase\`. Pick a different id.`,
    );
    (err as NodeJS.ErrnoException).code = "CONFIG_ERROR";
    throw err;
  }

  const roadmap = await loadRoadmap(cwd);

  if (roadmap.phases.some(p => p.id === id)) {
    const err = new Error(`Phase "${id}" already exists in roadmap.yaml.`);
    (err as NodeJS.ErrnoException).code = "DUPLICATE_PHASE_ID";
    throw err;
  }

  const slug = slugify(name);
  const filename = `${id}-${slug}.yaml`;
  const relPath = `design/phases/${filename}`;

  // Parse the assembled phase before writing so no invalid plan state (e.g. an
  // unsafe id smuggled in via an embedded imported task) is ever persisted.
  const phase: Phase = Phase.parse({
    id,
    name,
    weight,
    confidence,
    risk,
    status: "planned",
    objective,
    definition_of_done: doneCriteria,
    verification: { commands: verifyCommands },
    ...(opts.nonGoals && opts.nonGoals.length > 0
      ? { non_goals: opts.nonGoals }
      : {}),
    ...(opts.requiresDecision === true ? { requires_decision: true } : {}),
    ...(opts.tasks && opts.tasks.length > 0 ? { tasks: opts.tasks } : {}),
  });

  await mkdirOwned(await resolveProjectScaffoldWritePath(cwd, "design/phases"), {
    recursive: true,
  });
  await atomicWriteText(
    await resolvePhaseWritePath(cwd, relPath),
    toYaml(phase),
  );

  const ref: PhaseRef = PhaseRef.parse({ id, path: relPath, weight });
  roadmap.phases.push(ref);
  await saveRoadmap(cwd, roadmap);

  return { path: relPath, ref };
}
