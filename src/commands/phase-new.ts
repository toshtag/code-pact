import { Prompter } from "../lib/prompt.ts";
import { runPhaseWizard } from "../lib/phase-wizard.ts";
import { messages as messageCatalog, type Locale } from "../i18n/index.ts";
import { createPhase, type CreatePhaseResult } from "../core/services/createPhase.ts";

export type PhaseNewOptions = {
  cwd: string;
  locale: Locale;
  /** Optional starting name (CLI positional). When set, the name prompt is skipped. */
  initialName?: string;
  /** Optional pre-built prompter (for tests). Defaults to stdin/stderr. */
  prompter?: Prompter;
};

export async function runPhaseNew(opts: PhaseNewOptions): Promise<CreatePhaseResult> {
  const prompter = opts.prompter ?? Prompter.fromIO();
  const ownsPrompter = opts.prompter === undefined;
  const m = messageCatalog[opts.locale].wizard.phase;

  try {
    const input = await runPhaseWizard(prompter, m, opts.initialName);
    return await createPhase({ cwd: opts.cwd, ...input });
  } finally {
    if (ownsPrompter) prompter.close();
  }
}
