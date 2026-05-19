import { readFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { atomicWriteText } from "../io/atomic-text.ts";
import { Prompter } from "../lib/prompt.ts";
import type { Locale } from "../i18n/index.ts";
import { messages as messageCatalog } from "../i18n/index.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BriefAnswers = {
  what: string;
  who: string;
  differentiator: string;
};

export type PlanBriefOptions = {
  cwd: string;
  locale: Locale;
  force: boolean;
  prompter?: Prompter;
};

export type PlanBriefResult = {
  path: string;
  skipped: boolean;
};

// ---------------------------------------------------------------------------
// Content generation
// ---------------------------------------------------------------------------

export function generateBriefMd(answers: BriefAnswers, locale: Locale): string {
  const t = messageCatalog[locale].templates.brief;
  const diff =
    answers.differentiator.length > 0 ? answers.differentiator : t.differentiatorPlaceholder;

  return [
    `# ${t.header}`,
    ``,
    `## ${t.whatHeader}`,
    ``,
    answers.what,
    ``,
    `## ${t.whoHeader}`,
    ``,
    answers.who,
    ``,
    `## ${t.differentiatorHeader}`,
    ``,
    diff,
    ``,
    `---`,
    ``,
    t.footer,
  ].join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Wizard — collect answers (reusable from init-wizard)
// ---------------------------------------------------------------------------

export type BriefWizardMessages = {
  collectBriefPrompt: string;
  whatPrompt: string;
  whoPrompt: string;
  differentiatorPrompt: string;
};

export async function runBriefWizard(
  prompter: Prompter,
  t: BriefWizardMessages,
): Promise<BriefAnswers> {
  const what = await prompter.ask(t.whatPrompt);
  const who = await prompter.ask(t.whoPrompt);
  const differentiator = await prompter.ask(t.differentiatorPrompt);
  return { what, who, differentiator };
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

export async function runPlanBrief(opts: PlanBriefOptions): Promise<PlanBriefResult> {
  const { cwd, locale, force } = opts;
  const briefPath = join(cwd, "design", "brief.md");

  if (!force) {
    try {
      await readFile(briefPath);
      return { path: briefPath, skipped: true };
    } catch {
      // file doesn't exist — proceed
    }
  }

  const prompter = opts.prompter ?? Prompter.fromIO();
  const ownsPrompter = opts.prompter === undefined;

  try {
    const answers = await runBriefWizard(
      prompter,
      messageCatalog[locale].wizard.brief,
    );
    const content = generateBriefMd(answers, locale);
    await mkdir(dirname(briefPath), { recursive: true });
    await atomicWriteText(briefPath, content);
    return { path: briefPath, skipped: false };
  } finally {
    if (ownsPrompter) prompter.close();
  }
}
