import type { AgentProfile } from "../schemas/agent-profile.ts";
import type { ModelProfile } from "../schemas/model-profile.ts";
import { ModelTier } from "../schemas/model-profile.ts";
import type { Locale } from "../../i18n/index.ts";
import { messages as messageCatalog } from "../../i18n/index.ts";
import type {
  AdapterDescriptor,
  AdapterGenerateInput,
  DesiredAdapterFile,
} from "./types.ts";

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
    `0. ${t.step0}`,
    `   \`\`\`sh`,
    `   code-pact recommend --phase <phase-id> --task <task-id> --agent codex --json`,
    `   \`\`\``,
    `   ${t.step0Detail}`,
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
    `> ${t.validateNote}`,
    `>`,
    `> ${t.packNote}`,
    ``,
    // v1.7 P16-T3: Agent contract section (same shape as claude-code
    // / generic). Heading strings are English-locked per
    // design/decisions/agent-contract-rfc.md so the P16-T4 conformance
    // regex anchors on them across locales. Body text is localised.
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
// AdapterDescriptor
// ---------------------------------------------------------------------------

export async function generateCodexDesiredFiles(
  input: AdapterGenerateInput,
): Promise<DesiredAdapterFile[]> {
  return [
    {
      path: input.profile.instruction_filename,
      role: "instruction",
      content: agentsMd(input.profile, input.modelProfiles, input.locale),
    },
  ];
}

export const codexAdapterDescriptor: AdapterDescriptor = {
  generateDesiredFiles: generateCodexDesiredFiles,
  capabilities: ["instructions_file", "context_dir"] as const,
  ownedPathGlobs: ["AGENTS.md"] as const,
  adapterSchemaVersion: 1,
};
