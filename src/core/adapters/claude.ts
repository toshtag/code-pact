import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml, stringify as toYaml } from "yaml";
import type { AgentProfile } from "../schemas/agent-profile.ts";
import type { ModelProfile } from "../schemas/model-profile.ts";
import { ModelTier } from "../schemas/model-profile.ts";

// ---------------------------------------------------------------------------
// CLAUDE.md template
// ---------------------------------------------------------------------------

function claudeMd(profile: AgentProfile, modelProfiles: ModelProfile[]): string {
  const tier = (t: string) => profile.model_map[t as ModelTier] ?? t;

  const tierSection = modelProfiles
    .map((mp) => {
      const modelId = tier(mp.tier);
      const purposes = mp.purpose.join(", ");
      const efforts = mp.effort_levels.join(" | ");
      const thinking = mp.supports_thinking ? " (thinking enabled)" : "";
      return `- **${mp.tier}** → \`${modelId}\`${thinking}\n  - Use for: ${purposes}\n  - Effort: ${efforts}`;
    })
    .join("\n");

  return [
    `# Claude Code — Project Instructions`,
    ``,
    `> This file is managed by [code-pact](https://github.com/toshtag/code-pact).`,
    `> Edit the sections marked "Project-specific" to reflect your project's conventions.`,
    ``,
    `## How to work on a task`,
    ``,
    `1. Fetch the context pack:`,
    `   \`\`\`sh`,
    `   code-pact task context <task-id> --agent claude-code`,
    `   \`\`\``,
    ``,
    `2. Implement the task.`,
    ``,
    `3. Mark the task complete. This runs verify and, on pass, appends a`,
    `   \`done\` event to \`.code-pact/state/progress.yaml\`:`,
    `   \`\`\`sh`,
    `   code-pact task complete <task-id> --agent claude-code`,
    `   \`\`\``,
    `   If verify fails, this command exits 1 and progress.yaml is left`,
    `   unchanged. If a \`done\` event already exists, it is a no-op`,
    `   (\`already_done: true\`).`,
    ``,
    `4. Report the result to the user.`,
    ``,
    `> The low-level \`code-pact verify --phase <p> --task <t>\` is still`,
    `> available if you need to inspect verify output without recording`,
    `> a progress event.`,
    `>`,
    `> **Internal command:** \`code-pact pack\` is used internally by \`task context\`.`,
    `> Do not call \`pack\` directly — use \`code-pact task context <task-id>\` instead.`,
    ``,
    `## Model selection`,
    ``,
    tierSection,
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
    `## Project-specific conventions`,
    ``,
    `> Replace this section with your project's actual conventions.`,
    `> See \`design/constitution.md\` and \`design/rules/\` for the source of truth.`,
    ``,
    `- Follow \`design/rules/coding-style.md\` for code style.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Skill templates
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
): Promise<AdapterGenerateResult> {
  const created: string[] = [];
  const skipped: string[] = [];

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
  await writeIfAbsent(join(cwd, profile.instruction_filename), claudeMd(profile, modelProfiles));

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
