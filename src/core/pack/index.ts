import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { Roadmap } from "../schemas/roadmap.ts";
import { Phase } from "../schemas/phase.ts";
import { AgentProfile } from "../schemas/agent-profile.ts";
import { parseFrontMatter } from "./front-matter.ts";
import { renderMarkdown, type RuleDoc, type DecisionDoc } from "./formatters/markdown.ts";

export type BuildContextPackOptions = {
  cwd: string;
  phaseId: string;
  taskId: string;
  agentName: string;
};

export type ContextPackResult = {
  content: string;
  taskId: string;
  phaseId: string;
  agent: string;
  charCount: number;
  includedRules: string[];
  includedDecisions: string[];
};

export type WriteContextPackOptions = {
  cwd: string;
  agentName: string;
  outputDir?: string;
};

export type WriteContextPackResult = {
  outputPath: string;
};

async function loadRoadmap(cwd: string): Promise<Roadmap> {
  const raw = await readFile(join(cwd, "design", "roadmap.yaml"), "utf8");
  return Roadmap.parse(parseYaml(raw) as unknown);
}

async function loadPhase(cwd: string, path: string): Promise<Phase> {
  const raw = await readFile(join(cwd, path), "utf8");
  return Phase.parse(parseYaml(raw) as unknown);
}

async function loadAgentProfile(cwd: string, agentName: string): Promise<AgentProfile | null> {
  try {
    const raw = await readFile(
      join(cwd, ".code-pact", "agent-profiles", `${agentName}.yaml`),
      "utf8",
    );
    return AgentProfile.parse(parseYaml(raw) as unknown);
  } catch {
    return null;
  }
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
    if (!entry.includes(taskId)) continue;

    const raw = await readFile(join(decisionsDir, entry), "utf8");
    const { body } = parseFrontMatter(raw);
    docs.push({ filename: entry, body });
  }
  return docs;
}

/**
 * Pure-ish context pack builder. Reads design files and renders the
 * Markdown content along with metadata. Does NOT write to disk.
 *
 * Throws an error with code "PHASE_NOT_FOUND" or "TASK_NOT_FOUND" when
 * the requested ids do not exist.
 */
export async function buildContextPack(
  opts: BuildContextPackOptions,
): Promise<ContextPackResult> {
  const { cwd, phaseId, taskId, agentName } = opts;

  const roadmap = await loadRoadmap(cwd);
  const ref = roadmap.phases.find((p) => p.id === phaseId);
  if (!ref) {
    const err = new Error(`Phase "${phaseId}" not found in roadmap.yaml.`);
    (err as NodeJS.ErrnoException).code = "PHASE_NOT_FOUND";
    throw err;
  }

  const phase = await loadPhase(cwd, ref.path);

  const task = phase.tasks?.find((t) => t.id === taskId);
  if (!task) {
    const err = new Error(`Task "${taskId}" not found in phase "${phaseId}".`);
    (err as NodeJS.ErrnoException).code = "TASK_NOT_FOUND";
    throw err;
  }

  const rules = await loadRules(cwd, task.type);
  const decisions = await loadDecisions(cwd, taskId);

  const content = renderMarkdown({ phase, task, agentName, rules, decisions });

  return {
    content,
    taskId,
    phaseId,
    agent: agentName,
    charCount: content.length,
    includedRules: rules.map((r) => r.filename),
    includedDecisions: decisions.map((d) => d.filename),
  };
}

/**
 * Writes a previously built ContextPackResult to disk under the agent's
 * configured context_dir (or an explicit outputDir override). Returns
 * the resolved outputPath.
 */
export async function writeContextPack(
  pack: ContextPackResult,
  opts: WriteContextPackOptions,
): Promise<WriteContextPackResult> {
  const { cwd, agentName, outputDir } = opts;
  const profile = await loadAgentProfile(cwd, agentName);
  const outDir = outputDir ?? join(cwd, profile?.context_dir ?? join(".context", agentName));
  await mkdir(outDir, { recursive: true });
  const outputPath = join(outDir, `${pack.taskId}.md`);
  await writeFile(outputPath, pack.content, "utf8");
  return { outputPath };
}
