import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentProfile } from "../schemas/agent-profile.ts";
import type { ModelProfile } from "../schemas/model-profile.ts";
import type { Locale } from "../../i18n/index.ts";
import { messages as messageCatalog } from "../../i18n/index.ts";

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

export type AdapterGenerateResult = {
  created: string[];
  skipped: string[];
};

export async function generateGeminiCliAdapter(
  cwd: string,
  profile: AgentProfile,
  // model profiles are accepted for interface parity. Gemini CLI
  // selects its own model in settings; surfacing tier mapping here
  // would only confuse the user.
  _modelProfiles: ModelProfile[],
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

  // GEMINI.md at project root
  await writeIfAbsent(join(cwd, profile.instruction_filename), geminiMd(profile, locale));

  // .context/gemini-cli/
  await mkdir(join(cwd, profile.context_dir), { recursive: true });

  return { created, skipped };
}
