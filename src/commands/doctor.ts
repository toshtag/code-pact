import { readFile, readdir, access } from "node:fs/promises";
import { join, basename, extname } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { Roadmap } from "../core/schemas/roadmap.ts";
import { Phase } from "../core/schemas/phase.ts";
import { ProgressLog } from "../core/schemas/progress-event.ts";
import { Project } from "../core/schemas/project.ts";
import { AgentProfile } from "../core/schemas/agent-profile.ts";
import { ModelProfile, ModelTier } from "../core/schemas/model-profile.ts";

// Optional per-project doctor configuration (.code-pact/doctor.yaml)
const DoctorConfig = z.object({
  disabled_checks: z.array(z.string()).optional().default([]),
});
type DoctorConfig = z.infer<typeof DoctorConfig>;

async function loadDoctorConfig(cwd: string): Promise<DoctorConfig> {
  const path = join(cwd, ".code-pact", "doctor.yaml");
  try {
    const raw = await readFile(path, "utf8");
    const parsed = DoctorConfig.safeParse(parseYaml(raw));
    if (parsed.success) return parsed.data;
  } catch {
    // file absent or unreadable — use defaults
  }
  return { disabled_checks: [] };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DoctorIssue = {
  code: string;
  severity: "error" | "warning";
  message: string;
};

export type DoctorResult = {
  ok: boolean;
  issues: DoctorIssue[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function safeReadYaml(p: string): Promise<{ ok: true; data: unknown } | { ok: false }> {
  try {
    const raw = await readFile(p, "utf8");
    return { ok: true, data: parseYaml(raw) };
  } catch {
    return { ok: false };
  }
}

async function safeReadJson(p: string): Promise<{ ok: true; data: unknown } | { ok: false }> {
  try {
    const raw = await readFile(p, "utf8");
    return { ok: true, data: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}

// ---------------------------------------------------------------------------
// Individual check groups
// ---------------------------------------------------------------------------

async function checkProjectYaml(cwd: string, issues: DoctorIssue[]): Promise<Project | null> {
  const path = join(cwd, ".code-pact", "project.yaml");
  const result = await safeReadYaml(path);
  if (!result.ok) {
    issues.push({ code: "INVALID_YAML", severity: "error", message: `Cannot read ${path}` });
    return null;
  }
  const parsed = Project.safeParse(result.data);
  if (!parsed.success) {
    issues.push({
      code: "SCHEMA_ERROR",
      severity: "error",
      message: `project.yaml failed schema validation: ${parsed.error.issues[0]?.message ?? "unknown"}`,
    });
    return null;
  }
  return parsed.data;
}

async function checkRoadmap(cwd: string, issues: DoctorIssue[]): Promise<Roadmap | null> {
  const path = join(cwd, "design", "roadmap.yaml");
  const result = await safeReadYaml(path);
  if (!result.ok) {
    issues.push({ code: "INVALID_YAML", severity: "error", message: `Cannot read ${path}` });
    return null;
  }
  const parsed = Roadmap.safeParse(result.data);
  if (!parsed.success) {
    issues.push({
      code: "SCHEMA_ERROR",
      severity: "error",
      message: `roadmap.yaml failed schema validation: ${parsed.error.issues[0]?.message ?? "unknown"}`,
    });
    return null;
  }
  return parsed.data;
}

async function checkPhases(
  cwd: string,
  roadmap: Roadmap,
  issues: DoctorIssue[],
): Promise<Phase[]> {
  const phases: Phase[] = [];

  for (const ref of roadmap.phases) {
    const absPath = join(cwd, ref.path);
    if (!(await fileExists(absPath))) {
      issues.push({
        code: "ORPHAN_PHASE_FILE",
        severity: "error",
        message: `roadmap.yaml references "${ref.path}" but the file does not exist`,
      });
      continue;
    }
    const result = await safeReadYaml(absPath);
    if (!result.ok) {
      issues.push({
        code: "INVALID_YAML",
        severity: "error",
        message: `Cannot parse phase file: ${ref.path}`,
      });
      continue;
    }
    const parsed = Phase.safeParse(result.data);
    if (!parsed.success) {
      issues.push({
        code: "SCHEMA_ERROR",
        severity: "error",
        message: `${ref.path} failed schema validation: ${parsed.error.issues[0]?.message ?? "unknown"}`,
      });
      continue;
    }
    // Check that phase id in YAML matches roadmap ref id
    if (parsed.data.id !== ref.id) {
      issues.push({
        code: "PHASE_ID_MISMATCH",
        severity: "error",
        message: `${ref.path} has id="${parsed.data.id}" but roadmap expects "${ref.id}"`,
      });
    }
    phases.push(parsed.data);
  }

  // Check for phase YAML files in design/phases/ not referenced in roadmap
  const phasesDir = join(cwd, "design", "phases");
  let phaseFiles: string[] = [];
  try {
    phaseFiles = await readdir(phasesDir);
  } catch {
    // directory may not exist
  }
  const referencedPaths = new Set(roadmap.phases.map((r) => r.path));
  for (const file of phaseFiles) {
    if (!file.endsWith(".yaml")) continue;
    const relPath = `design/phases/${file}`;
    if (!referencedPaths.has(relPath)) {
      issues.push({
        code: "ORPHAN_PHASE_FILE",
        severity: "warning",
        message: `${relPath} exists but is not referenced in roadmap.yaml`,
      });
    }
  }

  return phases;
}

async function checkProgressLog(
  cwd: string,
  phases: Phase[],
  issues: DoctorIssue[],
): Promise<void> {
  const path = join(cwd, ".code-pact", "state", "progress.yaml");
  const result = await safeReadYaml(path);
  if (!result.ok) {
    issues.push({
      code: "INVALID_YAML",
      severity: "error",
      message: `Cannot read ${path}`,
    });
    return;
  }
  const parsed = ProgressLog.safeParse(result.data);
  if (!parsed.success) {
    issues.push({
      code: "SCHEMA_ERROR",
      severity: "error",
      message: `progress.yaml failed schema validation: ${parsed.error.issues[0]?.message ?? "unknown"}`,
    });
    return;
  }

  // Collect all known task IDs
  const knownTaskIds = new Set(phases.flatMap((p) => (p.tasks ?? []).map((t) => t.id)));

  for (const event of parsed.data.events) {
    if (!knownTaskIds.has(event.task_id)) {
      issues.push({
        code: "ORPHAN_PROGRESS_EVENT",
        severity: "warning",
        message: `progress.yaml references task "${event.task_id}" which does not exist in any phase`,
      });
    }
  }
}

async function checkAgentProfiles(
  cwd: string,
  project: Project,
  issues: DoctorIssue[],
): Promise<void> {
  const knownTiers = new Set(ModelTier.options);

  for (const agentRef of project.agents) {
    const profilePath = join(cwd, ".code-pact", agentRef.profile);
    const result = await safeReadYaml(profilePath);
    if (!result.ok) {
      issues.push({
        code: "AGENT_NOT_FOUND",
        severity: "error",
        message: `Agent profile "${agentRef.profile}" cannot be read`,
      });
      continue;
    }
    const parsed = AgentProfile.safeParse(result.data);
    if (!parsed.success) {
      issues.push({
        code: "SCHEMA_ERROR",
        severity: "error",
        message: `${agentRef.profile} failed schema validation: ${parsed.error.issues[0]?.message ?? "unknown"}`,
      });
      continue;
    }
    // Check all tiers are present in model_map
    for (const tier of knownTiers) {
      if (!parsed.data.model_map[tier]) {
        issues.push({
          code: "MISSING_MODEL_TIER",
          severity: "warning",
          message: `Agent "${parsed.data.name}" is missing model_map entry for tier "${tier}"`,
        });
      }
    }
  }
}

async function checkModelProfiles(cwd: string, issues: DoctorIssue[]): Promise<void> {
  const dir = join(cwd, ".code-pact", "model-profiles");
  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch {
    issues.push({
      code: "MISSING_DIR",
      severity: "warning",
      message: `.code-pact/model-profiles/ directory is missing`,
    });
    return;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".yaml")) continue;
    const result = await safeReadYaml(join(dir, entry));
    if (!result.ok) {
      issues.push({
        code: "INVALID_YAML",
        severity: "error",
        message: `.code-pact/model-profiles/${entry} cannot be parsed`,
      });
      continue;
    }
    const parsed = ModelProfile.safeParse(result.data);
    if (!parsed.success) {
      issues.push({
        code: "SCHEMA_ERROR",
        severity: "error",
        message: `.code-pact/model-profiles/${entry} failed schema validation`,
      });
    }
  }
}

async function checkBakFiles(cwd: string, issues: DoctorIssue[]): Promise<void> {
  // Check design/ tree for .bak files
  const dirs = [
    join(cwd, "design"),
    join(cwd, ".code-pact"),
  ];
  for (const dir of dirs) {
    let entries: string[] = [];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.endsWith(".bak")) {
        issues.push({
          code: "BAK_FILE",
          severity: "warning",
          message: `Backup file found: ${dir.replace(cwd + "/", "")}/${entry} — safe to delete`,
        });
      }
    }
  }
}

// Check 9: duplicate task ids across phases
function checkDuplicateTaskIds(phases: Phase[], issues: DoctorIssue[]): void {
  const seen = new Map<string, string>(); // taskId → first phaseId
  for (const phase of phases) {
    for (const task of phase.tasks ?? []) {
      const first = seen.get(task.id);
      if (first !== undefined) {
        issues.push({
          code: "DUPLICATE_TASK_ID",
          severity: "error",
          message: `Task "${task.id}" appears in both phase "${first}" and "${phase.id}"`,
        });
      } else {
        seen.set(task.id, phase.id);
      }
    }
  }
}

// Check 10: .local/ is gitignored
async function checkLocalGitignored(cwd: string, issues: DoctorIssue[]): Promise<void> {
  let content: string;
  try {
    content = await readFile(join(cwd, ".gitignore"), "utf8");
  } catch {
    issues.push({
      code: "LOCAL_NOT_GITIGNORED",
      severity: "warning",
      message: ".gitignore not found — add \".local/\" to avoid committing sensitive planning notes",
    });
    return;
  }
  const lines = content.split("\n").map((l) => l.trim());
  const isIgnored = lines.some((l) => l === ".local" || l === ".local/" || l.startsWith(".local/"));
  if (!isIgnored) {
    issues.push({
      code: "LOCAL_NOT_GITIGNORED",
      severity: "warning",
      message: ".local/ is not in .gitignore — add \".local/\" to avoid committing sensitive planning notes",
    });
  }
}

// Check 11: enabled agents have their adapter instruction file on disk
async function checkAdapterMissing(
  cwd: string,
  project: Project,
  issues: DoctorIssue[],
): Promise<void> {
  for (const agentRef of project.agents) {
    if (agentRef.enabled === false) continue;
    const profilePath = join(cwd, ".code-pact", agentRef.profile);
    const result = await safeReadYaml(profilePath);
    if (!result.ok) continue; // already reported by checkAgentProfiles
    const parsed = AgentProfile.safeParse(result.data);
    if (!parsed.success) continue;
    const instructionFile = join(cwd, parsed.data.instruction_filename);
    if (!(await fileExists(instructionFile))) {
      issues.push({
        code: "ADAPTER_MISSING",
        severity: "warning",
        message: `Agent "${parsed.data.name}" is enabled but "${parsed.data.instruction_filename}" does not exist — run "code-pact adapter --agent ${agentRef.name}"`,
      });
    }
  }
}

// Check 12: design/brief.md exists
async function checkBriefMissing(cwd: string, issues: DoctorIssue[]): Promise<void> {
  if (!(await fileExists(join(cwd, "design", "brief.md")))) {
    issues.push({
      code: "BRIEF_MISSING",
      severity: "warning",
      message: "design/brief.md does not exist — run \"code-pact plan brief\" to create a project overview",
    });
  }
}

// Sentinel strings that indicate constitution.md hasn't been edited from its initial template.
const CONSTITUTION_PLACEHOLDER_MARKERS = [
  "Edit this file to reflect the actual principles of your project",
  "このファイルを編集して、プロジェクト固有の原則を反映させてください",
];

// Check 13: constitution.md is not the unedited initial template
async function checkConstitutionPlaceholder(cwd: string, issues: DoctorIssue[]): Promise<void> {
  const path = join(cwd, "design", "constitution.md");
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch {
    return; // file absent — BRIEF_MISSING or similar handles the design dir; skip here
  }
  const isPlaceholder = CONSTITUTION_PLACEHOLDER_MARKERS.some((m) => content.includes(m));
  if (isPlaceholder) {
    issues.push({
      code: "CONSTITUTION_PLACEHOLDER",
      severity: "warning",
      message: "design/constitution.md still contains the initial template text — edit it or run \"code-pact plan constitution\"",
    });
  }
}

// Check 14: all phase objectives are non-trivial (>= 10 chars)
function checkEmptyObjectives(phases: Phase[], issues: DoctorIssue[]): void {
  for (const phase of phases) {
    if (!phase.objective || phase.objective.trim().length < 10) {
      issues.push({
        code: "EMPTY_OBJECTIVE",
        severity: "error",
        message: `Phase "${phase.id}" has an empty or too-short objective (must be at least 10 characters)`,
      });
    }
  }
}

// Check 15: enabled agent profiles have model_version set
async function checkAdapterStale(
  cwd: string,
  project: Project,
  issues: DoctorIssue[],
): Promise<void> {
  for (const agentRef of project.agents) {
    if (agentRef.enabled === false) continue;
    const profilePath = join(cwd, ".code-pact", agentRef.profile);
    const result = await safeReadYaml(profilePath);
    if (!result.ok) continue; // already reported elsewhere
    const parsed = AgentProfile.safeParse(result.data);
    if (!parsed.success) continue;
    if (!parsed.data.model_version) {
      issues.push({
        code: "ADAPTER_STALE",
        severity: "warning",
        message: `Agent "${parsed.data.name}" has no model_version set — run "code-pact adapter --agent ${agentRef.name} --model <version>" to pin a model`,
      });
    }
  }
}

async function checkStaleContext(
  cwd: string,
  phases: Phase[],
  project: Project,
  issues: DoctorIssue[],
): Promise<void> {
  const knownTaskIds = new Set(phases.flatMap((p) => (p.tasks ?? []).map((t) => t.id)));

  for (const agentRef of project.agents) {
    // Derive context dir from agent profile
    const profilePath = join(cwd, ".code-pact", agentRef.profile);
    const result = await safeReadYaml(profilePath);
    if (!result.ok) continue;
    const parsed = AgentProfile.safeParse(result.data);
    if (!parsed.success) continue;

    const contextDir = join(cwd, parsed.data.context_dir);
    let entries: string[] = [];
    try {
      entries = await readdir(contextDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (extname(entry) !== ".md") continue;
      const taskId = basename(entry, ".md");
      if (!knownTaskIds.has(taskId)) {
        issues.push({
          code: "STALE_CONTEXT",
          severity: "warning",
          message: `${parsed.data.context_dir}/${entry} exists but task "${taskId}" is not in any phase`,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runDoctor(cwd: string): Promise<DoctorResult> {
  const allIssues: DoctorIssue[] = [];
  const config = await loadDoctorConfig(cwd);
  const disabled = new Set(config.disabled_checks);

  // 1. project.yaml
  const project = await checkProjectYaml(cwd, allIssues);

  // 2. roadmap.yaml
  const roadmap = await checkRoadmap(cwd, allIssues);

  // 3. phase files (requires roadmap)
  const phases = roadmap ? await checkPhases(cwd, roadmap, allIssues) : [];

  // 4. progress.yaml (requires phases for orphan check)
  await checkProgressLog(cwd, phases, allIssues);

  // 5. agent profiles + model_map completeness (requires project)
  if (project) {
    await checkAgentProfiles(cwd, project, allIssues);
  }

  // 6. model profiles
  await checkModelProfiles(cwd, allIssues);

  // 7. .bak files
  await checkBakFiles(cwd, allIssues);

  // 8. stale generated context (requires phases + project)
  if (project) {
    await checkStaleContext(cwd, phases, project, allIssues);
  }

  // 9. duplicate task ids across phases
  checkDuplicateTaskIds(phases, allIssues);

  // 10. .local/ gitignored
  await checkLocalGitignored(cwd, allIssues);

  // 11. enabled agents have adapter instruction files
  if (project) {
    await checkAdapterMissing(cwd, project, allIssues);
  }

  // 12. design/brief.md present
  await checkBriefMissing(cwd, allIssues);

  // 13. constitution.md is not the unedited template
  await checkConstitutionPlaceholder(cwd, allIssues);

  // 14. phase objectives are non-trivial
  checkEmptyObjectives(phases, allIssues);

  // 15. enabled agents have model_version set
  if (project) {
    await checkAdapterStale(cwd, project, allIssues);
  }

  // Apply disabled_checks filter
  const issues = disabled.size > 0
    ? allIssues.filter((i) => !disabled.has(i.code))
    : allIssues;

  const ok = issues.every((i) => i.severity !== "error");
  return { ok, issues };
}

// ---------------------------------------------------------------------------
// Human-readable formatter
// ---------------------------------------------------------------------------

export function formatDoctor(result: DoctorResult): string {
  if (result.issues.length === 0) {
    return "No issues found. Project is healthy.";
  }
  const lines = result.issues.map((i) => {
    const mark = i.severity === "error" ? "[error]" : "[warn] ";
    return `  ${mark} ${i.code}: ${i.message}`;
  });
  const summary = result.ok
    ? `${result.issues.length} warning(s) found.`
    : `${result.issues.filter((i) => i.severity === "error").length} error(s), ${result.issues.filter((i) => i.severity === "warning").length} warning(s) found.`;
  return [summary, ...lines].join("\n");
}
