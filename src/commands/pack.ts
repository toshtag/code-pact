import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { Roadmap } from "../core/schemas/roadmap.ts";
import { Phase } from "../core/schemas/phase.ts";
import { parseFrontMatter } from "../core/pack/front-matter.ts";
import { renderMarkdown, type RuleDoc, type DecisionDoc } from "../core/pack/formatters/markdown.ts";
import type { Task } from "../core/schemas/task.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PackOptions = {
  cwd: string;
  phaseId: string;
  taskId: string;
  agentName: string;
};

export type PackResult = {
  outputPath: string;
  charCount: number;
  includedRules: string[];
  includedDecisions: string[];
};

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

async function loadRoadmap(cwd: string): Promise<Roadmap> {
  const raw = await readFile(join(cwd, "design", "roadmap.yaml"), "utf8");
  return Roadmap.parse(parseYaml(raw) as unknown);
}

async function loadPhase(cwd: string, path: string): Promise<Phase> {
  const raw = await readFile(join(cwd, path), "utf8");
  return Phase.parse(parseYaml(raw) as unknown);
}

async function loadRules(cwd: string, taskType: string): Promise<RuleDoc[]> {
  const rulesDir = join(cwd, "design", "rules");
  let entries: string[];
  try {
    entries = await readdir(rulesDir);
  } catch {
    return [];
  }

  const docs: RuleDoc[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".md")) continue;
    // constitution.md is human-facing only — never packed
    if (entry === "constitution.md") continue;

    const raw = await readFile(join(rulesDir, entry), "utf8");
    const { frontMatter, body } = parseFrontMatter(raw);
    const tags: string[] = Array.isArray(frontMatter.tags) ? (frontMatter.tags as string[]) : [];
    const appliesTo: string[] = Array.isArray(frontMatter.applies_to)
      ? (frontMatter.applies_to as string[])
      : [];

    // Include if applies_to is empty (universal) or contains the task type
    if (appliesTo.length === 0 || appliesTo.includes(taskType)) {
      docs.push({ filename: entry, tags, applies_to: appliesTo, body });
    }
  }
  return docs;
}

async function loadDecisions(cwd: string, taskId: string): Promise<DecisionDoc[]> {
  const decisionsDir = join(cwd, "design", "decisions");
  let entries: string[];
  try {
    entries = await readdir(decisionsDir);
  } catch {
    return [];
  }

  const docs: DecisionDoc[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".md")) continue;
    // Only include ADRs that reference the task ID in their filename
    if (!entry.includes(taskId)) continue;

    const raw = await readFile(join(decisionsDir, entry), "utf8");
    const { body } = parseFrontMatter(raw);
    docs.push({ filename: entry, body });
  }
  return docs;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runPack(opts: PackOptions): Promise<PackResult> {
  const { cwd, phaseId, taskId, agentName } = opts;

  // Resolve phase
  const roadmap = await loadRoadmap(cwd);
  const ref = roadmap.phases.find((p) => p.id === phaseId);
  if (!ref) {
    const err = new Error(`Phase "${phaseId}" not found in roadmap.yaml.`);
    (err as NodeJS.ErrnoException).code = "PHASE_NOT_FOUND";
    throw err;
  }

  const phase = await loadPhase(cwd, ref.path);

  // Resolve task
  const task = phase.tasks?.find((t) => t.id === taskId);
  if (!task) {
    const err = new Error(`Task "${taskId}" not found in phase "${phaseId}".`);
    (err as NodeJS.ErrnoException).code = "TASK_NOT_FOUND";
    throw err;
  }

  // Load applicable rules and decisions
  const rules = await loadRules(cwd, task.type);
  const decisions = await loadDecisions(cwd, taskId);

  // Render
  const content = renderMarkdown({ phase, task, agentName, rules, decisions });

  // Write output
  const outDir = join(cwd, ".context", agentName);
  await mkdir(outDir, { recursive: true });
  const outputPath = join(outDir, `${taskId}.md`);
  await writeFile(outputPath, content, "utf8");

  return {
    outputPath,
    charCount: content.length,
    includedRules: rules.map((r) => r.filename),
    includedDecisions: decisions.map((d) => d.filename),
  };
}
