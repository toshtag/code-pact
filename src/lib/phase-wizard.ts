import { Prompter } from "./prompt.ts";
import type { Confidence, Risk } from "../core/services/createPhase.ts";

export type PhaseWizardMessages = {
  idPrompt: string;
  namePrompt: string;
  weightPrompt: string;
  weightHint: string;
  objectivePrompt: string;
  confidencePrompt: string;
  confidenceHint: string;
  riskPrompt: string;
  riskHint: string;
  verifyCommandPrompt: string;
  doneCriterionPrompt: string;
};

export type PhaseWizardInput = {
  id: string;
  name: string;
  weight: number;
  objective: string;
  confidence: Confidence;
  risk: Risk;
  verifyCommands: string[];
  doneCriteria: string[];
};

const CONFIDENCE_CHOICES: Confidence[] = ["low", "medium", "high"];
const RISK_CHOICES: Risk[] = ["low", "medium", "high"];

function parseCommaList(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function askRequired(prompter: Prompter, question: string): Promise<string> {
  for (;;) {
    const raw = await prompter.ask(question);
    if (raw.length > 0) return raw;
  }
}

/**
 * Collects all fields needed to create a phase via interactive prompts.
 * Shared by `phase new` and the wizard fallback in `phase add`.
 */
export async function runPhaseWizard(
  prompter: Prompter,
  m: PhaseWizardMessages,
  initialName?: string,
): Promise<PhaseWizardInput> {
  const id = await askRequired(prompter, m.idPrompt);
  const name = initialName ?? (await askRequired(prompter, m.namePrompt));

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
  const verifyCommands = verifyRaw.length > 0 ? parseCommaList(verifyRaw) : ["pnpm test"];

  const doneRaw = await prompter.ask(`${m.doneCriterionPrompt} [All tasks are done]`);
  const doneCriteria = doneRaw.length > 0 ? parseCommaList(doneRaw) : ["All tasks are done"];

  return { id, name, weight, objective, confidence, risk, verifyCommands, doneCriteria };
}
