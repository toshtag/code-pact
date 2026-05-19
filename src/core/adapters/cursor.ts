import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentProfile } from "../schemas/agent-profile.ts";
import type { ModelProfile } from "../schemas/model-profile.ts";
import type { Locale } from "../../i18n/index.ts";
import { messages as messageCatalog } from "../../i18n/index.ts";
import type {
  AdapterDescriptor,
  AdapterGenerateInput,
  DesiredAdapterFile,
} from "./types.ts";

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

function cursorMdc(profile: AgentProfile, locale: Locale): string {
  // Frontmatter is YAML; we hand-write it to keep the structure tight
  // and to match the exact form documented at the URL above.
  const frontmatter = [
    "---",
    "description: code-pact agent instructions (always applied)",
    "globs: []",
    "alwaysApply: true",
    "---",
  ].join("\n");

  const t = messageCatalog[locale].templates.adapterCommon;

  const body = [
    `# Cursor — Project Instructions (code-pact)`,
    ``,
    `> ${t.managedNotice}`,
    `> The \`cursor\` adapter is **experimental** in v0.2; the .mdc format`,
    `> and \`.cursor/rules/\` placement may shift across Cursor releases.`,
    `> Source: https://cursor.com/docs/context/rules`,
    ``,
    `## ${t.workflowHeader}`,
    ``,
    `1. ${t.step1}`,
    `   \`\`\`sh`,
    `   code-pact task context <task-id> --agent cursor`,
    `   \`\`\``,
    ``,
    `2. ${t.step2}`,
    ``,
    `3. ${t.step3}`,
    `   \`\`\`sh`,
    `   code-pact task complete <task-id> --agent cursor`,
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
    await mkdir(dirname(absPath), { recursive: true });
    await writeFile(absPath, content, "utf8");
    created.push(absPath);
  }

  // .cursor/rules/code-pact.mdc
  await writeIfAbsent(join(cwd, profile.instruction_filename), cursorMdc(profile, locale));

  // .context/cursor/
  await mkdir(join(cwd, profile.context_dir), { recursive: true });

  return { created, skipped };
}

// ---------------------------------------------------------------------------
// AdapterDescriptor (P7 — pure desired-file generation)
// ---------------------------------------------------------------------------

export async function generateCursorDesiredFiles(
  input: AdapterGenerateInput,
): Promise<DesiredAdapterFile[]> {
  return [
    {
      path: input.profile.instruction_filename,
      role: "rule",
      content: cursorMdc(input.profile, input.locale),
    },
  ];
}

export const cursorAdapterDescriptor: AdapterDescriptor = {
  generateDesiredFiles: generateCursorDesiredFiles,
  capabilities: ["rules_file", "context_dir"] as const,
  ownedPathGlobs: [".cursor/rules/code-pact.mdc"] as const,
  adapterSchemaVersion: 1,
};
