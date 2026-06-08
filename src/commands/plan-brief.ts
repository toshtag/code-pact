import { readFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { atomicWriteText } from "../io/atomic-text.ts";
import { Prompter } from "../lib/prompt.ts";
import { assertSafeRelativePath } from "../core/path-safety.ts";
import type { Locale } from "../i18n/index.ts";
import { messages as messageCatalog } from "../i18n/index.ts";
import type {
  PlanCaptureFileDetail,
  PlanCaptureStdinDetail,
  PlanCaptureParseDetail,
} from "../contracts/plan-capture-details.ts";

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
   * Pre-collected answers (e.g. from `--from-file`).
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
// File-driven input schema
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

export class PlanBriefFromFileError extends Error {
  readonly code = "CONFIG_ERROR";
  readonly detail: PlanCaptureFileDetail;
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

  return parseBriefSource(raw, "--from-file", relPath, (detail, message) => {
    throw new PlanBriefFromFileError(detail, relPath, message);
  });
}

// ---------------------------------------------------------------------------
// Stdin-driven input
// ---------------------------------------------------------------------------

export class PlanBriefFromStdinError extends Error {
  readonly code = "CONFIG_ERROR";
  readonly detail: PlanCaptureStdinDetail;

  constructor(
    detail: PlanBriefFromStdinError["detail"],
    message: string,
  ) {
    super(message);
    this.name = "PlanBriefFromStdinError";
    this.detail = detail;
  }
}

/**
 * Reads YAML from a Node.js readable stream (typically
 * `process.stdin`) and validates it against `BriefFileSchema`.
 * Returns a `BriefAnswers` record ready to feed into
 * `runPlanBrief({ answers })`.
 *
 * Throws `PlanBriefFromStdinError` on read / parse / schema
 * failures. Never logs, never writes.
 *
 * The stream is consumed via async iteration so back-pressure
 * works correctly on large pipes. Reading is uncapped — the
 * caller is expected to provide a reasonably sized input
 * (briefs are O(KB), not O(MB)).
 */
export async function loadBriefFromStdin(
  stdin: NodeJS.ReadableStream,
): Promise<BriefAnswers> {
  let raw: string;
  try {
    const chunks: string[] = [];
    for await (const chunk of stdin) {
      chunks.push(
        typeof chunk === "string" ? chunk : chunk.toString("utf8"),
      );
    }
    raw = chunks.join("");
  } catch (err) {
    throw new PlanBriefFromStdinError(
      "stdin_read_failed",
      `plan brief --stdin: failed to read from stdin: ${(err as Error).message}`,
    );
  }

  return parseBriefSource(raw, "--stdin", "<stdin>", (detail, message) => {
    // PlanBriefFromFileError carries an `unsafe_path` / `unreadable`
    // detail that doesn't apply here, so map only the YAML / schema
    // failures onto the stdin error class.
    if (detail === "invalid_yaml" || detail === "schema_invalid") {
      throw new PlanBriefFromStdinError(detail, message);
    }
    // Defensive: `parseBriefSource` only ever returns these two
    // detail kinds, but keep an explicit fallback so future
    // additions to the parser fail loudly here instead of silently.
    throw new PlanBriefFromStdinError(
      "stdin_read_failed",
      `plan brief --stdin: unexpected parser detail "${detail}": ${message}`,
    );
  });
}

// ---------------------------------------------------------------------------
// Shared YAML + schema parser used by file and stdin paths
// ---------------------------------------------------------------------------

// The two details shared by both modes (the parse/validate failures).
type ParserDetail = PlanCaptureParseDetail;

function parseBriefSource(
  raw: string,
  flagLabel: string,
  sourceLabel: string,
  throwError: (detail: ParserDetail, message: string) => never,
): BriefAnswers {
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throwError(
      "invalid_yaml",
      `plan brief ${flagLabel}: "${sourceLabel}" is not valid YAML: ${(err as Error).message}`,
    );
  }

  const result = BriefFileSchema.safeParse(parsed);
  if (!result.success) {
    const summary = result.error.issues
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ");
    throwError(
      "schema_invalid",
      `plan brief ${flagLabel}: "${sourceLabel}" does not match the brief schema: ${summary}`,
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
    // Pre-collected answers bypass the wizard entirely.
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
