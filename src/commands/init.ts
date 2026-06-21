import { mkdir, access, lstat, readFile } from "node:fs/promises";
import { atomicWriteText } from "../io/atomic-text.ts";
import { stringify as toYaml } from "yaml";
import type { LocaleCode } from "../core/schemas/locale.ts";
import { DEFAULT_MODEL_PROFILES } from "../core/models/catalog.ts";
import type { Project } from "../core/schemas/project.ts";
import type { Roadmap } from "../core/schemas/roadmap.ts";
import type { ProgressLog } from "../core/schemas/progress-event.ts";
import type { BaselineSnapshot } from "../core/schemas/baseline-snapshot.ts";
import { DEFAULT_AGENT_PROFILES, type SupportedAgent } from "../core/agents.ts";
import { renderInitConstitution } from "../core/constitution.ts";
import { messages as messageCatalog } from "../i18n/index.ts";
import { isGitRepo, gitIgnoredControlPlaneAreas } from "../core/control-plane-ignore.ts";
import { resolveOwnedProjectPath } from "../core/path-safety.ts";

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
   * When true, write the tutorial sample phase artifact.
   * Honoured by the flag-based `init` path via CLI `--sample-phase`; the
   * interactive wizard forwards the same flag-derived override (it no longer
   * prompts for the sample phase).
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
  /** When true, runInitCore also writes a minimal sample phase. */
  createSamplePhase?: boolean;
};

export type InitResult = {
  created: string[];
  skipped: string[];
  /**
   * Onboarding guidance surfaced after a successful init. Advisory only;
   * keeps the placeholder-edit nudge out of `doctor` (which now stays quiet
   * until a real phase exists) and in front of the user at the right moment.
   */
  suggested_next_steps: string[];
  /**
   * Non-fatal advisories raised during init (additive). Currently: a
   * pre-existing blanket `/.code-pact/` .gitignore rule that defeats the narrow
   * shared-vs-local policy `init` just wrote (collaboration state would never
   * reach git). `init` never edits a user's existing .gitignore lines, so this
   * surfaces the gap instead of silently writing dead narrow entries. Consumers
   * reading only `created` / `skipped` / `suggested_next_steps` are unaffected.
   */
  warnings: string[];
};

// ---------------------------------------------------------------------------
// Template strings
// ---------------------------------------------------------------------------

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

