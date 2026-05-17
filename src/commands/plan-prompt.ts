import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import type { Locale } from "../i18n/index.ts";
import { messages as messageCatalog } from "../i18n/index.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PlanPromptOptions = {
  cwd: string;
  locale: Locale;
  clipboard: boolean;
};

export type PlanPromptResult = {
  prompt: string;
  hasBrief: boolean;
  hasConstitution: boolean;
  clipboardCopied: boolean;
};

// ---------------------------------------------------------------------------
// YAML schema example — language-agnostic, describes the code-pact format
// ---------------------------------------------------------------------------

const YAML_FORMAT_EXAMPLE = `\
phases:
  - id: P1
    name: <phase name>
    weight: <integer 1–100>
    objective: <objective of this phase>
    confidence: low | medium | high
    risk: low | medium | high
    definition_of_done:
      - <done criterion>
    verification:
      commands:
        - <verification command>
    tasks:
      - id: P1-T1
        description: <task description>
        type: feature | bugfix | refactor | docs | architecture | test`;

// ---------------------------------------------------------------------------
// Prompt generation
// ---------------------------------------------------------------------------

export function generatePlanningPrompt(
  brief: string | null,
  constitution: string | null,
  locale: Locale,
): string {
  const t = messageCatalog[locale].templates.planPrompt;

  const sections: string[] = [t.intro];

  // Brief section
  const briefContent = brief !== null ? brief.trim() : t.noBriefNotice;
  sections.push(`## ${t.briefHeader}\n\n${briefContent}`);

  // Constitution section — only included when the file exists
  if (constitution !== null) {
    sections.push(`## ${t.constitutionHeader}\n\n${constitution.trim()}`);
  }

  // YAML format
  sections.push(`## ${t.formatHeader}\n\n\`\`\`yaml\n${YAML_FORMAT_EXAMPLE}\n\`\`\``);

  // Guidelines
  const guideLines = t.guidelines.map((g) => `- ${g}`).join("\n");
  sections.push(`## ${t.guidelinesHeader}\n\n${guideLines}`);

  return sections.join("\n\n") + "\n";
}

// ---------------------------------------------------------------------------
// Clipboard helper
// ---------------------------------------------------------------------------

async function copyToClipboard(text: string): Promise<boolean> {
  let cmd: string;
  let args: string[];

  if (process.platform === "darwin") {
    cmd = "pbcopy";
    args = [];
  } else {
    cmd = "xclip";
    args = ["-selection", "clipboard"];
  }

  return new Promise<boolean>((resolve) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
    child.stdin.write(text, () => child.stdin.end());
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

export async function runPlanPrompt(opts: PlanPromptOptions): Promise<PlanPromptResult> {
  const { cwd, locale, clipboard } = opts;

  const [brief, constitution] = await Promise.all([
    readFileOrNull(join(cwd, "design", "brief.md")),
    readFileOrNull(join(cwd, "design", "constitution.md")),
  ]);

  const prompt = generatePlanningPrompt(brief, constitution, locale);

  let clipboardCopied = false;
  if (clipboard) {
    clipboardCopied = await copyToClipboard(prompt);
  }

  return {
    prompt,
    hasBrief: brief !== null,
    hasConstitution: constitution !== null,
    clipboardCopied,
  };
}
