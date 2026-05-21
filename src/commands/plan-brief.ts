import { readFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { atomicWriteText } from "../io/atomic-text.ts";
import { Prompter } from "../lib/prompt.ts";
import { assertSafeRelativePath } from "../core/path-safety.ts";
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
  /**
   * Pre-collected answers (e.g. from `--from-file` in v1.6 P17-T1).
   * When provided, the wizard is bypassed entirely. Mutually
   * exclusive with `prompter`-driven flows: if both are present,
   * `answers` wins and the wizard never runs.
   */
  answers?: BriefAnswers;
};

export type PlanBriefResult = {
  path: string;
  skipped: boolean;
};

// ---------------------------------------------------------------------------
// File-driven input schema — v1.6 P17-T1
// ---------------------------------------------------------------------------

/**
 * YAML schema accepted by `plan brief --from-file <path>`. Mirrors
 * the three fields the TTY wizard collects. `differentiator` is
 * optional to match the wizard's empty-input behaviour (an empty
 * value triggers the locale-specific placeholder in
 * `generateBriefMd`).
 *
 * `.strict()` rejects unknown keys so typos surface as a
 * CONFIG_ERROR instead of being silently dropped.
 */
export const BriefFileSchema = z
  .object({
    what: z.string().min(1, "`what` must be a non-empty string"),
    who: z.string().min(1, "`who` must be a non-empty string"),
    differentiator: z.string().default(""),
  })
  .strict();

export type BriefFileInput = z.infer<typeof BriefFileSchema>;

export class PlanBriefFromFileError extends Error {
  readonly code = "CONFIG_ERROR";
  readonly detail:
    | "unsafe_path"
    | "unreadable"
    | "invalid_yaml"
    | "schema_invalid";
  readonly path: string;

  constructor(
    detail: PlanBriefFromFileError["detail"],
    path: string,
    message: string,
  ) {
    super(message);
    this.name = "PlanBriefFromFileError";
    this.detail = detail;
    this.path = path;
  }
}

/**
 * Loads a brief file from disk and validates it against
 * `BriefFileSchema`. Returns a fully-resolved `BriefAnswers`
 * record ready to feed into `runPlanBrief({ answers })`.
 *
 * Throws `PlanBriefFromFileError` (with structured `.detail`)
 * on any failure — never logs, never writes. The caller is
 * expected to map the error onto the CLI's CONFIG_ERROR
 * envelope.
 */
export async function loadBriefFromFile(
  cwd: string,
  relPath: string,
): Promise<BriefAnswers> {
  try {
    assertSafeRelativePath(relPath);
  } catch (err) {
    throw new PlanBriefFromFileError(
      "unsafe_path",
      relPath,
      `plan brief --from-file: path "${relPath}" is not a safe repo-root-relative path: ${(err as Error).message}`,
    );
  }

  const absPath = join(cwd, relPath);
  let raw: string;
  try {
    raw = await readFile(absPath, "utf8");
  } catch (err) {
    throw new PlanBriefFromFileError(
      "unreadable",
      relPath,
      `plan brief --from-file: cannot read "${relPath}": ${(err as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new PlanBriefFromFileError(
      "invalid_yaml",
      relPath,
      `plan brief --from-file: "${relPath}" is not valid YAML: ${(err as Error).message}`,
    );
  }

  const result = BriefFileSchema.safeParse(parsed);
  if (!result.success) {
    const summary = result.error.issues
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ");
    throw new PlanBriefFromFileError(
      "schema_invalid",
      relPath,
      `plan brief --from-file: "${relPath}" does not match the brief schema: ${summary}`,
    );
  }

  return {
    what: result.data.what,
    who: result.data.who,
    differentiator: result.data.differentiator,
  };
}

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

  let answers: BriefAnswers;
  let cleanupPrompter: (() => void) | undefined;
  if (opts.answers !== undefined) {
    // v1.6 P17-T1: pre-collected answers bypass the wizard entirely.
    // Caller (e.g. `--from-file`) owns input validation.
    answers = opts.answers;
  } else {
    const prompter = opts.prompter ?? Prompter.fromIO();
    if (opts.prompter === undefined) cleanupPrompter = () => prompter.close();
    answers = await runBriefWizard(
      prompter,
      messageCatalog[locale].wizard.brief,
    );
  }

  try {
    const content = generateBriefMd(answers, locale);
    await mkdir(dirname(briefPath), { recursive: true });
    await atomicWriteText(briefPath, content);
    return { path: briefPath, skipped: false };
  } finally {
    cleanupPrompter?.();
  }
}
