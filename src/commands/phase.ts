import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { parse as parseYaml, stringify as toYaml } from "yaml";
import { Phase, type PhaseStatus } from "../core/schemas/phase.ts";
import { Roadmap, PhaseRef } from "../core/schemas/roadmap.ts";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function loadRoadmap(cwd: string): Promise<Roadmap> {
  const raw = await readFile(join(cwd, "design", "roadmap.yaml"), "utf8");
  const data: unknown = parseYaml(raw);
  return Roadmap.parse(data);
}

async function saveRoadmap(cwd: string, roadmap: Roadmap): Promise<void> {
  await writeFile(join(cwd, "design", "roadmap.yaml"), toYaml(roadmap), "utf8");
}

async function loadPhase(cwd: string, ref: PhaseRef): Promise<Phase> {
  const raw = await readFile(join(cwd, ref.path), "utf8");
  const data: unknown = parseYaml(raw);
  return Phase.parse(data);
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

// ---------------------------------------------------------------------------
// phase add
// ---------------------------------------------------------------------------

export type PhaseAddOptions = {
  cwd: string;
  id: string;
  name: string;
  weight: number;
  objective: string;
  confidence: "low" | "medium" | "high";
  risk: "low" | "medium" | "high";
  verifyCommands: string[];
  definitionOfDone: string[];
};

export type PhaseAddResult = {
  path: string;
  ref: PhaseRef;
};

export async function runPhaseAdd(opts: PhaseAddOptions): Promise<PhaseAddResult> {
  const { cwd, id, name, weight, objective, confidence, risk, verifyCommands, definitionOfDone } =
    opts;

  const roadmap = await loadRoadmap(cwd);

  // Guard duplicate ID
  if (roadmap.phases.some((p) => p.id === id)) {
    const err = new Error(`Phase "${id}" already exists in roadmap.yaml.`);
    (err as NodeJS.ErrnoException).code = "DUPLICATE_PHASE_ID";
    throw err;
  }

  // Determine file path
  const slug = slugify(name);
  const filename = `${id}-${slug}.yaml`;
  const relPath = `design/phases/${filename}`;
  const absPath = join(cwd, relPath);

  // Build Phase object
  const phase: Phase = {
    id,
    name,
    weight,
    confidence,
    risk,
    status: "planned",
    objective,
    definition_of_done: definitionOfDone,
    verification: { commands: verifyCommands },
  };

  await mkdir(join(cwd, "design", "phases"), { recursive: true });
  await writeFile(absPath, toYaml(phase), "utf8");

  // Append to roadmap
  const ref: PhaseRef = { id, path: relPath, weight };
  roadmap.phases.push(ref);
  await saveRoadmap(cwd, roadmap);

  return { path: relPath, ref };
}

// ---------------------------------------------------------------------------
// phase ls
// ---------------------------------------------------------------------------

export type PhaseLsOptions = {
  cwd: string;
  status?: PhaseStatus | undefined;
};

export type PhaseLsItem = {
  id: string;
  name: string;
  weight: number;
  status: PhaseStatus;
  risk: "low" | "medium" | "high";
};

export async function runPhaseLs(opts: PhaseLsOptions): Promise<PhaseLsItem[]> {
  const { cwd, status } = opts;
  const roadmap = await loadRoadmap(cwd);

  const items: PhaseLsItem[] = [];
  for (const ref of roadmap.phases) {
    const phase = await loadPhase(cwd, ref);
    if (status !== undefined && phase.status !== status) continue;
    items.push({
      id: phase.id,
      name: phase.name,
      weight: phase.weight,
      status: phase.status,
      risk: phase.risk,
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// phase show
// ---------------------------------------------------------------------------

export type PhaseShowOptions = {
  cwd: string;
  id: string;
};

export async function runPhaseShow(opts: PhaseShowOptions): Promise<Phase> {
  const { cwd, id } = opts;
  const roadmap = await loadRoadmap(cwd);
  const ref = roadmap.phases.find((p) => p.id === id);
  if (!ref) {
    const err = new Error(`Phase "${id}" not found in roadmap.yaml.`);
    (err as NodeJS.ErrnoException).code = "PHASE_NOT_FOUND";
    throw err;
  }
  return loadPhase(cwd, ref);
}

// ---------------------------------------------------------------------------
// Human-readable formatters
// ---------------------------------------------------------------------------

export function formatPhaseLsTable(items: PhaseLsItem[]): string {
  if (items.length === 0) return "(no phases)";
  const header = ["ID", "Name", "Weight", "Status", "Risk"];
  const rows = items.map((i) => [i.id, i.name, String(i.weight), i.status, i.risk]);
  const cols = header.map((h, ci) =>
    Math.max(h.length, ...rows.map((r) => (r[ci] ?? "").length)),
  );
  const fmt = (cells: string[]) =>
    cells.map((c, ci) => c.padEnd(cols[ci] ?? 0)).join("  ");
  return [fmt(header), fmt(cols.map((w) => "-".repeat(w))), ...rows.map(fmt)].join("\n");
}

export function formatPhaseShow(phase: Phase): string {
  const lines: string[] = [
    `ID:         ${phase.id}`,
    `Name:       ${phase.name}`,
    `Weight:     ${phase.weight}`,
    `Status:     ${phase.status}`,
    `Confidence: ${phase.confidence}`,
    `Risk:       ${phase.risk}`,
    ``,
    `Objective:`,
    `  ${phase.objective.trim()}`,
    ``,
    `Definition of Done:`,
    ...phase.definition_of_done.map((d) => `  - ${d}`),
    ``,
    `Verification Commands:`,
    ...phase.verification.commands.map((c) => `  $ ${c}`),
  ];
  if (phase.non_goals && phase.non_goals.length > 0) {
    lines.push(``, `Non-Goals:`, ...phase.non_goals.map((g) => `  - ${g}`));
  }
  if (phase.requires_decision) {
    lines.push(``, `Requires Decision: yes`);
  }
  if (phase.tasks && phase.tasks.length > 0) {
    lines.push(``, `Tasks (${phase.tasks.length}):`);
    for (const t of phase.tasks) {
      lines.push(`  - ${t.id}  [${t.status}]  ${t.description ?? t.type}`);
    }
  }
  return lines.join("\n");
}
