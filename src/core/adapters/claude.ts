import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { AgentProfile } from "../schemas/agent-profile.ts";
import { CLAUDE_MODEL_VERSIONS, type ClaudeModelVersion } from "../schemas/agent-profile.ts";
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
// Model-specific guidance blocks
// ---------------------------------------------------------------------------

type ModelGuidance = {
  supportsHighEffort: boolean;
  effortGuidance: string;
  thinkingNote: string;
};

const MODEL_GUIDANCE: Record<ClaudeModelVersion, ModelGuidance> = {
  "opus-4.7": {
    supportsHighEffort: true,
    effortGuidance: [
      "- `high` — large context, complex architecture decisions, or tasks with `ambiguity: high`",
      "- `medium` — standard feature work (default)",
      "- `low` — small mechanical tasks (`type: refactor`, `expected_duration: short`)",
    ].join("\n"),
    thinkingNote:
      "Extended thinking is supported. Enable it for tasks flagged `ambiguity: high` or `context_size: large`.",
  },
  "opus-4.6": {
    supportsHighEffort: true,
    effortGuidance: [
      "- `high` — large context, complex architecture decisions, or tasks with `ambiguity: high`",
      "- `medium` — standard feature work (default)",
      "- `low` — small mechanical tasks (`type: refactor`, `expected_duration: short`)",
    ].join("\n"),
    thinkingNote:
      "Extended thinking is supported. Enable it for tasks flagged `ambiguity: high` or `context_size: large`.",
  },
  "sonnet-4.6": {
    supportsHighEffort: false,
    effortGuidance: [
      "- `medium` — standard feature work (default)",
      "- `low` — small mechanical tasks (`type: refactor`, `expected_duration: short`)",
      "- `high` is **not supported** on this model — switch to the `highest_reasoning` tier for complex tasks.",
    ].join("\n"),
    thinkingNote:
      "Extended thinking is supported. For tasks requiring deep reasoning (`ambiguity: high`), consider switching to the `highest_reasoning` tier model.",
  },
};

function modelGuidanceSection(modelVersion: string): string {
  const isKnown = (CLAUDE_MODEL_VERSIONS as readonly string[]).includes(modelVersion);
  if (!isKnown) {
    return [
      `## Model guidance (${modelVersion})`,
      ``,
      `No model-specific guidance available for \`${modelVersion}\`. Refer to the Anthropic documentation.`,
    ].join("\n");
  }
  const g = MODEL_GUIDANCE[modelVersion as ClaudeModelVersion];
  return [
    `## Model guidance (${modelVersion})`,
    ``,
    `**Effort levels:**`,
    g.effortGuidance,
    ``,
    `**Extended thinking:** ${g.thinkingNote}`,
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
      const thinking = mp.supports_thinking ? " (thinking enabled)" : "";
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

export function deriveSkillName(command: string): string {
  const tokens = command.trim().split(/\s+/);
  const first = tokens[0] ?? "";
  if (tokens.length >= 2 && (PACKAGE_MANAGERS as readonly string[]).includes(first)) {
    const rest = tokens[1] === "run" ? tokens.slice(2) : tokens.slice(1);
    const task = rest.find((t) => !t.startsWith("-"));
    if (task) return sanitizeSkillName(task);
  }
  const nonFlags = tokens.filter((t) => !t.startsWith("-"));
  const last = nonFlags[nonFlags.length - 1] ?? first;
  return sanitizeSkillName(last);
}

function sanitizeSkillName(s: string): string {
  const cleaned = s.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-").replace(/^-|-$/, "");
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
  const resolvedModelVersion = modelVersion ?? profile.model_version;
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
    const skillName = uniquifySkillName(deriveSkillName(cmd), takenSkillNames);
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