async function resolveInitPath(cwd: string, relPath: string): Promise<string> {
  try {
    return await resolveOwnedProjectPath(cwd, relPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (
      code === "PATH_OUTSIDE_PROJECT" ||
      code === "PATH_NOT_OWNED" ||
      code === "ENOTDIR" ||
      code === "EACCES" ||
      code === "EPERM" ||
      code === "ELOOP"
    ) {
      const e = new Error(
        `init refuses to write through unsafe project path "${relPath}": ${(err as Error).message}`,
      );
      (e as NodeJS.ErrnoException).code = "CONFIG_ERROR";
      throw e;
    }
    throw err;
  }
}

async function assertInitEntryType(cwd: string, relPath: string, expected: "directory" | "file"): Promise<void> {
  const abs = await resolveInitPath(cwd, relPath);
  let st;
  try {
    st = await lstat(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    const e = new Error(`init cannot inspect "${relPath}": ${(err as Error).message}`);
    (e as NodeJS.ErrnoException).code = "CONFIG_ERROR";
    throw e;
  }
  const ok = expected === "directory" ? st.isDirectory() : st.isFile();
  if (!ok) {
    const actual = st.isDirectory()
      ? "directory"
      : st.isFile()
        ? "file"
        : st.isSymbolicLink()
          ? "symlink"
          : "special file";
    const e = new Error(`init expected "${relPath}" to be ${expected} or absent, but found ${actual}`);
    (e as NodeJS.ErrnoException).code = "CONFIG_ERROR";
    throw e;
  }
}

async function preflightInitNamespaces(cwd: string, agents: SupportedAgent[]): Promise<void> {
  for (const rel of [
    ".gitignore",
    ".code-pact/project.yaml",
    ".code-pact/state/progress.yaml",
    ".code-pact/state/baselines/initial.json",
    "design/constitution.md",
    "design/rules/coding-style.md",
    "design/roadmap.yaml",
    ...agents.map((agent) => `.code-pact/agent-profiles/${agent}.yaml`),
    ...DEFAULT_MODEL_PROFILES.map((mp) => `.code-pact/model-profiles/${mp.tier.replace(/_/g, "-")}.yaml`),
  ]) {
    await assertInitEntryType(cwd, rel, "file");
  }
  for (const rel of [
    ".code-pact",
    ".code-pact/agent-profiles",
    ".code-pact/model-profiles",
    ".code-pact/state",
    ".code-pact/state/baselines",
    "design",
    "design/rules",
    "design/phases",
    "design/decisions",
  ]) {
    await assertInitEntryType(cwd, rel, "directory");
  }
}

/**
 * The local/derived subset `init` writes to `.gitignore`. Everything else under
 * `.code-pact/` is shared, version-controlled control-plane state. Kept as a
 * single constant so the entries `init` writes and the entries the blanket-ignore
 * advisory tells the user to keep cannot drift apart.
 */
const LOCAL_ONLY_IGNORE_ENTRIES = [
  "/.code-pact/locks/",
  "/.code-pact/cache/",
  "/.local/",
  "/.context/",
];

/** Compare gitignore patterns ignoring leading/trailing slash + whitespace. */
function gitignoreKey(line: string): string {
  return line.trim().replace(/^\/+/, "").replace(/\/+$/, "");
}

/**
 * Best-effort detection of a pre-existing blanket `/.code-pact/` ignore that
 * would defeat the narrow shared-vs-local policy. Returns the offending raw
 * line, or null. `gitignoreKey` strips only leading/trailing slashes, so the
 * common blanket forms collapse to one of a few keys: `.code-pact` (from
 * `.code-pact`, `.code-pact/`, `/.code-pact/`, …) and the wildcard variants
 * `.code-pact/*` / `.code-pact/**`. The narrow entries collapse to
 * `.code-pact/locks`, `.code-pact/cache`, etc., so the small key set cleanly
 * isolates the blanket case without misfiring on them (or on a scoped rule like
 * `.code-pact/*.log`). Negation lines (`!…`) are skipped — they re-include
 * rather than ignore. This is a heuristic prompt, not a verdict: it does not try
 * to cover every exotic form (e.g. a leading double-star glob before
 * `.code-pact`); `git check-ignore` in `doctor` is the authoritative catch-all
 * (it reflects git's real semantics,
 * e.g. that a negation under an excluded parent dir is ineffective), and the
 * warning points the user there.
 */
const BLANKET_IGNORE_KEYS = new Set([".code-pact", ".code-pact/*", ".code-pact/**"]);
function detectBlanketCodePactIgnore(content: string): string | null {
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith("!")) {
      continue;
    }
    if (BLANKET_IGNORE_KEYS.has(gitignoreKey(line))) return line;
  }
  return null;
}

/**
 * Idempotently ensures `entries` are present in `<cwd>/.gitignore`, preserving
 * any existing content. Unlike a plain writeIfAbsent, an existing .gitignore is
 * MERGED into, not skipped — so re-running init (or running it in a repo that
 * already has a .gitignore) still gets code-pact's ignores without clobbering
 * the user's. Entries already present (compared slash-insensitively, so
 * `.local/` satisfies `/.local/`) are not duplicated.
 */
