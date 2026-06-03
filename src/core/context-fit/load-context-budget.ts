// P47 (Context Fit, layer a). Loads an agent profile's optional
// `context_budget` block at the CLI boundary so `--context-budget <profile>`
// can resolve a CUSTOM profile name (standard names resolve agent-less and do
// not need this). Mirrors the agent-resolution order the task runners already
// use: explicit --agent, else project.yaml's default_agent.
//
// A malformed, explicitly-configured `context_budget` surfaces as CONFIG_ERROR
// (AgentProfile.parse throws) rather than being silently ignored. A missing
// `context_budget` block returns `undefined` — a valid, no-override state.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { Project } from "../schemas/project.ts";
import {
  AgentProfile,
  type ContextBudgetProfiles,
} from "../schemas/agent-profile.ts";
import { resolveAgentProfilePath } from "../agent-profile-path.ts";

export type LoadAgentContextBudgetResult = {
  /** The resolved agent name (explicit, else project default_agent). */
  agentName: string;
  /** The agent profile's `context_budget` block, or undefined when absent. */
  contextBudget: ContextBudgetProfiles | undefined;
};

/**
 * Resolves the agent and returns its `context_budget` block (or undefined).
 *
 * Throws the same `code`-tagged errors the runners do — `AGENT_NOT_FOUND`,
 * `AGENT_NOT_ENABLED` (so a custom profile cannot be resolved against a
 * disabled agent), and `CONFIG_ERROR` (an unparseable/invalid profile) — so
 * the calling command's existing error switch handles them unchanged.
 */
export async function loadAgentContextBudget(
  cwd: string,
  agent: string | undefined,
): Promise<LoadAgentContextBudgetResult> {
  const raw = await readFile(join(cwd, ".code-pact", "project.yaml"), "utf8");
  const project = Project.parse(parseYaml(raw) as unknown);
  const agentName = agent ?? project.default_agent;

  const ref = project.agents.find((a) => a.name === agentName);
  if (!ref) {
    const err = new Error(`Agent "${agentName}" is not configured in project.yaml.`);
    (err as NodeJS.ErrnoException).code = "AGENT_NOT_FOUND";
    throw err;
  }
  if (ref.enabled === false) {
    const err = new Error(
      `Agent "${agentName}" is disabled in project.yaml (enabled: false).`,
    );
    (err as NodeJS.ErrnoException).code = "AGENT_NOT_ENABLED";
    throw err;
  }

  const path = await resolveAgentProfilePath(cwd, agentName);
  let profileRaw: string;
  try {
    profileRaw = await readFile(path, "utf8");
  } catch {
    const err = new Error(`Agent profile for "${agentName}" not found.`);
    (err as NodeJS.ErrnoException).code = "AGENT_NOT_FOUND";
    throw err;
  }
  // A malformed, explicitly-configured context_budget (or any other invalid
  // field) surfaces as CONFIG_ERROR rather than an unhandled ZodError — the
  // CLI error switch already renders CONFIG_ERROR as a clean envelope.
  let parsed;
  try {
    parsed = AgentProfile.parse(parseYaml(profileRaw) as unknown);
  } catch (cause) {
    const err = new Error(
      `Agent profile for "${agentName}" is invalid: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    (err as NodeJS.ErrnoException).code = "CONFIG_ERROR";
    throw err;
  }
  return { agentName, contextBudget: parsed.context_budget };
}
