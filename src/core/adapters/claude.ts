import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentProfile } from "../schemas/agent-profile.ts";
import { CLAUDE_MODEL_VERSIONS, type ClaudeModelVersion } from "../schemas/agent-profile.ts";
import type { ModelProfile } from "../schemas/model-profile.ts";
import { ModelTier } from "../schemas/model-profile.ts";
import type { Locale } from "../../i18n/index.ts";
import { messages as messageCatalog } from "../../i18n/index.ts";

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
    `> ${t.packNote}`,
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
// Result
// ---------------------------------------------------------------------------

export type AdapterGenerateResult = {
  created: string[];
  skipped: string[];
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function generateClaudeAdapter(
  cwd: string,
  profile: AgentProfile,
  modelProfiles: ModelProfile[],
  force: boolean,
  locale: Locale,
  modelVersion?: string,
): Promise<AdapterGenerateResult> {
  const created: string[] = [];
  const skipped: string[] = [];

  // Resolve model version: CLI override takes precedence over profile field.
  const resolvedModelVersion = modelVersion ?? profile.model_version;

  async function writeIfAbsent(absPath: string, content: string): Promise<void> {
    if (!force) {
      try {
        await readFile(absPath);
        skipped.push(absPath);
        return;
      } catch {
        // file doesn't exist — proceed
      }
    }
    await writeFile(absPath, content, "utf8");
    created.push(absPath);
  }

  // CLAUDE.md at project root
  await writeIfAbsent(
    join(cwd, profile.instruction_filename),
    claudeMd(profile, modelProfiles, locale, resolvedModelVersion),
  );

  // .claude/skills/
  const skillDir = join(cwd, profile.skill_dir ?? ".claude/skills");
  await mkdir(skillDir, { recursive: true });
  await writeIfAbsent(join(skillDir, "context.md"), SKILL_CONTEXT);
  await writeIfAbsent(join(skillDir, "verify.md"), SKILL_VERIFY);
  await writeIfAbsent(join(skillDir, "progress.md"), SKILL_PROGRESS);

  // .claude/hooks/ (empty placeholder — user fills in)
  const hookDir = join(cwd, profile.hook_dir ?? ".claude/hooks");
  await mkdir(hookDir, { recursive: true });

  return { created, skipped };
}
