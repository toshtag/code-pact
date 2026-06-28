import type { AgentProfile } from "../schemas/agent-profile.ts";
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
  renderContextDirectorySection,
  renderProjectConventionsSection,
} from "./template-sections.ts";

// The generic adapter targets any agent that does not have a dedicated
// instruction file convention (CLAUDE.md, AGENTS.md, etc). It writes one
// human-readable document under docs/code-pact/ so it does not collide
// with arbitrary project docs.

function agentInstructionsMd(profile: AgentProfile, locale: Locale): string {
  const t = adapterCommon(locale);

  return [
    `# Agent Instructions — Generic`,
    ``,
    `> ${t.managedNotice}`,
    `> Copy or symlink it into your agent's instruction location (e.g. .cursorrules,`,
    `> GEMINI.md, or any other tool-specific path).`,
    ``,
    `## Prerequisites`,
    ``,
    `Ensure \`code-pact\` is available in your PATH. During local development,`,
    `\`pnpm link --global\` or a local tarball install both work.`,
    ``,
    ...renderWorkflowSection(t, "generic", { step0: true, validateNote: true }),
    ``,
    ...renderAgentContractSection(t),
    ``,
    ...renderContextDirectorySection(profile),
    ``,
    ...renderProjectConventionsSection(t),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// AdapterDescriptor
// ---------------------------------------------------------------------------

export async function generateGenericDesiredFiles(
  input: AdapterGenerateInput,
): Promise<DesiredAdapterFile[]> {
  return [
    {
      path: input.profile.instruction_filename,
      role: "instruction",
      content: agentInstructionsMd(input.profile, input.locale),
    },
  ];
}

export const genericAdapterDescriptor: AdapterDescriptor = {
  generateDesiredFiles: generateGenericDesiredFiles,
  capabilities: ["instructions_file", "context_dir"] as const,
  ownedPathRoles: {
    "docs/code-pact/agent-instructions.md": "instruction",
  } as const,
  adapterSchemaVersion: 1,
};
