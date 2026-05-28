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
  /**
   * Schema-only mode (P2). Emits just the YAML format example + output
   * rules, without reading design/brief.md or design/constitution.md.
   * For agents that already hold the project context and only need the
   * output shape fixed. `hasBrief` / `hasConstitution` are forced false.
   */
  schemaOnly?: boolean;
};

export type PlanPromptResult = {
  prompt: string;
  /** True when the prompt was generated in schema-only mode (P2). */
  schemaOnly: boolean;
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
    verify_commands:
      - <verification command>
    definition_of_done:
      - <done criterion>
    tasks:
      - id: P1-T1
        description: <task description>
        type: feature | bugfix | refactor | docs | architecture | test | mechanical_refactor | other
        ambiguity: low | medium | high
        risk: low | medium | high
        context_size: small | medium | large
        write_surface: low | medium | high
        verification_strength: weak | medium | strong
        expected_duration: short | medium | long
        status: planned
        requires_decision: true | false
        # Optional readiness fields — include what you know, omit if unknown (do not emit empty arrays):
        depends_on:
          - <task id>
        reads:
          - <repo-relative path or glob>
        writes:
          - <repo-relative path or glob>
        decision_refs:
          - <repo-relative ADR path>
        acceptance_refs:
          - <repo-relative evidence path>`;

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

/**
 * Schema-only prompt (P2): the YAML format example plus terse output
 * rules, with no brief/constitution sections. The example is shown fenced
 * for readability; the rules tell the agent its OWN output must be raw
 * YAML (no fences) so `phase import` can read the saved file directly.
 */
export function generateSchemaOnlyPrompt(locale: Locale): string {
  const t = messageCatalog[locale].templates.planPrompt;
  const s = t.schemaOnly;
  const rules = s.rules.map((r) => `- ${r}`).join("\n");
  return [
    s.intro,
    `## ${t.formatHeader}\n\n\`\`\`yaml\n${YAML_FORMAT_EXAMPLE}\n\`\`\``,
    `## ${s.rulesHeader}\n\n${rules}`,
  ].join("\n\n") + "\n";
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
    "Run `code-pact plan lint --include-quality --json` to validate the imported phase and surface any clarify advisories.",
    "Review and resolve the clarify advisories lint reports (TASK_DECISION_UNRESOLVED, PHASE_CONFIDENCE_LOW) before relying on runbooks for implementation planning — add an ADR under design/decisions/ for decision tasks (verify blocks completion without it), or raise the phase confidence once the design is settled.",
    "Run `code-pact phase runbook <imported-phase-id> --json` to see the recommended per-phase next steps.",
  );
  return steps;
}

/**
 * Schema-only next steps (P2). Skips the brief/constitution capture hint
 * (schema-only deliberately bypasses them) and points straight at the
 * save → import → lint → runbook loop.
 */
function buildSchemaOnlyNextSteps(): string[] {
  return [
    "Ask your agent to emit the roadmap in the format above and capture its YAML response into a file (e.g. `design/imports/p1.yaml`).",
    "Run `code-pact phase import design/imports/p1.yaml --json` to ingest the YAML.",
    "Run `code-pact plan lint --include-quality --json` to validate the imported phase(s) and surface any clarify advisories.",
    "Run `code-pact phase runbook <imported-phase-id> --json` to see the recommended per-phase next steps.",
  ];
}

export async function runPlanPrompt(opts: PlanPromptOptions): Promise<PlanPromptResult> {
  const { cwd, locale, clipboard } = opts;
  const schemaOnly = opts.schemaOnly === true;

  // Schema-only short-circuits file reads: it never grounds on the brief
  // or constitution, so the agent's existing context stays the source.
  if (schemaOnly) {
    const prompt = generateSchemaOnlyPrompt(locale);
    const clipboardCopied = clipboard ? await copyToClipboard(prompt) : false;
    return {
      prompt,
      schemaOnly: true,
      hasBrief: false,
      hasConstitution: false,
      clipboardCopied,
      suggested_next_steps: buildSchemaOnlyNextSteps(),
    };
  }

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
    schemaOnly: false,
    hasBrief,
    hasConstitution,
    clipboardCopied,
    suggested_next_steps: buildSuggestedNextSteps(hasBrief, hasConstitution),
  };
}
