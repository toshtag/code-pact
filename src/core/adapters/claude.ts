import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { AgentProfile } from "../schemas/agent-profile.ts";
import { normalizeModelVersion } from "../schemas/agent-profile.ts";
import {
  CLAUDE_MODEL_VERSIONS,
  CLAUDE_MODEL_GUIDANCE,
  type ClaudeModelVersion,
} from "../models/catalog.ts";
import type { ModelProfile } from "../schemas/model-profile.ts";
import { ModelTier } from "../schemas/model-profile.ts";
import { Roadmap } from "../schemas/roadmap.ts";
import { Phase } from "../schemas/phase.ts";
import type { Locale } from "../../i18n/index.ts";
import { messages as messageCatalog } from "../../i18n/index.ts";
import type {
  AdapterDescriptor,
  AdapterGenerateInput,
  DesiredAdapterFile,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Model-specific guidance blocks (data lives in core/models/catalog.ts)
// ---------------------------------------------------------------------------

function modelGuidanceSection(modelVersion: string): string {
  const isKnown = (CLAUDE_MODEL_VERSIONS as readonly string[]).includes(modelVersion);
  if (!isKnown) {
    return [
      `## Model guidance (${modelVersion})`,
      ``,
      `No model-specific guidance available for \`${modelVersion}\`. Refer to the Anthropic documentation.`,
    ].join("\n");
  }
  const g = CLAUDE_MODEL_GUIDANCE[modelVersion as ClaudeModelVersion];
  return [
    `## Model guidance (${modelVersion})`,
    ``,
    `**Effort levels:**`,
    g.effortGuidance,
    ``,
    `**Thinking:** ${g.thinkingNote}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// CLAUDE.md template
// ---------------------------------------------------------------------------

function claudeMd(
  profile: AgentProfile,
  modelProfiles: ModelProfile[],
  locale: Locale,
  modelVersion?: string,
): string {
  const tier = (t: string) => profile.model_map[t as ModelTier] ?? t;
  const t = messageCatalog[locale].templates.adapterCommon;

  const tierSection = modelProfiles
    .map((mp) => {
      const modelId = tier(mp.tier);
      const purposes = mp.purpose.join(", ");
      const efforts = mp.effort_levels.join(" | ");
      // "thinking-capable", not "thinking enabled": this is a tier-level flag.
      // The actual thinking mode and effort behavior are model/provider-specific
      // (defer to the model's current docs); keep the label version-agnostic.
      const thinking = mp.supports_thinking ? " (thinking-capable)" : "";
      return `- **${mp.tier}** → \`${modelId}\`${thinking}\n  - Use for: ${purposes}\n  - Effort: ${efforts}`;
    })
    .join("\n");

  const modelSection = modelVersion ? `\n\n${modelGuidanceSection(modelVersion)}` : "";

  return [
    `# Claude Code — Project Instructions`,
    ``,
    `> ${t.managedNotice}`,
    `> ${t.editNotice}`,
    ``,
    `## ${t.workflowHeader}`,
    ``,
    `0. ${t.step0}`,
    `   \`\`\`sh`,
    `   code-pact task prepare <task-id> --agent claude-code --json`,
    `   \`\`\``,
    `   ${t.step0Detail}`,
    ``,
    `1. ${t.step1}`,
    `   \`\`\`sh`,
    `   code-pact task context <task-id> --agent claude-code`,
    `   \`\`\``,
    ``,
    `2. ${t.step2}`,
    ``,
    `3. ${t.step3}`,
    `   \`\`\`sh`,
    `   code-pact task complete <task-id> --agent claude-code`,
    `   \`\`\``,
    `   ${t.step3FailDetail}`,
    `   ${t.step3IdempotentDetail}`,
    ``,
    `4. ${t.step4}`,
    ``,
    `> ${t.verifyNote}`,
    `>`,
    `> ${t.validateNote}`,
    `>`,
    `> ${t.packNote}`,
    ``,
    // v1.7 P16-T2: Agent contract section. Heading strings
    // (`Agent contract`, `When to invoke code-pact`,
    // `What to verify first`, `How to handle failures`) are
    // English-locked per design/decisions/agent-contract-rfc.md
    // so the P16-T4 conformance regex anchors on them across
    // locales. Body text is localised.
    `## ${t.agentContract.sectionHeader}`,
    ``,
    t.agentContract.intro,
    ``,
    `### ${t.agentContract.whenHeader}`,
    ``,
    t.agentContract.whenBody,
    ``,
    `### ${t.agentContract.verifyHeader}`,
    ``,
    t.agentContract.verifyBody,
    ``,
    `### ${t.agentContract.failHeader}`,
    ``,
    t.agentContract.failBody,
    ``,
    `## Model selection`,
    ``,
    tierSection,
    modelSection,
    ``,
    `## Skills`,
    ``,
    `Skills are stored in \`${profile.skill_dir ?? ".claude/skills"}/\`.`,
    `Each \`.md\` file in that directory is automatically loaded as a slash command.`,
    ``,
    `## Hooks`,
    ``,
    `Hooks are stored in \`${profile.hook_dir ?? ".claude/hooks"}/\`.`,
    ``,
    `## ${t.projectConventionsHeader}`,
    ``,
    `> ${t.projectConventionsHint}`,
    `> ${t.projectConventionsSource}`,
    ``,
    `- ${t.projectConventionsDefault}`,
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
 * leaking into the name — the v1.19 `--agent claude-code` → `claude-code`
 * collision bug — without needing to know which flags take values (a boolean
 * flag before a word would otherwise wrongly eat that word). `--flag=value`
 * forms are self-contained and never produce a stray word either way.
 */
function tokenizeCommand(command: string): { words: string[]; flags: string[] } {
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
  const cleaned = s.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
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
  return [`# /${skillName} — ${command}`, ``, `Usage: /${skillName}`, ``, `Runs: ${command}`, ``].join("\n");
}

async function readVerificationCommands(cwd: string): Promise<string[]> {
  let roadmapRaw: string;
  try {
    roadmapRaw = await readFile(join(cwd, "design", "roadmap.yaml"), "utf8");
  } catch {
    return [];
  }
  let roadmap: Roadmap;
  try {
    roadmap = Roadmap.parse(parseYaml(roadmapRaw) as unknown);
  } catch {
    return [];
  }
  const seen = new Set<string>();
  for (const ref of roadmap.phases) {
    try {
      const phaseRaw = await readFile(join(cwd, ref.path), "utf8");
      const phase = Phase.parse(parseYaml(phaseRaw) as unknown);
      for (const cmd of phase.verification.commands) seen.add(cmd);
    } catch {
      // skip unreadable phases
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
  const { cwd, profile, modelProfiles, locale, modelVersion } = input;
  // Normalize to the canonical version before rendering guidance: a profile
  // may carry a vendor-id alias (e.g. `model_version: claude-opus-4-8`), which
  // doctor accepts as valid. Without this, the guidance lookup (keyed by the
  // short canonical id) would miss it and fall back to the generic block.
  // Unknown values pass through unchanged → the generic block, as before.
  const rawModelVersion = modelVersion ?? profile.model_version;
  const resolvedModelVersion =
    rawModelVersion === undefined
      ? undefined
      : (normalizeModelVersion(rawModelVersion) ?? rawModelVersion);
  const skillDir = profile.skill_dir ?? ".claude/skills";

  const files: DesiredAdapterFile[] = [
    {
      path: profile.instruction_filename,
      role: "instruction",
      content: claudeMd(profile, modelProfiles, locale, resolvedModelVersion),
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
  const takenSkillNames = new Set<string>(RESERVED_SKILL_NAMES);
  for (const cmd of verificationCommands) {
    // Walk the self-describing candidate ladder (base, then flag-qualified
    // forms); take the first free one. Only if the whole ladder is taken do we
    // fall back to a numeric suffix on the most specific candidate.
    const variants = deriveSkillNameVariants(cmd);
    const free = variants.find((v) => !takenSkillNames.has(v));
    const skillName =
      free ?? uniquifySkillName(variants[variants.length - 1]!, takenSkillNames);
    takenSkillNames.add(skillName);
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
  ownedPathGlobs: [
    "CLAUDE.md",
    ".claude/skills/context.md",
    ".claude/skills/verify.md",
    ".claude/skills/progress.md",
  ] as const,
  adapterSchemaVersion: 1,
};
