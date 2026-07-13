// Shared markdown sections for the per-agent instruction templates
// (claude / codex / generic / cursor / gemini-cli). Each `render*` returns the
// section's lines (no surrounding blank lines — callers join sections with a
// blank line between them). Centralizing them keeps the wording from drifting
// apart when the agent contract changes across adapters.
//
// CONTRACT: the `## Agent contract` heading and its three `###` axis headings
// are English-locked and matched by
// the adapter-conformance / adapter-doctor drift checks — they must not be
// translated or reworded here.

import type { AgentProfile } from "../schemas/agent-profile.ts";
import type { ModelProfile, ModelTier } from "../schemas/model-profile.ts";
import type { Locale } from "../../i18n/index.ts";
import { messages as messageCatalog } from "../../i18n/index.ts";

type AdapterCommon = (typeof messageCatalog)[Locale]["templates"]["adapterCommon"];

/** The localized `adapterCommon` template bundle for a locale. */
export function adapterCommon(locale: Locale): AdapterCommon {
  return messageCatalog[locale].templates.adapterCommon;
}

/**
 * The `## <workflow>` section: the numbered task-lifecycle steps and the
 * verify/validate/pack notes. `agent` is interpolated into the `--agent <name>`
 * command examples. `step0` prepends the `task prepare` lifecycle-entry step;
 * `validateNote` includes the validate note (omitted by the rules-file adapters
 * whose flow has no validate step).
 */
export function renderWorkflowSection(
  t: AdapterCommon,
  agent: string,
  opts: { step0: boolean; validateNote: boolean },
): string[] {
  const lines = [`## ${t.workflowHeader}`, ``];
  if (opts.step0) {
    lines.push(
      `0. ${t.step0}`,
      `   \`\`\`sh`,
      `   code-pact task prepare <task-id> --agent ${agent} --json`,
      `   \`\`\``,
      `   ${t.step0Detail}`,
      ``,
    );
  }
  lines.push(
    `1. ${t.step1}`,
    `   \`\`\`sh`,
    `   code-pact task context <task-id> --agent ${agent}`,
    `   \`\`\``,
    ``,
    `2. ${t.step2}`,
    ``,
    `3. ${t.step3}`,
    `   \`\`\`sh`,
    `   code-pact task complete <task-id> --agent ${agent}`,
    `   \`\`\``,
    `   ${t.step3FailDetail}`,
    `   ${t.step3IdempotentDetail}`,
    ``,
    `4. ${t.step4}`,
    ``,
    `> ${t.verifyNote}`,
    `>`,
  );
  if (opts.validateNote) {
    lines.push(`> ${t.validateNote}`, `>`);
  }
  lines.push(`> ${t.packNote}`);
  return lines;
}

/**
 * The `## Agent contract` section. Headings are English-locked (see file
 * header); body text is localized.
 */
export function renderAgentContractSection(t: AdapterCommon): string[] {
  return [
    `## ${t.agentContract.sectionHeader}`,
    ``,
    t.agentContract.intro,
    ``,
    `### ${t.agentContract.whenHeader}`,
    ``,
    t.agentContract.whenBody,
    ``,
    `### ${t.agentContract.verifyHeader}`,
    ``,
    t.agentContract.verifyBody,
    ``,
    `### ${t.agentContract.failHeader}`,
    ``,
    t.agentContract.failBody,
    ``,
    t.agentContract.repairBody,
  ];
}

/** The `## Context directory` section. */
export function renderContextDirectorySection(profile: AgentProfile): string[] {
  return [
    `## Context directory`,
    ``,
    `Context packs for this agent live under \`${profile.context_dir}/\`.`,
  ];
}

/** The `## <project conventions>` section. */
export function renderProjectConventionsSection(t: AdapterCommon): string[] {
  return [
    `## ${t.projectConventionsHeader}`,
    ``,
    `> ${t.projectConventionsHint}`,
    `> ${t.projectConventionsSource}`,
    ``,
    `- ${t.projectConventionsDefault}`,
  ];
}

/**
 * The `## Model selection` section (the tier → model/effort list). `thinking`
 * appends ` (thinking-capable)` to a tier that supports it — claude includes
 * it, codex does not; making it a parameter keeps that an explicit difference
 * rather than a silent drift.
 */
export function renderModelSelectionSection(
  modelProfiles: ModelProfile[],
  profile: AgentProfile,
  opts: { thinking: boolean },
): string[] {
  const tier = (name: string) => profile.model_map[name as ModelTier] ?? name;
  const tierList = modelProfiles
    .map((mp) => {
      const modelId = tier(mp.tier);
      const purposes = mp.purpose.join(", ");
      const efforts = mp.effort_levels.join(" | ");
      const thinking = opts.thinking && mp.supports_thinking ? " (thinking-capable)" : "";
      return `- **${mp.tier}** → \`${modelId}\`${thinking}\n  - Use for: ${purposes}\n  - Effort: ${efforts}`;
    })
    .join("\n");
  return [`## Model selection`, ``, tierList];
}
