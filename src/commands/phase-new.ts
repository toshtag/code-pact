import { Prompter } from "../lib/prompt.ts";
import { messages as messageCatalog, type Locale } from "../i18n/index.ts";
import {
  createPhase,
  type Confidence,
  type CreatePhaseResult,
  type Risk,
} from "../core/services/createPhase.ts";

export type PhaseNewOptions = {
  cwd: string;
  locale: Locale;
  /** Optional starting name (CLI positional). When set, the name prompt is skipped. */
  initialName?: string;
  /** Optional pre-built prompter (for tests). Defaults to stdin/stderr. */
  prompter?: Prompter;
};

const CONFIDENCE_CHOICES: Confidence[] = ["low", "medium", "high"];
const RISK_CHOICES: Risk[] = ["low", "medium", "high"];

function parseCommaList(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export async function runPhaseNew(opts: PhaseNewOptions): Promise<CreatePhaseResult> {
  const prompter = opts.prompter ?? Prompter.fromIO();
  const ownsPrompter = opts.prompter === undefined;
  const m = messageCatalog[opts.locale].wizard.phase;

  try {
    // Required fields. The wizard re-prompts until a non-empty answer comes
    // in for fields with no sensible default (id, name, weight, objective).
    const id = await askRequired(prompter, m.idPrompt);
    const name = opts.initialName ?? (await askRequired(prompter, m.namePrompt));

    let weight = NaN;
    while (!Number.isFinite(weight) || weight <= 0 || weight > 100) {
      const raw = await prompter.ask(`${m.weightPrompt} [10]${m.weightHint}`);
      if (raw.length === 0) {
        weight = 10;
      } else {
        weight = Number(raw);
      }
    }

    const objective = await askRequired(prompter, m.objectivePrompt);

    prompter.write(`${m.confidenceHint}\n`);
    const confidenceIdx = await prompter.askChoice(m.confidencePrompt, CONFIDENCE_CHOICES);
    const confidence = CONFIDENCE_CHOICES[confidenceIdx]!;

    prompter.write(`${m.riskHint}\n`);
    const riskIdx = await prompter.askChoice(m.riskPrompt, RISK_CHOICES);
    const risk = RISK_CHOICES[riskIdx]!;

    const verifyRaw = await prompter.ask(`${m.verifyCommandPrompt} [pnpm test]`);
    const verifyCommands =
      verifyRaw.length > 0 ? parseCommaList(verifyRaw) : ["pnpm test"];

    const doneRaw = await prompter.ask(`${m.doneCriterionPrompt} [All tasks are done]`);
    const doneCriteria =
      doneRaw.length > 0 ? parseCommaList(doneRaw) : ["All tasks are done"];

    return await createPhase({
      cwd: opts.cwd,
      id,
      name,
      weight,
      objective,
      confidence,
      risk,
      verifyCommands,
      doneCriteria,
    });
  } finally {
    if (ownsPrompter) prompter.close();
  }
}

async function askRequired(prompter: Prompter, question: string): Promise<string> {
  for (;;) {
    const raw = await prompter.ask(question);
    if (raw.length > 0) return raw;
  }
}
