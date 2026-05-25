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
  /**
   * Additive guidance (v1.4 P13-T4). Always present, even as []. Names
   * the canonical "prompt → import → lint → runbook" sequence so the
   * AI-assisted planning loop is CLI-emitted, not docs-only.
   *
   * Field-presence-fixed per the P12 RunbookStep convention extended in
   * P13: JSON consumers can assume the schema is constant.
   */
  suggested_next_steps: string[];
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
        type: feature | bugfix | refactor | docs | architecture | test
        ambiguity: low | medium | high
        risk: low | medium | high
        context_size: small | medium | large
        write_surface: low | medium | high
        verification_strength: weak | medium | strong
        requires_decision: true | false`;

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

/**
 * Builds the additive `suggested_next_steps` array. Always returns the
 * canonical four-step AI-assisted planning sequence; appends a
 * brief/constitution capture hint when either is missing.
 */
function buildSuggestedNextSteps(
  hasBrief: boolean,
  hasConstitution: boolean,
): string[] {
  const steps: string[] = [];
  if (!hasBrief || !hasConstitution) {
    steps.push(
      "Consider running `code-pact plan brief` and `code-pact plan constitution` first to capture intent and principles before invoking your AI agent.",
    );
  }
  steps.push(
    "Run the planning prompt above through your AI agent of choice (Claude, ChatGPT, etc.) and capture its YAML response into a file (e.g. `design/imports/p1.yaml`).",
    "Run `code-pact phase import design/imports/p1.yaml --json` to ingest the AI-generated YAML.",
    "Run `code-pact plan lint --json` to validate the imported phase.",
    "Run `code-pact phase runbook <imported-phase-id> --json` to see the recommended per-phase next steps.",
  );
  return steps;
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

  const hasBrief = brief !== null;
  const hasConstitution = constitution !== null;

  return {
    prompt,
    hasBrief,
    hasConstitution,
    clipboardCopied,
    suggested_next_steps: buildSuggestedNextSteps(hasBrief, hasConstitution),
  };
}
