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
  renderContextDirectorySection,
  renderProjectConventionsSection,
} from "./template-sections.ts";

// Gemini CLI adapter (experimental).
//
// Format source:
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
  const t = adapterCommon(locale);

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
    ...renderWorkflowSection(t, "gemini-cli", {
      step0: false,
      validateNote: false,
    }),
    ``,
    ...renderContextDirectorySection(profile),
    ``,
    ...renderProjectConventionsSection(t),
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
  ownedPathRoles: { "GEMINI.md": "instruction" } as const,
  profilePathContract: {
    instructionFilename: "GEMINI.md",
  },
  adapterSchemaVersion: 1,
};
