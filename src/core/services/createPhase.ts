import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml, stringify as toYaml } from "yaml";
import { atomicWriteText } from "../../io/atomic-text.ts";
import { Phase } from "../schemas/phase.ts";
import type { Task } from "../schemas/task.ts";
import { Roadmap, type PhaseRef } from "../schemas/roadmap.ts";

export type Confidence = "low" | "medium" | "high";
export type Risk = "low" | "medium" | "high";

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
};

export type CreatePhaseResult = {
  path: string;
  ref: PhaseRef;
};

async function loadRoadmap(cwd: string): Promise<Roadmap> {
  const raw = await readFile(join(cwd, "design", "roadmap.yaml"), "utf8");
  return Roadmap.parse(parseYaml(raw) as unknown);
}

async function saveRoadmap(cwd: string, roadmap: Roadmap): Promise<void> {
  await atomicWriteText(join(cwd, "design", "roadmap.yaml"), toYaml(roadmap));
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
export async function createPhase(opts: CreatePhaseInput): Promise<CreatePhaseResult> {
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

  const roadmap = await loadRoadmap(cwd);

  if (roadmap.phases.some((p) => p.id === id)) {
    const err = new Error(`Phase "${id}" already exists in roadmap.yaml.`);
    (err as NodeJS.ErrnoException).code = "DUPLICATE_PHASE_ID";
    throw err;
  }

  const slug = slugify(name);
  const filename = `${id}-${slug}.yaml`;
  const relPath = `design/phases/${filename}`;
  const absPath = join(cwd, relPath);

  const phase: Phase = {
    id,
    name,
    weight,
    confidence,
    risk,
    status: "planned",
    objective,
    definition_of_done: doneCriteria,
    verification: { commands: verifyCommands },
    ...(opts.nonGoals && opts.nonGoals.length > 0 ? { non_goals: opts.nonGoals } : {}),
    ...(opts.requiresDecision === true ? { requires_decision: true } : {}),
    ...(opts.tasks && opts.tasks.length > 0 ? { tasks: opts.tasks } : {}),
  };

  await mkdir(join(cwd, "design", "phases"), { recursive: true });
  await atomicWriteText(absPath, toYaml(phase));

  const ref: PhaseRef = { id, path: relPath, weight };
  roadmap.phases.push(ref);
  await saveRoadmap(cwd, roadmap);

  return { path: relPath, ref };
}
