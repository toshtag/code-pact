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
  /**
   * Pre-collected answers (v1.6 P17-T4: `--from-file`, `--stdin`, or
   * `--description` / `--principle` flag-driven). When provided, the
   * wizard is bypassed entirely. Mirrors the
   * `runPlanBrief({ answers })` contract.
   */
  answers?: ConstitutionAnswers;
};

export type PlanConstitutionResult = {
  path: string;
  skipped: boolean;
};

// ---------------------------------------------------------------------------
// File / stdin input schema — v1.6 P17-T4
// ---------------------------------------------------------------------------

/**
 * YAML schema accepted by `plan constitution --from-file <path>` and
 * `plan constitution --stdin`. Mirrors the two fields the TTY wizard
 * collects.
 *
 * Both fields are optional and default to empty so the locale-specific
 * fallback in `generateConstitutionMd` kicks in for empty values —
 * exactly matching the wizard's empty-input behaviour. `.strict()`
 * rejects unknown keys so typos surface as CONFIG_ERROR.
 */
export const ConstitutionFileSchema = z
  .object({
    description: z.string().default(""),
    principles: z.array(z.string()).default([]),
  })
  .strict();

export type ConstitutionFileInput = z.infer<typeof ConstitutionFileSchema>;

export class PlanConstitutionFromFileError extends Error {
  readonly code = "CONFIG_ERROR";
  readonly detail:
    | "unsafe_path"
    | "unreadable"
    | "invalid_yaml"
    | "schema_invalid";
  readonly path: string;

  constructor(
    detail: PlanConstitutionFromFileError["detail"],
    path: string,
    message: string,
  ) {
    super(message);
    this.name = "PlanConstitutionFromFileError";
    this.detail = detail;
    this.path = path;
  }
}

export class PlanConstitutionFromStdinError extends Error {
  readonly code = "CONFIG_ERROR";
  readonly detail:
    | "stdin_read_failed"
    | "invalid_yaml"
    | "schema_invalid";

  constructor(
    detail: PlanConstitutionFromStdinError["detail"],
    message: string,
  ) {
    super(message);
    this.name = "PlanConstitutionFromStdinError";
    this.detail = detail;
  }
}

/**
 * Loads a constitution file from disk and validates it against
 * `ConstitutionFileSchema`. Returns a fully-resolved
 * `ConstitutionAnswers` record ready to feed into
 * `runPlanConstitution({ answers })`.
 *
 * Throws `PlanConstitutionFromFileError` on any failure.
 */
export async function loadConstitutionFromFile(
  cwd: string,
  relPath: string,
): Promise<ConstitutionAnswers> {
  try {
    assertSafeRelativePath(relPath);
  } catch (err) {
    throw new PlanConstitutionFromFileError(
      "unsafe_path",
      relPath,
      `plan constitution --from-file: path "${relPath}" is not a safe repo-root-relative path: ${(err as Error).message}`,
    );
  }

  const absPath = join(cwd, relPath);
  let raw: string;
  try {
    raw = await readFile(absPath, "utf8");
  } catch (err) {
    throw new PlanConstitutionFromFileError(
      "unreadable",
      relPath,
      `plan constitution --from-file: cannot read "${relPath}": ${(err as Error).message}`,
    );
  }

  return parseConstitutionSource(raw, "--from-file", relPath, (detail, message) => {
    throw new PlanConstitutionFromFileError(detail, relPath, message);
  });
}

/**
 * Reads YAML from a Node.js readable stream (typically
 * `process.stdin`) and validates it against
 * `ConstitutionFileSchema`. Returns a `ConstitutionAnswers` record
 * ready to feed into `runPlanConstitution({ answers })`.
 *
 * Throws `PlanConstitutionFromStdinError` on any failure.
 */
export async function loadConstitutionFromStdin(
  stdin: NodeJS.ReadableStream,
): Promise<ConstitutionAnswers> {
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
    throw new PlanConstitutionFromStdinError(
      "stdin_read_failed",
      `plan constitution --stdin: failed to read from stdin: ${(err as Error).message}`,
    );
  }

  return parseConstitutionSource(raw, "--stdin", "<stdin>", (detail, message) => {
    if (detail === "invalid_yaml" || detail === "schema_invalid") {
      throw new PlanConstitutionFromStdinError(detail, message);
    }
    throw new PlanConstitutionFromStdinError(
      "stdin_read_failed",
      `plan constitution --stdin: unexpected parser detail "${detail}": ${message}`,
    );
  });
}

type ParserDetail = "invalid_yaml" | "schema_invalid";

function parseConstitutionSource(
  raw: string,
  flagLabel: string,
  sourceLabel: string,
  throwError: (detail: ParserDetail, message: string) => never,
): ConstitutionAnswers {
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throwError(
      "invalid_yaml",
      `plan constitution ${flagLabel}: "${sourceLabel}" is not valid YAML: ${(err as Error).message}`,
    );
  }

  // Treat `null` (empty document) as the empty object — the schema's
  // defaults then fill in. This makes `echo "" | plan constitution
  // --stdin` and `plan constitution --from-file empty.yaml` behave
  // identically to a `{}` input.
  const payload = parsed ?? {};
  const result = ConstitutionFileSchema.safeParse(payload);
  if (!result.success) {
    const summary = result.error.issues
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ");
    throwError(
      "schema_invalid",
      `plan constitution ${flagLabel}: "${sourceLabel}" does not match the constitution schema: ${summary}`,
    );
  }

  return {
    description: result.data.description,
    principles: result.data.principles,
  };
}

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

  let answers: ConstitutionAnswers;
  let cleanupPrompter: (() => void) | undefined;
  if (opts.answers !== undefined) {
    // v1.6 P17-T4: pre-collected answers bypass the wizard entirely.
    answers = opts.answers;
  } else {
    const prompter = opts.prompter ?? Prompter.fromIO();
    if (opts.prompter === undefined) cleanupPrompter = () => prompter.close();
    answers = await runConstitutionWizard(
      prompter,
      messageCatalog[locale].wizard.constitution,
    );
  }

  try {
    const content = generateConstitutionMd(answers, locale);
    await mkdir(dirname(constitutionPath), { recursive: true });
    await atomicWriteText(constitutionPath, content);
    return { path: constitutionPath, skipped: false };
  } finally {
    cleanupPrompter?.();
  }
}
