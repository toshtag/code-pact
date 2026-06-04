import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { Phase, type PhaseStatus } from "../core/schemas/phase.ts";
import { PhaseRef } from "../core/schemas/roadmap.ts";
import { loadRoadmap } from "../core/plan/roadmap.ts";
import { resolvePhaseInRoadmap } from "../core/plan/resolve-phase.ts";
import { createPhase } from "../core/services/createPhase.ts";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function loadPhase(cwd: string, ref: PhaseRef): Promise<Phase> {
  const raw = await readFile(join(cwd, ref.path), "utf8");
  const data: unknown = parseYaml(raw);
  return Phase.parse(data);
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

// Flag-based handler. Delegates to the createPhase domain service so the
// interactive `phase new` wizard and any future automation share the same
// rules around id collisions, slug derivation, and roadmap appends.
export async function runPhaseAdd(opts: PhaseAddOptions): Promise<PhaseAddResult> {
  return createPhase({
    cwd: opts.cwd,
    id: opts.id,
    name: opts.name,
    weight: opts.weight,
    objective: opts.objective,
    confidence: opts.confidence,
    risk: opts.risk,
    verifyCommands: opts.verifyCommands,
    doneCriteria: opts.definitionOfDone,
  });
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
  const ref = await resolvePhaseInRoadmap(cwd, id);
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
