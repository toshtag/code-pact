import { mkdir, access } from "node:fs/promises";
import { atomicWriteText } from "../io/atomic-text.ts";
import { join } from "node:path";
import { stringify as toYaml } from "yaml";
import type { LocaleCode } from "../core/schemas/locale.ts";
import type { ModelProfile } from "../core/schemas/model-profile.ts";
import type { Project } from "../core/schemas/project.ts";
import type { Roadmap } from "../core/schemas/roadmap.ts";
import type { ProgressLog } from "../core/schemas/progress-event.ts";
import type { BaselineSnapshot } from "../core/schemas/baseline-snapshot.ts";
import { DEFAULT_AGENT_PROFILES, type SupportedAgent } from "../core/agents.ts";
import { messages as messageCatalog } from "../i18n/index.ts";

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
  /**
   * When true, write the tutorial sample phase artifact (P13+).
   * Honoured by both the flag-based `init` path (via CLI `--sample-phase`)
   * and the wizard path (forces creation, skipping the wizard's prompt).
   */
  createSamplePhase?: boolean;
};

/**
 * Core init options. Extends InitOptions with the fields the interactive
 * wizard collects. CLI flag callers go through runInit() which forwards
 * these as undefined; the wizard goes through runInitCore() directly.
 */
export type InitCoreOptions = InitOptions & {
  /** Default agent. Omitted -> agents[0]. */
  defaultAgent?: SupportedAgent;
  /** Verification command stored in the sample phase. Default "pnpm test". */
  verifyCommand?: string;
  /** When true, runInitCore also writes a minimal sample phase (P1). */
  createSamplePhase?: boolean;
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

function constitutionMd(projectName: string, locale: LocaleCode): string {
  const t = messageCatalog[locale].templates.constitution;
  return [
    `# ${projectName} — Constitution`,
    "",
    t.description,
    "",
    `## ${t.corePrinciplesHeader}`,
    "",
    ...t.principles.map((p) => `- ${p}`),
    "",
    `> ${t.editHint}`,
  ].join("\n");
}

function codingStyleMd(locale: LocaleCode): string {
  const t = messageCatalog[locale].templates.codingStyle;
  return [
    "---",
    "tags: [coding, style]",
    "applies_to: [feature, refactor, bugfix]",
    "---",
    "",
    `# ${t.header}`,
    "",
    ...t.rules.map((r) => `- ${r}`),
    "",
    `> ${t.editHint}`,
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
  // atomicWriteText: temp-file + rename. Prevents an interrupted `init`
  // from leaving a half-written project file on disk. Behaviour is
  // identical to the previous writeFile call for the happy path.
  await atomicWriteText(p, content);
  created.push(p);
}

async function mkdirp(p: string): Promise<void> {
  await mkdir(p, { recursive: true });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runInitCore(opts: InitCoreOptions): Promise<InitResult> {
  const { cwd, locale, agents, force } = opts;
  const defaultAgent = opts.defaultAgent ?? agents[0] ?? "claude-code";
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
    default_agent: defaultAgent,
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

  // .gitignore — ensure .local/ is excluded from version control
  await writeIfAbsent(
    join(cwd, ".gitignore"),
    ".local/\n",
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
    constitutionMd(projectName, locale),
    force,
    created,
    skipped,
  );

  // rules/coding-style.md
  await writeIfAbsent(
    join(cwd, "design", "rules", "coding-style.md"),
    codingStyleMd(locale),
    force,
    created,
    skipped,
  );

  // roadmap.yaml (empty phases — the sample phase below appends to it)
  const roadmap: Roadmap = { phases: [] };
  await writeIfAbsent(
    join(cwd, "design", "roadmap.yaml"),
    toYaml(roadmap),
    force,
    created,
    skipped,
  );

  // Optional sample phase. Goes through runPhaseAdd so the wizard output
  // matches what a real `phase add` would produce.
  if (opts.createSamplePhase) {
    const verifyCommand = opts.verifyCommand ?? "pnpm test";
    const samplePath = await writeSamplePhase(cwd, verifyCommand);
    if (samplePath) created.push(samplePath);
  }

  return { created, skipped };
}

/**
 * Backwards-compatible wrapper. Existing CLI callers (--agent flag, CI,
 * tests) keep their original options shape. The wizard goes through
 * runInitCore() directly to set defaultAgent, verifyCommand, and the
 * sample-phase flag.
 */
export async function runInit(opts: InitOptions): Promise<InitResult> {
  return runInitCore(opts);
}

/**
 * Writes the tutorial sample phase artifact introduced in P13 (v1.4+).
 *
 * Phase id is `TUTORIAL` (was `P1` pre-v1.4) so it does not collide with
 * the natural first user phase. Includes two tutorial tasks — TUTORIAL-T1
 * and TUTORIAL-T2 with `depends_on: [TUTORIAL-T1]` — so the per-task loop
 * + P10 depends_on + P12 task runbook blocking-step output can be demoed
 * end-to-end from a single bootstrap artifact.
 *
 * Calls the `createPhase` domain service directly because `runPhaseAdd`
 * does not forward the `tasks` field.
 *
 * Returns the relative path of the created phase, or `undefined` when
 * the phase already exists (DUPLICATE_PHASE_ID is swallowed silently,
 * matching the pre-P13 behaviour).
 */
async function writeSamplePhase(
  cwd: string,
  verifyCommand: string,
): Promise<string | undefined> {
  const { createPhase } = await import("../core/services/createPhase.ts");
  try {
    // The phase `name` becomes the file slug via createPhase's
    // slugify(). Using just "Walkthrough" yields the file path
    // `design/phases/TUTORIAL-walkthrough.yaml` promised by the
    // P13 RFC. The `id: "TUTORIAL"` plus the explicit objective
    // text below carries the tutorial-only framing.
    const result = await createPhase({
      cwd,
      // Internal-only bypass for the P14 reserved-id (TUTORIAL) block. This
      // is the single sanctioned call site that may set this flag — no other
      // caller (`phase add`, `phase new`, `phase import`) is allowed to.
      _isSampleCreation: true,
      id: "TUTORIAL",
      name: "Walkthrough",
      weight: 1,
      objective:
        "Confirm the project structure and verification pipeline by walking through the per-task loop end-to-end. Tutorial-only — delete this phase (and its roadmap entry) before treating design/ as your project's source-of-truth.",
      confidence: "high",
      risk: "low",
      verifyCommands: [verifyCommand],
      doneCriteria: [
        "The verification command exits with status 0.",
        "Every TUTORIAL-T* task has been completed and finalized.",
      ],
      tasks: [
        {
          id: "TUTORIAL-T1",
          type: "feature",
          ambiguity: "low",
          risk: "low",
          context_size: "small",
          write_surface: "low",
          verification_strength: "medium",
          expected_duration: "short",
          status: "planned",
          description:
            "Tutorial-only task. Run `code-pact task context TUTORIAL-T1` to see the context pack, then `code-pact task complete TUTORIAL-T1` to mark it done. Delete this entire TUTORIAL phase (and its roadmap entry) before treating design/ as your project's source-of-truth.",
        },
        {
          id: "TUTORIAL-T2",
          type: "docs",
          ambiguity: "low",
          risk: "low",
          context_size: "small",
          write_surface: "low",
          verification_strength: "medium",
          expected_duration: "short",
          status: "planned",
          depends_on: ["TUTORIAL-T1"],
          description:
            "Tutorial-only task. Demonstrates `code-pact task finalize TUTORIAL-T2 --write` after `task complete`. The `depends_on: [TUTORIAL-T1]` lets the tutorial demo the P10 dependency field + the P12 `task runbook` blocking-step output: `task runbook TUTORIAL-T2 --json` returns a blocking `manual_action` step at the head of `next_steps[]` until `task complete TUTORIAL-T1` runs. Safe to delete with the rest of TUTORIAL.",
        },
      ],
    });
    return result.path;
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === "DUPLICATE_PHASE_ID") {
      return undefined;
    }
    throw err;
  }
}
