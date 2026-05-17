import { Prompter } from "../lib/prompt.ts";
import { messages as messageCatalog, type Locale } from "../i18n/index.ts";
import { SUPPORTED_AGENTS, type SupportedAgent } from "../core/agents.ts";
import type { LocaleCode } from "../core/schemas/locale.ts";
import { runInitCore, type InitCoreOptions, type InitResult } from "./init.ts";
import { runGenerateAdapter } from "./adapter.ts";

export type InitWizardOptions = {
  cwd: string;
  force: boolean;
  json: boolean;
  /** Optional pre-built prompter (for tests). Defaults to stdin/stderr. */
  prompter?: Prompter;
};

const LOCALE_BY_INDEX: readonly Locale[] = ["en-US", "ja-JP"];

const AGENT_LABELS: Record<SupportedAgent, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  generic: "Generic",
  cursor: "Cursor (experimental, v0.2)",
  "gemini-cli": "Gemini CLI (experimental, v0.2)",
};

export async function runInitWizard(opts: InitWizardOptions): Promise<InitResult> {
  const prompter = opts.prompter ?? Prompter.fromIO();
  const ownsPrompter = opts.prompter === undefined;

  try {
    // 1. Locale — always bilingual, prompts read from the en-US catalog
    //    since the user has not picked a language yet.
    const localeMessages = messageCatalog["en-US"].wizard.init;
    const localeIdx = await prompter.askChoice(localeMessages.localePrompt, [
      localeMessages.localeOptionEn,
      localeMessages.localeOptionJa,
    ]);
    const locale: Locale = LOCALE_BY_INDEX[localeIdx]!;
    const m = messageCatalog[locale].wizard.init;

    // 2. Agents — multi-select. At least one is required.
    const agentChoices = SUPPORTED_AGENTS.map((a) => AGENT_LABELS[a]);
    const agentIndexes = await prompter.askMulti(m.agentsPrompt, agentChoices, 1);
    const agents: SupportedAgent[] = agentIndexes.map((i) => SUPPORTED_AGENTS[i]!);

    // 3. default_agent — only asked when more than one agent was picked.
    let defaultAgent: SupportedAgent = agents[0]!;
    if (agents.length > 1) {
      const labels = agents.map((a) => AGENT_LABELS[a]);
      const idx = await prompter.askChoice(m.defaultAgentPrompt, labels);
      defaultAgent = agents[idx]!;
    }

    // 4. Adapter generation — yes/no. Connected in Phase 4 once the
    //    adapter registry covers every supported agent.
    const generateAdapters = await prompter.askYesNo(m.generateAdaptersPrompt, true);

    // 5. Verification command — Enter accepts the default.
    const defaultVerify = "pnpm test";
    const verifyPrompt = `${m.verifyCommandPrompt} [${defaultVerify}] (${m.verifyCommandHint})`;
    const verifyRaw = await prompter.ask(verifyPrompt);
    const verifyCommand = verifyRaw.length > 0 ? verifyRaw : defaultVerify;

    // 6. Sample phase — yes/no.
    const createSamplePhase = await prompter.askYesNo(m.createSamplePrompt, true);

    const coreOpts: InitCoreOptions = {
      cwd: opts.cwd,
      locale: locale as LocaleCode,
      agents,
      defaultAgent,
      verifyCommand,
      createSamplePhase,
      force: opts.force,
      json: opts.json,
    };

    const result = await runInitCore(coreOpts);

    if (generateAdapters) {
      for (const agent of agents) {
        const adapterResult = await runGenerateAdapter({
          cwd: opts.cwd,
          agentName: agent,
          force: opts.force,
          locale,
        });
        result.created.push(...adapterResult.created);
        result.skipped.push(...adapterResult.skipped);
      }
    }

    const ns = messageCatalog[locale].wizard.init;
    process.stderr.write(
      `\n${ns.nextStepsHeader}\n  ${ns.nextStep1}\n  ${ns.nextStep2}\n  ${ns.nextStep3}\n`,
    );

    return result;
  } finally {
    if (ownsPrompter) prompter.close();
  }
}
