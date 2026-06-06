import type { AgentProfile } from "../schemas/agent-profile.ts";
import type { ModelProfile } from "../schemas/model-profile.ts";
import type { Locale } from "../../i18n/index.ts";
import type {
  AdapterDescriptor,
  AdapterGenerateInput,
  DesiredAdapterFile,
} from "./types.ts";
import {
  adapterCommon,
  renderWorkflowSection,
  renderAgentContractSection,
  renderModelSelectionSection,
  renderProjectConventionsSection,
} from "./template-sections.ts";

// ---------------------------------------------------------------------------
// AGENTS.md template
// ---------------------------------------------------------------------------

function agentsMd(profile: AgentProfile, modelProfiles: ModelProfile[], locale: Locale): string {
  const t = adapterCommon(locale);
  return [
    `# Codex — Project Instructions`,
    ``,
    `> ${t.managedNotice}`,
    `> ${t.editNotice}`,
    ``,
    ...renderWorkflowSection(t, "codex", { step0: true, validateNote: true }),
    ``,
    ...renderAgentContractSection(t),
    ``,
    ...renderModelSelectionSection(modelProfiles, profile, { thinking: false }),
    ``,
    ...renderProjectConventionsSection(t),
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
