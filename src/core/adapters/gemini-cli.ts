import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentProfile } from "../schemas/agent-profile.ts";
import type { ModelProfile } from "../schemas/model-profile.ts";

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

function geminiMd(profile: AgentProfile): string {
  return [
    `# Gemini CLI — Project Instructions (code-pact)`,
    ``,
    `> This file is managed by [code-pact](https://github.com/toshtag/code-pact).`,
    `> The \`gemini-cli\` adapter is **experimental** in v0.2 and may shift`,
    `> across Gemini CLI releases.`,
    `> Source: https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/gemini-md.md`,
    `> Install only from the official org (\`google-gemini\`) — typosquat`,
    `> packages with similar names have been reported on npm.`,
    ``,
    `## How to work on a task`,
    ``,
    `1. Fetch the context pack:`,
    `   \`\`\`sh`,
    `   code-pact task context <task-id> --agent gemini-cli`,
    `   \`\`\``,
    ``,
    `2. Implement the task.`,
    ``,
    `3. Mark the task complete. This runs verify and, on pass, appends a`,
    `   \`done\` event to \`.code-pact/state/progress.yaml\`:`,
    `   \`\`\`sh`,
    `   code-pact task complete <task-id> --agent gemini-cli`,
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
    `## Context directory`,
    ``,
    `Context packs for this agent live under \`${profile.context_dir}/\`.`,
    ``,
    `## Project-specific conventions`,
    ``,
    `> Replace this section with your project's actual conventions.`,
    `> See \`design/constitution.md\` and \`design/rules/\` for the source of truth.`,
    ``,
    `- Follow \`design/rules/coding-style.md\` for code style.`,
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
  await writeIfAbsent(join(cwd, profile.instruction_filename), geminiMd(profile));

  // .context/gemini-cli/
  await mkdir(join(cwd, profile.context_dir), { recursive: true });

  return { created, skipped };
}
