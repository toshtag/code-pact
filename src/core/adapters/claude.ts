import { loadPhase } from "../plan/load-phase.ts";
import { loadRoadmap } from "../plan/roadmap.ts";
import type { Locale } from "../../i18n/index.ts";
import type {
  AdapterDescriptor,
  AdapterGenerateInput,
  DesiredAdapterFile,
} from "./types.ts";
import { adapterBootstrap, adapterCommon } from "./template-sections.ts";
import { BOOTSTRAP_GOTCHA_SECTION_HEADING } from "./conformance-spec.ts";

// ---------------------------------------------------------------------------
// CLAUDE.md template — the schema-v2 bootstrap
//
// This file is loaded on every turn, whether or not the current task needs any
// of it, so it carries only what `task prepare` cannot: what the repository is,
// how to reach the work order, and the few repository facts that are invisible
// from the filesystem. The lifecycle verbs, the failure catalog, the repair
// policy, and the model tiers used to live here; they are all in the
// `task prepare` response or the envelope reference at the moment they matter,
// and `adapter conformance` now fails a schema-v2 file that restates them (see
// core/adapters/conformance-spec.ts).
//
// Model-neutral by contract: no branch on model id or model version. The model
// catalog drives `--model` validation, profile seeding, and advisory
// recommendation defaults — none of which the agent needs restated here.
// ---------------------------------------------------------------------------

