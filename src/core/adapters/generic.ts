import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentProfile } from "../schemas/agent-profile.ts";
import type { ModelProfile } from "../schemas/model-profile.ts";

// The generic adapter targets any agent that does not have a dedicated
// instruction file convention (CLAUDE.md, AGENTS.md, etc). It writes one
// human-readable document under docs/code-pact/ so it does not collide
// with arbitrary project docs.

function agentInstructionsMd(profile: AgentProfile): string {
  return [
    `# Agent Instructions — Generic`,
    ``,
    `> This file is managed by [code-pact](https://github.com/toshtag/code-pact).`,
    `> Copy or symlink it into your agent's instruction location (e.g. .cursorrules,`,
    `> GEMINI.md, or any other tool-specific path).`,
    ``,
    `## Prerequisites`,
    ``,
    `Ensure \`code-pact\` is available in your PATH. During local development,`,
    `\`pnpm link --global\` or a local tarball install both work.`,
    ``,
    `## How to work on a task`,
    ``,
    `1. Fetch the context pack:`,
    `   \`\`\`sh`,
    `   code-pact task context <task-id> --agent generic`,
    `   \`\`\``,
    ``,
    `2. Implement the task.`,
    ``,
    `3. Verify completion:`,
    `   \`\`\`sh`,
    `   code-pact verify --phase <phase-id> --task <task-id>`,
    `   \`\`\``,
    ``,
    `4. Report the result to the user.`,
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

export async function generateGenericAdapter(
  cwd: string,
  profile: AgentProfile,
  // model profiles are accepted for interface parity but the generic
  // instruction file does not currently surface model tier mapping.
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

  // docs/code-pact/agent-instructions.md
  await writeIfAbsent(join(cwd, profile.instruction_filename), agentInstructionsMd(profile));

  // .context/generic/
  const contextDir = join(cwd, profile.context_dir);
  await mkdir(contextDir, { recursive: true });

  return { created, skipped };
}
