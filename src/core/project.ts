// Shared loader + agent resolution for `.code-pact/project.yaml`, used by the
// task runners and the context-budget loader. Centralizing it keeps the
// agent-resolution contract (codes, messages, precedence) defined in one place;
// the per-function doc below is the contract of record.

import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { Project } from "./schemas/project.ts";
import { resolveProjectConfigPath } from "./project-config-path.ts";

/** Load and validate `.code-pact/project.yaml`. */
export async function loadProject(cwd: string): Promise<Project> {
  let path: string;
  let raw: string;
  try {
    path = await resolveProjectConfigPath(cwd);
    raw = await readFile(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const detail =
      code === "ENOENT"
        ? ".code-pact/project.yaml is missing"
        : (err as Error).message;
    const e = new Error(`Cannot read .code-pact/project.yaml: ${detail}.`);
    (e as NodeJS.ErrnoException).code = "CONFIG_ERROR";
    throw e;
  }
  try {
    return Project.parse(parseYaml(raw) as unknown);
  } catch (err) {
    const e = new Error(
      `Cannot parse or validate .code-pact/project.yaml: ${(err as Error).message}`,
    );
    (e as NodeJS.ErrnoException).code = "CONFIG_ERROR";
    throw e;
  }
}

/**
 * Resolve the effective agent name — the explicit `--agent` value when given,
 * otherwise `project.default_agent` — and assert it is configured and enabled.
 *
 * This is a CONTRACT surface shared by every task runner:
 * - an agent name absent from `project.agents` throws `AGENT_NOT_FOUND`
 * - an agent with `enabled: false` throws `AGENT_NOT_ENABLED`
 *
 * Both error messages and `.code` values are byte-compatible with the inline
 * resolution blocks this replaces; the CLI layer maps the codes to envelopes.
 */
export function resolveEnabledAgent(
  project: Project,
  explicitAgent?: string,
): string {
  const agentName = explicitAgent ?? project.default_agent;
  const ref = project.agents.find(a => a.name === agentName);
  if (!ref) {
    const err = new Error(
      `Agent "${agentName}" is not configured in project.yaml.`,
    );
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
  return agentName;
}
