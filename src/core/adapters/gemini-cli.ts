import type { AgentProfile } from "../schemas/agent-profile.ts";
import type { Locale } from "../../i18n/index.ts";
import { messages as messageCatalog } from "../../i18n/index.ts";
import type {
  AdapterDescriptor,
  AdapterGenerateInput,
  DesiredAdapterFile,
} from "./types.ts";

// Gemini CLI adapter (experimental, v0.2).
//
// Format source (verified for the v0.2 PR):
//   https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/gemini-md.md
//
// Gemini CLI discovers `GEMINI.md` hierarchically: it walks from the
// current working directory up to the project root (.git) and also
// reads ~/.gemini/GEMINI.md and subdirectory GEMINI.md files. Writing
// a single GEMINI.md at the project root is the idiomatic placement
// and mirrors CLAUDE.md / AGENTS.md.
//
// Plain markdown — no frontmatter. The CLI concatenates the discovered
// files in order and ships them as memory context.
//
// "Experimental" caveat: Gemini CLI is young and the npm name has
// typosquat reports. The generated file body advises users to install
// from the google-gemini org. The adapter shape may shift as the CLI's
// memory/discovery semantics evolve.

function geminiMd(profile: AgentProfile, locale: Locale): string {
  const t = messageCatalog[locale].templates.adapterCommon;

  return [
    `# Gemini CLI — Project Instructions (code-pact)`,
    ``,
    `> ${t.managedNotice}`,
    `> The \`gemini-cli\` adapter is **experimental** in v0.2 and may shift`,
    `> across Gemini CLI releases.`,
    `> Source: https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/gemini-md.md`,
    `> Install only from the official org (\`google-gemini\`) — typosquat`,
    `> packages with similar names have been reported on npm.`,
    ``,
    `## ${t.workflowHeader}`,
    ``,
    `1. ${t.step1}`,
    `   \`\`\`sh`,
    `   code-pact task context <task-id> --agent gemini-cli`,
    `   \`\`\``,
    ``,
    `2. ${t.step2}`,
    ``,
    `3. ${t.step3}`,
    `   \`\`\`sh`,
    `   code-pact task complete <task-id> --agent gemini-cli`,
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

export async function generateGeminiCliDesiredFiles(
  input: AdapterGenerateInput,
): Promise<DesiredAdapterFile[]> {
  return [
    {
      path: input.profile.instruction_filename,
      role: "instruction",
      content: geminiMd(input.profile, input.locale),
    },
  ];
}

export const geminiCliAdapterDescriptor: AdapterDescriptor = {
  generateDesiredFiles: generateGeminiCliDesiredFiles,
  capabilities: ["instructions_file", "context_dir"] as const,
  ownedPathGlobs: ["GEMINI.md"] as const,
  adapterSchemaVersion: 1,
};
