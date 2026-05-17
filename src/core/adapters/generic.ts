import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentProfile } from "../schemas/agent-profile.ts";
import type { ModelProfile } from "../schemas/model-profile.ts";
import type { Locale } from "../../i18n/index.ts";
import { messages as messageCatalog } from "../../i18n/index.ts";

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

export async function generateGenericAdapter(
  cwd: string,
  profile: AgentProfile,
  // model profiles are accepted for interface parity but the generic
  // instruction file does not currently surface model tier mapping.
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

  // docs/code-pact/agent-instructions.md
  await writeIfAbsent(join(cwd, profile.instruction_filename), agentInstructionsMd(profile, locale));

  // .context/generic/
  const contextDir = join(cwd, profile.context_dir);
  await mkdir(contextDir, { recursive: true });

  return { created, skipped };
}
