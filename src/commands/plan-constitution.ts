import { readFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { atomicWriteText } from "../io/atomic-text.ts";
import { Prompter } from "../lib/prompt.ts";
import type { Locale } from "../i18n/index.ts";
import { messages as messageCatalog } from "../i18n/index.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConstitutionAnswers = {
  description: string;
  principles: string[];
};

export type ConstitutionWizardMessages = {
  descriptionPrompt: string;
  principlesPrompt: string;
};

export type PlanConstitutionOptions = {
  cwd: string;
  locale: Locale;
  force: boolean;
  prompter?: Prompter;
};

export type PlanConstitutionResult = {
  path: string;
  skipped: boolean;
};

// ---------------------------------------------------------------------------
// Content generation
// ---------------------------------------------------------------------------

export function generateConstitutionMd(answers: ConstitutionAnswers, locale: Locale): string {
  const t = messageCatalog[locale].templates.constitution;
  const description = answers.description.length > 0 ? answers.description : t.description;
  const principles = answers.principles.length > 0 ? answers.principles : [...t.principles];

  return [
    `# Project Constitution`,
    ``,
    description,
    ``,
    `## ${t.corePrinciplesHeader}`,
    ``,
    ...principles.map((p) => `- ${p}`),
    ``,
    `> ${t.editHint}`,
  ].join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Wizard — collect answers
// ---------------------------------------------------------------------------

export async function runConstitutionWizard(
  prompter: Prompter,
  t: ConstitutionWizardMessages,
): Promise<ConstitutionAnswers> {
  const descriptionRaw = await prompter.ask(t.descriptionPrompt);
  const principlesRaw = await prompter.ask(t.principlesPrompt);
  const principles = principlesRaw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return { description: descriptionRaw.trim(), principles };
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

export async function runPlanConstitution(
  opts: PlanConstitutionOptions,
): Promise<PlanConstitutionResult> {
  const { cwd, locale, force } = opts;
  const constitutionPath = join(cwd, "design", "constitution.md");

  if (!force) {
    try {
      await readFile(constitutionPath);
      return { path: constitutionPath, skipped: true };
    } catch {
      // file doesn't exist — proceed
    }
  }

  const prompter = opts.prompter ?? Prompter.fromIO();
  const ownsPrompter = opts.prompter === undefined;

  try {
    const answers = await runConstitutionWizard(
      prompter,
      messageCatalog[locale].wizard.constitution,
    );
    const content = generateConstitutionMd(answers, locale);
    await mkdir(dirname(constitutionPath), { recursive: true });
    await atomicWriteText(constitutionPath, content);
    return { path: constitutionPath, skipped: false };
  } finally {
    if (ownsPrompter) prompter.close();
  }
}
