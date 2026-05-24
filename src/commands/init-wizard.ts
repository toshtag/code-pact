import { join } from "node:path";
import { atomicWriteText } from "../io/atomic-text.ts";
import { Prompter } from "../lib/prompt.ts";
import { messages as messageCatalog, type Locale } from "../i18n/index.ts";
import { SUPPORTED_AGENTS, type SupportedAgent } from "../core/agents.ts";
import type { LocaleCode } from "../core/schemas/locale.ts";
import { runInitCore, type InitCoreOptions, type InitResult } from "./init.ts";
import { runGenerateAdapter } from "./adapter.ts";
import { runBriefWizard, generateBriefMd } from "./plan-brief.ts";

export type InitWizardOptions = {
  cwd: string;
  force: boolean;
  json: boolean;
  /**
   * When true, the wizard skips the "create sample phase?" prompt and
   * forces creation. Passed from the CLI when `--sample-phase` was set.
   * P13+.
   */
  samplePhaseOverride?: boolean;
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

    // 5. Verification command — preset select so the common case needs only
    //    arrow keys + Enter. The last option drops to free-text for anything
    //    not covered by the presets.
    const defaultVerify = "pnpm test";
    const verifyPresets = [defaultVerify, "npm test", "yarn test"] as const;
    const verifyIdx = await prompter.askChoice(m.verifyCommandPrompt, [
      ...verifyPresets,
      m.verifyCustomOption,
    ]);
    let verifyCommand: string;
    if (verifyIdx < verifyPresets.length) {
      verifyCommand = verifyPresets[verifyIdx]!;
    } else {
      const verifyRaw = await prompter.ask(m.verifyCommandPrompt);
      verifyCommand = verifyRaw.length > 0 ? verifyRaw : defaultVerify;
    }

    // 6. Sample phase — yes/no. When the CLI passed `--sample-phase`,
    //    the wizard skips this prompt and forces creation (per the
    //    P13 RFC's generation-policy table).
    const createSamplePhase =
      opts.samplePhaseOverride === true
        ? true
        : await prompter.askYesNo(m.createSamplePrompt, true);

    // 7. Project brief — optional, yes by default. Questions are collected
    //    upfront (before any file operations) so the wizard feels linear.
    const mb = messageCatalog[locale].wizard.brief;
    const collectBrief = await prompter.askYesNo(mb.collectBriefPrompt, true);
    let briefAnswers: Awaited<ReturnType<typeof runBriefWizard>> | null = null;
    if (collectBrief) {
      briefAnswers = await runBriefWizard(prompter, mb);
    }

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

    // Write brief if answers were collected.
    if (briefAnswers) {
      const briefPath = join(opts.cwd, "design", "brief.md");
      await atomicWriteText(briefPath, generateBriefMd(briefAnswers, locale));
      result.created.push(briefPath);
    }

    const ns = messageCatalog[locale].wizard.init;
    prompter.write(
      `\n${ns.nextStepsHeader}\n  ${ns.nextStep1}\n  ${ns.nextStep2}\n  ${ns.nextStep3}\n`,
    );

    return result;
  } finally {
    if (ownsPrompter) prompter.close();
  }
}
