import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { RelativePosixPath } from "./schemas/relative-path.ts";
import { assertSafePlanId } from "./schemas/plan-id.ts";

// Single source of truth for where an agent's profile lives.
//
// `doctor` resolves the profile via the project's `agents[].profile` (a
// schema-validated project-relative path), but every other command historically
// hardcoded `agent-profiles/<name>.yaml`. For a project whose `agents[].profile`
// is non-default, that made doctor point at one file while `adapter upgrade`
// (and recommend / task prepare / pack / the model_version pin) read another.
// These helpers make all of them agree with doctor.
//
// Resolution honors `project.yaml`'s matching `agents[].profile`, falling back
// to the conventional `agent-profiles/<name>.yaml` (what `init` writes) when
// project.yaml is absent, the agent is not listed, or its profile is unusable.

/** The conventional profile path (relative to `.code-pact/`). */
function defaultProfileRel(agentName: string): string {
  return join("agent-profiles", `${agentName}.yaml`);
}

/**
 * Project-relative (under `.code-pact/`) profile path for `agentName`, honoring
 * `agents[].profile` from project.yaml when present. `agentName` is validated as
 * a safe plan id before it can become a path segment in the fallback.
 *
 * Reads only the matching agent's `profile` rather than full-parsing the whole
 * `Project` schema, so an unrelated invalid field elsewhere in project.yaml does
 * not silently redirect a custom profile back to the default. The resolved path
 * is still validated (`RelativePosixPath`: no `..`, no absolute, no backslash)
 * before use. Whole-file validity is `doctor` / `validate`'s concern — this
 * helper deliberately degrades to the convention rather than coupling every
 * command to it.
 */
export async function resolveAgentProfileRel(
  cwd: string,
  agentName: string,
): Promise<string> {
  assertSafePlanId(agentName, "Agent");
  let raw: string;
  try {
    raw = await readFile(join(cwd, ".code-pact", "project.yaml"), "utf8");
  } catch {
    return defaultProfileRel(agentName); // no project.yaml → convention
  }
  let doc: unknown;
  try {
    doc = parseYaml(raw) as unknown;
  } catch {
    return defaultProfileRel(agentName); // unparseable → convention
  }
  const agents = (doc as { agents?: unknown })?.agents;
  if (Array.isArray(agents)) {
    for (const a of agents) {
      if (a && typeof a === "object" && (a as { name?: unknown }).name === agentName) {
        const parsed = RelativePosixPath.safeParse((a as { profile?: unknown }).profile);
        if (parsed.success) return parsed.data;
        break; // matched the agent, but its profile is unusable → convention
      }
    }
  }
  return defaultProfileRel(agentName);
}

/** Absolute path form of {@link resolveAgentProfileRel}. */
export async function resolveAgentProfilePath(
  cwd: string,
  agentName: string,
): Promise<string> {
  return join(cwd, ".code-pact", await resolveAgentProfileRel(cwd, agentName));
}
