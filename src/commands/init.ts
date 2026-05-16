import { mkdir, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { stringify as toYaml } from "yaml";
import type { LocaleCode } from "../core/schemas/locale.ts";
import type { ModelProfile } from "../core/schemas/model-profile.ts";
import type { Project } from "../core/schemas/project.ts";
import type { Roadmap } from "../core/schemas/roadmap.ts";
import type { ProgressLog } from "../core/schemas/progress-event.ts";
import type { BaselineSnapshot } from "../core/schemas/baseline-snapshot.ts";
import { DEFAULT_AGENT_PROFILES, type SupportedAgent } from "../core/agents.ts";

export type { SupportedAgent } from "../core/agents.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InitOptions = {
  /** Target directory (defaults to cwd) */
  cwd: string;
  locale: LocaleCode;
  agents: SupportedAgent[];
  /** Overwrite existing files */
  force: boolean;
  /** Emit JSON result to stdout instead of human messages */
  json: boolean;
};

export type InitResult = {
  created: string[];
  skipped: string[];
};

// ---------------------------------------------------------------------------
// Default profile fixtures
// ---------------------------------------------------------------------------

const MODEL_PROFILES: ModelProfile[] = [
  {
    tier: "highest_reasoning",
    purpose: ["architecture", "high_ambiguity", "weak_verification"],
    effort_levels: ["medium", "high"],
    supports_thinking: true,
  },
  {
    tier: "balanced_coding",
    purpose: ["feature", "refactor"],
    effort_levels: ["low", "medium", "high"],
    supports_thinking: false,
  },
  {
    tier: "cheap_mechanical",
    purpose: ["docs", "formatting"],
    effort_levels: ["low"],
    supports_thinking: false,
  },
];

// ---------------------------------------------------------------------------
// Template strings
// ---------------------------------------------------------------------------

function constitutionMd(projectName: string): string {
  return [
    `# ${projectName} — Constitution`,
    "",
    "This file captures the high-level principles that guide every design",
    "and implementation decision in this project.",
    "",
    "## Core principles",
    "",
    "- Write for the next reader, not just the next test.",
    "- Design decisions must be captured in `design/decisions/`.",
    "- Completion criteria must be deterministically verifiable.",
    "",
    "> Edit this file to reflect the actual principles of your project.",
  ].join("\n");
}

function codingStyleMd(): string {
  return [
    "---",
    "tags: [coding, style]",
    "applies_to: [feature, refactor, bugfix]",
    "---",
    "",
    "# Coding style rules",
    "",
    "- Prefer explicit over implicit.",
    "- No commented-out code in commits.",
    "- File-level exports only; avoid barrel re-exports of internal helpers.",
    "",
    "> Edit or delete this file to match your project conventions.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// File generation helpers
// ---------------------------------------------------------------------------

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function writeIfAbsent(
  p: string,
  content: string,
  force: boolean,
  created: string[],
  skipped: string[],
): Promise<void> {
  if (!force && (await exists(p))) {
    skipped.push(p);
    return;
  }
  await writeFile(p, content, "utf8");
  created.push(p);
}

async function mkdirp(p: string): Promise<void> {
  await mkdir(p, { recursive: true });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runInit(opts: InitOptions): Promise<InitResult> {
  const { cwd, locale, agents, force } = opts;
  const created: string[] = [];
  const skipped: string[] = [];

  const now = new Date().toISOString();
  const projectName = cwd.split("/").pop() ?? "my-project";

  // Guard: if .code-pact/ already exists and no --force, abort early
  const toolDir = join(cwd, ".code-pact");
  if (!force && (await exists(toolDir))) {
    const err = new Error(
      `".code-pact/" already exists in ${cwd}. Run with --force to overwrite.`,
    );
    (err as NodeJS.ErrnoException).code = "ALREADY_INITIALIZED";
    throw err;
  }

  // -------------------------------------------------------------------------
  // .code-pact/
  // -------------------------------------------------------------------------
  await mkdirp(join(cwd, ".code-pact", "agent-profiles"));
  await mkdirp(join(cwd, ".code-pact", "model-profiles"));
  await mkdirp(join(cwd, ".code-pact", "state", "baselines"));

  // project.yaml
  const projectYaml: Project = {
    name: projectName,
    version: "0.1.0",
    locale,
    default_agent: agents[0] ?? "claude-code",
    agents: agents.map((a) => ({
      name: a,
      profile: `agent-profiles/${a}.yaml`,
      enabled: true,
    })),
  };
  await writeIfAbsent(
    join(cwd, ".code-pact", "project.yaml"),
    toYaml(projectYaml),
    force,
    created,
    skipped,
  );

  // agent profiles
  for (const agent of agents) {
    const profile = DEFAULT_AGENT_PROFILES[agent];
    await writeIfAbsent(
      join(cwd, ".code-pact", "agent-profiles", `${agent}.yaml`),
      toYaml(profile),
      force,
      created,
      skipped,
    );
  }

  // model profiles
  for (const mp of MODEL_PROFILES) {
    await writeIfAbsent(
      join(cwd, ".code-pact", "model-profiles", `${mp.tier.replace(/_/g, "-")}.yaml`),
      toYaml(mp),
      force,
      created,
      skipped,
    );
  }

  // progress.yaml (empty event log)
  const emptyLog: ProgressLog = { events: [] };
  await writeIfAbsent(
    join(cwd, ".code-pact", "state", "progress.yaml"),
    toYaml(emptyLog),
    force,
    created,
    skipped,
  );

  // initial baseline snapshot (empty roadmap)
  const baseline: BaselineSnapshot = {
    name: "initial",
    created_at: now,
    total_weight: 0,
    phases: [],
  };
  await writeIfAbsent(
    join(cwd, ".code-pact", "state", "baselines", "initial.json"),
    JSON.stringify(baseline, null, 2) + "\n",
    force,
    created,
    skipped,
  );

  // -------------------------------------------------------------------------
  // design/
  // -------------------------------------------------------------------------
  await mkdirp(join(cwd, "design", "rules"));
  await mkdirp(join(cwd, "design", "phases"));
  await mkdirp(join(cwd, "design", "decisions"));

  // constitution.md
  await writeIfAbsent(
    join(cwd, "design", "constitution.md"),
    constitutionMd(projectName),
    force,
    created,
    skipped,
  );

  // rules/coding-style.md
  await writeIfAbsent(
    join(cwd, "design", "rules", "coding-style.md"),
    codingStyleMd(),
    force,
    created,
    skipped,
  );

  // roadmap.yaml (empty phases)
  const roadmap: Roadmap = { phases: [] };
  await writeIfAbsent(
    join(cwd, "design", "roadmap.yaml"),
    toYaml(roadmap),
    force,
    created,
    skipped,
  );

  return { created, skipped };
}
