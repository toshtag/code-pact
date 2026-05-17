import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentProfile } from "../schemas/agent-profile.ts";
import type { ModelProfile } from "../schemas/model-profile.ts";

// Cursor adapter (experimental, v0.2).
//
// Format source (verified for the v0.2 PR):
//   https://cursor.com/docs/context/rules
//
// - Canonical placement: `.cursor/rules/*.mdc` (`.cursorrules` was
//   deprecated in Cursor 0.43; we do not write it).
// - Each `.mdc` file is markdown with a YAML frontmatter block:
//   { description, globs, alwaysApply }. code-pact's agent
//   instructions are project-wide and must always be in context, so
//   we emit a single file with `alwaysApply: true` and an empty
//   `globs:` list.
// - "Experimental" status applies to this adapter — the file format
//   and placement may shift across Cursor releases. The generated
//   file carries a warning comment so the project owner sees it.

function cursorMdc(profile: AgentProfile): string {
  // Frontmatter is YAML; we hand-write it to keep the structure tight
  // and to match the exact form documented at the URL above.
  const frontmatter = [
    "---",
    "description: code-pact agent instructions (always applied)",
    "globs: []",
    "alwaysApply: true",
    "---",
  ].join("\n");

  const body = [
    `# Cursor — Project Instructions (code-pact)`,
    ``,
    `> This file is managed by [code-pact](https://github.com/toshtag/code-pact).`,
    `> The \`cursor\` adapter is **experimental** in v0.2; the .mdc format`,
    `> and \`.cursor/rules/\` placement may shift across Cursor releases.`,
    `> Source: https://cursor.com/docs/context/rules`,
    ``,
    `## How to work on a task`,
    ``,
    `1. Fetch the context pack:`,
    `   \`\`\`sh`,
    `   code-pact task context <task-id> --agent cursor`,
    `   \`\`\``,
    ``,
    `2. Implement the task.`,
    ``,
    `3. Mark the task complete. This runs verify and, on pass, appends a`,
    `   \`done\` event to \`.code-pact/state/progress.yaml\`:`,
    `   \`\`\`sh`,
    `   code-pact task complete <task-id> --agent cursor`,
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

  return `${frontmatter}\n\n${body}\n`;
}

export type AdapterGenerateResult = {
  created: string[];
  skipped: string[];
};

export async function generateCursorAdapter(
  cwd: string,
  profile: AgentProfile,
  // model profiles are accepted for interface parity. Cursor chooses
  // its own model in the editor, so we do not surface tier mapping.
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
    await mkdir(dirname(absPath), { recursive: true });
    await writeFile(absPath, content, "utf8");
    created.push(absPath);
  }

  // .cursor/rules/code-pact.mdc
  await writeIfAbsent(join(cwd, profile.instruction_filename), cursorMdc(profile));

  // .context/cursor/
  await mkdir(join(cwd, profile.context_dir), { recursive: true });

  return { created, skipped };
}