function claudeMd(locale: Locale): string {
  const common = adapterCommon(locale);
  const t = adapterBootstrap(locale);

  return [
    `# Claude Code — Project Instructions`,
    ``,
    `> ${common.managedNotice}`,
    `> ${t.editNotice}`,
    ``,
    `## ${t.purposeHeader}`,
    ``,
    t.purposeBody,
    ``,
    `## ${t.startHeader}`,
    ``,
    t.startIntro,
    ``,
    "```sh",
    `code-pact task prepare <task-id> --agent claude-code --json`,
    "```",
    ``,
    t.startOutcome,
    ``,
    t.startRules,
    ``,
    t.referenceBody,
    ``,
    BOOTSTRAP_GOTCHA_SECTION_HEADING,
    ``,
    ...t.gotchasHint.split("\n").map(line => `> ${line}`),
    ``,
    `- ${t.gotchasDefault}`,
    ``,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Skill templates (always English — these are slash command definitions)
// ---------------------------------------------------------------------------

const SKILL_CONTEXT = `# /context — Fetch the context pack for a task

Usage: /context <task-id>

Runs: code-pact task context $1 --agent claude-code
`;

const SKILL_VERIFY = `# /verify — Verify task completion criteria

Usage: /verify <phase-id> <task-id>

Runs: code-pact verify --phase $1 --task $2
`;

const SKILL_PROGRESS = `# /progress — Show weighted progress

Usage: /progress

Runs: code-pact progress --json
`;

// ---------------------------------------------------------------------------
// Verification command → skill helpers
// ---------------------------------------------------------------------------

const PACKAGE_MANAGERS = ["pnpm", "npm", "yarn", "bun"] as const;

/**
 * Splits a verification command into its meaningful subcommand `words` and its
 * `flags`, after stripping the runner prefix (a package manager, or a
 * `node <script>` / bare `code-pact` invocation). Deterministic and tiny — this
 * is a naming helper, not an argv parser.
 *
 * The grammar a verification command follows: `<runner> <subcommand words…>
 * <flags…>`. All meaningful subcommand words come BEFORE any flag, so we treat
 * the FIRST flag token as the boundary: every bare token after it (a flag's
 * value such as `claude-code` in `--agent claude-code`, or a positional that
 * follows flags) is NOT a naming word. This is what keeps a flag VALUE from
 * leaking into the name — the `--agent claude-code` → `claude-code`
 * collision bug — without needing to know which flags take values (a boolean
 * flag before a word would otherwise wrongly eat that word). `--flag=value`
 * forms are self-contained and never produce a stray word either way.
 */
function tokenizeCommand(command: string): {
  words: string[];
  flags: string[];
} {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  // Strip runner prefix.
  let i = 0;
  const first = tokens[0] ?? "";
  if ((PACKAGE_MANAGERS as readonly string[]).includes(first)) {
    i = 1;
    if (tokens[i] === "run") i += 1;
  } else if (first === "node") {
    i = 1;
    const next = tokens[i] ?? "";
    if (next.includes("/") || /\.(c|m)?js$/.test(next)) i += 1;
  } else if (first === "code-pact") {
    i = 1;
  }
  const rest = tokens.slice(i);
  const words: string[] = [];
  const flags: string[] = [];
  let seenFlag = false;
  for (const tok of rest) {
    if (tok.startsWith("-")) {
      seenFlag = true;
      flags.push(tok);
    } else if (!seenFlag) {
      // A bare token BEFORE the first flag is a subcommand word.
      words.push(tok);
    }
    // A bare token AFTER the first flag is a flag value / positional: ignored
    // for naming (never leaks into the skill name).
  }
  return { words, flags };
}

/** `--check` -> `check`, `--out=x` -> `out`, `-j` -> `j`. Empty if not a flag. */
function normalizeFlagName(flag: string): string {
  const name = flag.replace(/^-+/, "").split("=")[0] ?? "";
  return sanitizeSkillName(name);
}

/**
 * The base (most-preferred) skill name for a command: the joined subcommand
 * words (e.g. `adapter-doctor`, `plan-lint`), or the package-manager task name
 * (`test`), or the first flag name when there are no words.
 */
export function deriveSkillName(command: string): string {
  const { words, flags } = tokenizeCommand(command);
  if (words.length > 0) return sanitizeSkillName(words.join("-"));
  const firstFlag = flags.length > 0 ? normalizeFlagName(flags[0]!) : "";
  return sanitizeSkillName(firstFlag);
}

/**
 * An ordered ladder of candidate names for a command, from the plain base to
 * progressively flag-qualified forms (`adapter-upgrade`, `adapter-upgrade-check`,
 * `adapter-upgrade-check-json`). The generate loop picks the first candidate
 * not already taken, falling back to a numeric suffix only if the whole ladder
 * is exhausted. Pure function of the command string, so generation stays
 * deterministic and convergent.
 */
export function deriveSkillNameVariants(command: string): string[] {
  const { flags } = tokenizeCommand(command);
  const base = deriveSkillName(command);
  const out: string[] = [base];
  let acc = base;
  for (const f of flags) {
    const name = normalizeFlagName(f);
    if (!name) continue;
    acc = sanitizeSkillName(`${acc}-${name}`);
    out.push(acc);
  }
  // De-dupe, preserving order (a flag could re-collapse to the same name).
  return out.filter((v, idx) => out.indexOf(v) === idx);
}

function sanitizeSkillName(s: string): string {
  const cleaned = s
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return cleaned || "cmd";
}

// Built-in skill names that always exist (context.md / verify.md /
// progress.md). Verification-command-derived skills must not collide with
// these — a roadmap whose verification command is `code-pact verify ...`
// derives the name "verify", which would otherwise clobber the built-in
// verify.md and break adapter convergence.
const RESERVED_SKILL_NAMES = ["context", "verify", "progress"] as const;

/**
 * Returns `base` if free, else the first `base-2`, `base-3`, … not already
 * taken. Deterministic given the (insertion-ordered) `taken` set, so repeated
 * generation produces a stable, convergent file set.
 */
function uniquifySkillName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) suffix++;
  return `${base}-${suffix}`;
}

function buildCommandSkill(skillName: string, command: string): string {
  return [
    `# /${skillName} — ${command}`,
    ``,
    `Usage: /${skillName}`,
    ``,
    `Runs: ${command}`,
    ``,
  ].join("\n");
}

async function readVerificationCommands(cwd: string): Promise<string[]> {
  // Best-effort skill generation: route through the project-contained loaders so
  // a symlinked `design/roadmap.yaml` / `design/phases/*` (or a `..` phase ref)
  // cannot pull an out-of-project command string into a generated skill (CWE-59).
  // A missing / unsafe / invalid roadmap or phase degrades to "no command skills"
  // (this is generation, not a fail-closed control-plane read).
  let roadmap;
  try {
    roadmap = await loadRoadmap(cwd);
  } catch {
    return [];
  }
  const seen = new Set<string>();
  for (const ref of roadmap.phases) {
    try {
      const phase = await loadPhase(cwd, ref.path);
      for (const cmd of phase.verification.commands) seen.add(cmd);
    } catch {
      // skip unreadable / unsafe phases
    }
  }
  return Array.from(seen);
}

