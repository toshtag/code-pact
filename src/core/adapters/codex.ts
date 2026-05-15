import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentProfile } from "../schemas/agent-profile.ts";
import type { ModelProfile } from "../schemas/model-profile.ts";
import { ModelTier } from "../schemas/model-profile.ts";

// ---------------------------------------------------------------------------
// AGENTS.md template
// ---------------------------------------------------------------------------

function agentsMd(profile: AgentProfile, modelProfiles: ModelProfile[]): string {
  const tier = (t: string) => profile.model_map[t as ModelTier] ?? t;

  const tierSection = modelProfiles
    .map((mp) => {
      const modelId = tier(mp.tier);
      const purposes = mp.purpose.join(", ");
      const efforts = mp.effort_levels.join(" | ");
      return `- **${mp.tier}** → \`${modelId}\`\n  - Use for: ${purposes}\n  - Effort: ${efforts}`;
    })
    .join("\n");

  return [
    `# Codex — Project Instructions`,
    ``,
    `> This file is managed by [code-pact](https://github.com/toshtag/code-pact).`,
    `> Edit the sections marked "Project-specific" to reflect your project's conventions.`,
    ``,
    `## Model selection`,
    ``,
    tierSection,
    ``,
    `## Context directory`,
    ``,
    `Agent context packs are written to \`${profile.context_dir}/\`.`,
    `Run \`code-pact pack --phase <id> --task <id> --agent codex\` before starting a task.`,
    ``,
    `## Project-specific conventions`,
    ``,
    `> Replace this section with your project's actual conventions.`,
    `> See \`design/constitution.md\` and \`design/rules/\` for the source of truth.`,
    ``,
    `- Follow \`design/rules/coding-style.md\` for code style.`,
    `- Record completed tasks in \`.code-pact/state/progress.yaml\`.`,
    `- Use \`code-pact verify\` to check completion criteria before marking a task done.`,
  ].join("\n");
}

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

export async function generateCodexAdapter(
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

  // AGENTS.md at project root
  await writeIfAbsent(join(cwd, profile.instruction_filename), agentsMd(profile, modelProfiles));

  // .context/codex/ (context pack output dir)
  const contextDir = join(cwd, profile.context_dir);
  await mkdir(contextDir, { recursive: true });

  return { created, skipped };
}