async function ensureGitignoreEntries(
  cwd: string,
  entries: string[],
  created: string[],
): Promise<void> {
  const path = await resolveInitPath(cwd, ".gitignore");
  let existing: string | null = null;
  try {
    existing = await readFile(path, "utf8");
  } catch {
    existing = null;
  }

  const present = new Set(
    (existing ?? "").split("\n").map(gitignoreKey).filter((k) => k.length > 0),
  );
  const missing = entries.filter((e) => !present.has(gitignoreKey(e)));

  if (missing.length === 0) {
    // The existing .gitignore already covers every entry — nothing to do.
    // Not recorded as "skipped" (that connotes skipped-because-exists); the
    // merge target was simply already complete, so this is a clean no-op.
    return;
  }

  let next: string;
  if (existing === null || existing.length === 0) {
    next = `${missing.join("\n")}\n`;
  } else {
    const sep = existing.endsWith("\n") ? "" : "\n";
    next = `${existing}${sep}${missing.join("\n")}\n`;
  }
  await atomicWriteText(path, next);
  created.push(path);
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

  await preflightInitNamespaces(cwd, agents);

  // Guard: if .code-pact/ already exists and no --force, abort early
  const toolDir = await resolveInitPath(cwd, ".code-pact");
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
  await mkdirp(await resolveInitPath(cwd, ".code-pact/agent-profiles"));
  await mkdirp(await resolveInitPath(cwd, ".code-pact/model-profiles"));
  await mkdirp(await resolveInitPath(cwd, ".code-pact/state/baselines"));

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
    await resolveInitPath(cwd, ".code-pact/project.yaml"),
    toYaml(projectYaml),
    force,
    created,
    skipped,
  );

  // agent profiles
  for (const agent of agents) {
    const profile = DEFAULT_AGENT_PROFILES[agent];
    await writeIfAbsent(
      await resolveInitPath(cwd, `.code-pact/agent-profiles/${agent}.yaml`),
      toYaml(profile),
      force,
      created,
      skipped,
    );
  }

  // model profiles
  for (const mp of DEFAULT_MODEL_PROFILES) {
    await writeIfAbsent(
      await resolveInitPath(cwd, `.code-pact/model-profiles/${mp.tier.replace(/_/g, "-")}.yaml`),
      toYaml(mp),
      force,
      created,
      skipped,
    );
  }

  // progress.yaml — an empty legacy compatibility artifact. The per-event ledger
  // is where the task verbs now write (.code-pact/state/events/); this file is
  // never written by them. It is created empty so a fresh project has the legacy
  // read-merge target present (harmless, and a committed sentinel that keeps the
  // CI branch-drift gate from skipping on an untracked ledger).
  const emptyLog: ProgressLog = { events: [] };
  await writeIfAbsent(
    await resolveInitPath(cwd, ".code-pact/state/progress.yaml"),
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
    await resolveInitPath(cwd, ".code-pact/state/baselines/initial.json"),
    JSON.stringify(baseline, null, 2) + "\n",
    force,
    created,
    skipped,
  );

  // .gitignore — ignore the machine-local / derived paths only; the rest of
  // `.code-pact/` (project.yaml, agent/model profiles, baselines, and the
  // progress ledger) is shared, version-controlled state. Adapter manifests are
  // conditional — shared only when the adapter-owned generated files they list
  // (e.g. CLAUDE.md, AGENTS.md, GEMINI.md, .claude/skills/*, .cursor/**) are also
  // tracked; a
  // repo that ignores regenerated adapter output should ignore the manifest too.
  // Ignored: `.code-pact/locks/` (machine-local advisory locks — pid/hostname),
  // `.code-pact/cache/` (reserved, derived), `/.local/` (per-developer
  // overrides), `/.context/` (regenerated context packs). Merged into any
  // existing .gitignore (idempotent).
  await ensureGitignoreEntries(cwd, LOCAL_ONLY_IGNORE_ENTRIES, created);

  // A pre-existing blanket (or file-scoped) ignore overrides the narrow entries
  // we just wrote, so the shared control plane would never reach git. `init`
  // never edits a user's existing .gitignore lines (non-destructive by contract),
  // so surface the gap as an advisory pointing at the authoritative `doctor`
  // check (CONTROL_PLANE_GITIGNORED) rather than silently leaving dead entries.
  //
  // In a git repo we use the SAME authoritative, whole-control-plane check as
  // `doctor` (`git check-ignore` over project.yaml / profiles / baselines / the
  // ledger), so the warning is a verdict — no false positive from a negation
  // re-include, and a file-scoped `events/*.yaml` rule is caught. Outside a git
  // repo (e.g. `init` before `git init`) git cannot answer, so we fall back to a
  // text heuristic for the blanket form and soften the wording to a possibility —
  // the user confirms with `code-pact doctor` once the repo exists.
  const KEEP_HINT =
    "keep only `/.code-pact/locks/`, `/.code-pact/cache/`, `/.local/`, `/.context/` ignored";
  const warnings: string[] = [];
  const blanketLine = await resolveInitPath(cwd, ".gitignore")
    .then((path) => readFile(path, "utf8"))
    .then((c) => detectBlanketCodePactIgnore(c))
    .catch(() => null);
  if (await isGitRepo(cwd)) {
    const ignoredAreas = await gitIgnoredControlPlaneAreas(cwd);
    if (ignoredAreas.length > 0) {
      warnings.push(
        `Your .gitignore keeps shared control-plane state out of git — these areas will NOT reach git: ${ignoredAreas.join(", ")}. ` +
          "It overrides the narrow local-only ignores code-pact just added, so teammates or clean checkouts miss whatever is ignored. If the ledger itself is ignored, the branch-drift CI gate (CONTROL_PLANE_BRANCH_NOT_DRIVEN) also silently skips because there is no tracked ledger to read. " +
          `init does not edit existing .gitignore lines: narrow the rule yourself (${KEEP_HINT}), then run \`code-pact doctor\` to confirm (CONTROL_PLANE_GITIGNORED). See the shared-vs-local table in docs/cli-contract.md.`,
      );
    }
    // git repo + nothing ignored → no warning (authoritative).
  } else if (blanketLine !== null) {
    warnings.push(
      `Your .gitignore appears to ignore all of .code-pact/ (line: "${blanketLine}"). ` +
        "Once this is a git repo, that may prevent shared control-plane state (the progress ledger, project.yaml, agent/model profiles, baselines) from reaching git — so teammates would not see your progress and the branch-drift CI gate would silently skip. " +
        `init does not edit existing .gitignore lines: if you intend to share state, narrow the rule yourself (${KEEP_HINT}). Run \`code-pact doctor\` to confirm (CONTROL_PLANE_GITIGNORED). See the shared-vs-local table in docs/cli-contract.md.`,
    );
  }

  // -------------------------------------------------------------------------
  // design/
  // -------------------------------------------------------------------------
  await mkdirp(await resolveInitPath(cwd, "design/rules"));
  await mkdirp(await resolveInitPath(cwd, "design/phases"));
  await mkdirp(await resolveInitPath(cwd, "design/decisions"));

  // constitution.md
  await writeIfAbsent(
    await resolveInitPath(cwd, "design/constitution.md"),
    renderInitConstitution(projectName, locale),
    force,
    created,
    skipped,
  );

  // rules/coding-style.md
  await writeIfAbsent(
    await resolveInitPath(cwd, "design/rules/coding-style.md"),
    codingStyleMd(locale),
    force,
    created,
    skipped,
  );

  // roadmap.yaml (empty phases — the sample phase below appends to it)
  const roadmap: Roadmap = { phases: [] };
  await writeIfAbsent(
    await resolveInitPath(cwd, "design/roadmap.yaml"),
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

  const suggested_next_steps = [
    "Edit design/constitution.md to capture your project's principles (or run: code-pact plan constitution).",
    "Define your first phase: code-pact phase add.",
  ];

  return { created, skipped, suggested_next_steps, warnings };
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
 * Writes the tutorial sample phase artifact.
 *
 * Phase id is `TUTORIAL` so it does not collide with the natural first user
 * phase. Includes two tutorial tasks — TUTORIAL-T1 and TUTORIAL-T2 with
 * `depends_on: [TUTORIAL-T1]` — so the per-task loop, depends_on, and the
 * task-runbook blocking-step output can be demoed end-to-end from a single
 * bootstrap artifact.
 *
 * Calls the `createPhase` domain service directly because `runPhaseAdd`
 * does not forward the `tasks` field.
 *
 * Returns the relative path of the created phase, or `undefined` when
 * the phase already exists (DUPLICATE_PHASE_ID is swallowed silently).
 */
async function writeSamplePhase(
  cwd: string,
  verifyCommand: string,
): Promise<string | undefined> {
  const { createPhase } = await import("../core/services/createPhase.ts");
  try {
    // The phase `name` becomes the file slug via createPhase's slugify().
    // Using just "Walkthrough" yields the file path
    // `design/phases/TUTORIAL-walkthrough.yaml`. The `id: "TUTORIAL"` plus the
    // explicit objective text below carries the tutorial-only framing.
    const result = await createPhase({
      cwd,
      // Internal-only bypass for the reserved-id (TUTORIAL) block. This
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
            "Tutorial-only task. Demonstrates `code-pact task finalize TUTORIAL-T2 --write` after `task complete`. The `depends_on: [TUTORIAL-T1]` lets the tutorial demo the dependency field + the `task runbook` blocking-step output: `task runbook TUTORIAL-T2 --json` returns a blocking `manual_action` step at the head of `next_steps[]` until `task complete TUTORIAL-T1` runs. Safe to delete with the rest of TUTORIAL.",
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
