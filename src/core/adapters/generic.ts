import type { AgentProfile } from "../schemas/agent-profile.ts";
import type { Locale } from "../../i18n/index.ts";
import { messages as messageCatalog } from "../../i18n/index.ts";
import type {
  AdapterDescriptor,
  AdapterGenerateInput,
  DesiredAdapterFile,
} from "./types.ts";

// The generic adapter targets any agent that does not have a dedicated
// instruction file convention (CLAUDE.md, AGENTS.md, etc). It writes one
// human-readable document under docs/code-pact/ so it does not collide
// with arbitrary project docs.

function agentInstructionsMd(profile: AgentProfile, locale: Locale): string {
  const t = messageCatalog[locale].templates.adapterCommon;

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
    `## ${t.workflowHeader}`,
    ``,
    `0. ${t.step0}`,
    `   \`\`\`sh`,
    `   code-pact recommend --phase <phase-id> --task <task-id> --agent generic --json`,
    `   \`\`\``,
    `   ${t.step0Detail}`,
    ``,
    `1. ${t.step1}`,
    `   \`\`\`sh`,
    `   code-pact task context <task-id> --agent generic`,
    `   \`\`\``,
    ``,
    `2. ${t.step2}`,
    ``,
    `3. ${t.step3}`,
    `   \`\`\`sh`,
    `   code-pact task complete <task-id> --agent generic`,
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
    `## Context directory`,
    ``,
    `Context packs for this agent live under \`${profile.context_dir}/\`.`,
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
  ownedPathGlobs: ["docs/code-pact/agent-instructions.md"] as const,
  adapterSchemaVersion: 1,
};