// ---------------------------------------------------------------------------
// AdapterDescriptor
// ---------------------------------------------------------------------------

export async function generateClaudeDesiredFiles(
  input: AdapterGenerateInput,
): Promise<DesiredAdapterFile[]> {
  // `modelVersion` and `modelProfiles` are deliberately unread: the bootstrap
  // is model-neutral, so the same bytes are generated for every Claude model
  // version. `--model` still records a pin on the profile, and the model
  // catalog still drives validation and advisory recommendation defaults; none
  // of that reaches the instruction file.
  const { cwd, profile, locale } = input;
  const skillDir = profile.skill_dir ?? ".claude/skills";

  const files: DesiredAdapterFile[] = [
    {
      path: profile.instruction_filename,
      role: "instruction",
      content: claudeMd(locale),
    },
    { path: `${skillDir}/context.md`, role: "skill", content: SKILL_CONTEXT },
    { path: `${skillDir}/verify.md`, role: "skill", content: SKILL_VERIFY },
    { path: `${skillDir}/progress.md`, role: "skill", content: SKILL_PROGRESS },
  ];

  const verificationCommands = await readVerificationCommands(cwd);
  // Seed with the built-in skill names so a derived name that collides with a
  // built-in (or with an earlier derived name) is deterministically uniquified
  // rather than silently dropped or clobbering the built-in. The final name is
  // used for BOTH the path and the rendered skill body so they never diverge.
  // Reserved prefix for code-pact-generated dynamic skills. This separates
  // our generated skills from user-authored skills in the shared
  // `.claude/skills/*.md` namespace. New dynamic skills are always generated
  // with this prefix. Legacy shared-namespace files (without the prefix) are
  // never read, hashed, overwritten, or deleted — they are preserved with a
  // warning if encountered during install/upgrade.
  const CODE_PACT_PREFIX = "code-pact-";
  const takenSkillNames = new Set<string>(RESERVED_SKILL_NAMES);
  for (const cmd of verificationCommands) {
    // Walk the self-describing candidate ladder (base, then flag-qualified
    // forms); take the first free one. Only if the whole ladder is taken do we
    // fall back to a numeric suffix on the most specific candidate.
    const variants = deriveSkillNameVariants(cmd);
    const free = variants.find(v => !takenSkillNames.has(v));
    const baseName =
      free ??
      uniquifySkillName(variants[variants.length - 1]!, takenSkillNames);
    takenSkillNames.add(baseName);
    const skillName = `${CODE_PACT_PREFIX}${baseName}`;
    files.push({
      path: `${skillDir}/${skillName}.md`,
      role: "skill",
      content: buildCommandSkill(skillName, cmd),
    });
  }

  return files;
}

export const claudeAdapterDescriptor: AdapterDescriptor = {
  generateDesiredFiles: generateClaudeDesiredFiles,
  capabilities: [
    "instructions_file",
    "skills_dir",
    "hooks_dir",
    "context_dir",
  ] as const,
  ownedPathRoles: {
    "CLAUDE.md": "instruction",
    ".claude/skills/context.md": "skill",
    ".claude/skills/verify.md": "skill",
    ".claude/skills/progress.md": "skill",
  } as const,
  // Role-scoped create-only authority: missing desired skill files in the
  // reserved `.claude/skills/code-pact-*.md` namespace may be CREATED, but
  // normal install/upgrade/doctor/conformance flows do not read/hash/overwrite
  // existing dynamic files. The only read/hash/delete exception is upgrade's
  // orphan pruning for manifest-tracked files with managed:true,
  // ownership:handed_off, this reserved namespace, and a matching manifest hash.
  // Legacy shared-namespace files (`.claude/skills/*.md` without the prefix)
  // remain warn/manual-removal and are never read/hashed/overwritten/deleted.
  createPathGlobsByRole: {
    skill: [".claude/skills/code-pact-*.md"],
  } as const,
  profilePathContract: {
    instructionFilename: "CLAUDE.md",
    skillDir: ".claude/skills",
    hookDir: ".claude/hooks",
  },
  // Schema 2 selects the bootstrap instruction contract in adapter conformance
  // (see core/adapters/conformance-spec.ts). The other adapters stay at 1 and
  // keep generating and being checked against the schema-v1 instruction file.
  adapterSchemaVersion: 2,
};
