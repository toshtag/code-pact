import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentProfile } from "../schemas/agent-profile.ts";
import type { ModelProfile } from "../schemas/model-profile.ts";
import { ModelTier } from "../schemas/model-profile.ts";
import type { Locale } from "../../i18n/index.ts";
import { messages as messageCatalog } from "../../i18n/index.ts";

// ---------------------------------------------------------------------------
// AGENTS.md template
// ---------------------------------------------------------------------------

function agentsMd(profile: AgentProfile, modelProfiles: ModelProfile[], locale: Locale): string {
  const tier = (t: string) => profile.model_map[t as ModelTier] ?? t;
  const t = messageCatalog[locale].templates.adapterCommon;

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
    `> ${t.managedNotice}`,
    `> ${t.editNotice}`,
    ``,
    `## ${t.workflowHeader}`,
    ``,
    `1. ${t.step1}`,
    `   \`\`\`sh`,
    `   code-pact task context <task-id> --agent codex`,
    `   \`\`\``,
    ``,
    `2. ${t.step2}`,
    ``,
    `3. ${t.step3}`,
    `   \`\`\`sh`,
    `   code-pact task complete <task-id> --agent codex`,
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
  locale: Locale,
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
  await writeIfAbsent(
    join(cwd, profile.instruction_filename),
    agentsMd(profile, modelProfiles, locale),
  );

  // .context/codex/ (context pack output dir)
  const contextDir = join(cwd, profile.context_dir);
  await mkdir(contextDir, { recursive: true });

  return { created, skipped };
}
