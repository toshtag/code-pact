// P47 (Context Fit, layer a). Loads an agent profile's optional
// `context_budget` block at the CLI boundary so `--context-budget <profile>`
// can resolve a profile name. Mirrors the agent-resolution order the task
// runners use: explicit --agent, else project.yaml's default_agent.
//
// Two modes, matching the RFC's agent-less-resolution contract for STANDARD
// names (tight/balanced/wide) versus CUSTOM names:
//
//   bestEffort: false (custom name) — the agent profile MUST be loadable. A
//     missing project.yaml / unconfigured-or-disabled agent / missing profile
//     file is fatal (AGENT_NOT_FOUND / AGENT_NOT_ENABLED); a malformed profile
//     is CONFIG_ERROR. This is the path that resolves a custom profile, which
//     only exists inside an agent profile.
//
//   bestEffort: true (standard name) — the agent profile is consulted ONLY to
//     pick up an OVERRIDE; its absence must never make a built-in fallback
//     fail. A missing project.yaml, unconfigured/disabled agent, or missing
//     profile file resolves to `undefined` (no override → built-in fallback
//     applies). The ONE thing that is still fatal is an agent profile that
//     EXPLICITLY declares a `context_budget` block which is itself invalid:
//     silently ignoring a broken, intentionally-configured block would hide a
//     real misconfiguration. To avoid letting an unrelated bad field in the
//     profile sink a built-in fallback, this mode validates ONLY the
//     `context_budget` key in isolation, not the whole AgentProfile.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { Project } from "../schemas/project.ts";
import {
  AgentProfile,
  ContextBudgetProfiles,
  type ContextBudgetProfiles as ContextBudgetProfilesType,
} from "../schemas/agent-profile.ts";
import { resolveAgentProfilePath } from "../agent-profile-path.ts";

export type LoadAgentContextBudgetResult = {
  /** The resolved agent name (explicit, else project default_agent). */
  agentName: string;
  /** The agent profile's `context_budget` block, or undefined when absent. */
  contextBudget: ContextBudgetProfilesType | undefined;
};

function configError(message: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = "CONFIG_ERROR";
  return err;
}

/**
 * Strict load (custom-profile path). Resolves the agent and returns its
 * `context_budget` block (or undefined). Throws the same `code`-tagged errors
 * the runners do — `AGENT_NOT_FOUND`, `AGENT_NOT_ENABLED`, `CONFIG_ERROR` — so
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
  // field) surfaces as CONFIG_ERROR rather than an unhandled ZodError.
  let parsed;
  try {
    parsed = AgentProfile.parse(parseYaml(profileRaw) as unknown);
  } catch (cause) {
    throw configError(
      `Agent profile for "${agentName}" is invalid: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
  return { agentName, contextBudget: parsed.context_budget };
}

/**
 * Best-effort load (standard-profile path). Returns an OVERRIDE
 * `context_budget` block when one is available, or `undefined` so the built-in
 * fallback applies. Never fails on a missing/unconfigured/disabled agent or a
 * missing profile file. The only fatal case is an agent profile that
 * explicitly declares a `context_budget` block that does not validate — that
 * is CONFIG_ERROR (a real, intentional misconfiguration), checked in isolation
 * so an unrelated bad field never sinks a built-in fallback.
 */
export async function loadAgentContextBudgetBestEffort(
  cwd: string,
  agent: string | undefined,
): Promise<ContextBudgetProfilesType | undefined> {
  // project.yaml unreadable/absent → no override (built-in fallback applies).
  let projectRaw: string;
  try {
    projectRaw = await readFile(join(cwd, ".code-pact", "project.yaml"), "utf8");
  } catch {
    return undefined;
  }
  let project;
  try {
    project = Project.parse(parseYaml(projectRaw) as unknown);
  } catch {
    return undefined;
  }
  const agentName = agent ?? project.default_agent;
  const ref = project.agents.find((a) => a.name === agentName);
  // Unconfigured or disabled agent → no override. (A standard name must not be
  // gated on an agent being present/enabled — that is the agent-less contract.)
  if (!ref || ref.enabled === false) return undefined;

  let path: string;
  try {
    path = await resolveAgentProfilePath(cwd, agentName);
  } catch {
    return undefined;
  }
  let profileRaw: string;
  try {
    profileRaw = await readFile(path, "utf8");
  } catch {
    return undefined; // missing profile file → fallback, never fatal.
  }
  let doc: unknown;
  try {
    doc = parseYaml(profileRaw) as unknown;
  } catch {
    // Unparseable YAML is not specifically a context_budget problem; do not
    // sink a built-in fallback over it.
    return undefined;
  }
  // Only the context_budget key matters here. Absent → no override.
  const block = (doc as { context_budget?: unknown } | null)?.context_budget;
  if (block === undefined || block === null) return undefined;
  // Present-but-invalid is a real, intentional misconfiguration → CONFIG_ERROR.
  const result = ContextBudgetProfiles.safeParse(block);
  if (!result.success) {
    throw configError(
      `Agent "${agentName}" has an invalid context_budget block: ${
        result.error.issues[0]?.message ?? "invalid context_budget"
      }`,
    );
  }
  return result.data;
}
