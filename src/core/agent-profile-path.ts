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
// project.yaml is absent or the agent is not listed. A matched agent whose
// `profile` is an invalid path fails with CONFIG_ERROR (it is not masked behind
// the default).

/** The conventional profile path (relative to `.code-pact/`), POSIX-separated. */
function defaultProfileRel(agentName: string): string {
  return `agent-profiles/${agentName}.yaml`;
}

/**
 * Project-relative (under `.code-pact/`) profile path for `agentName`, honoring
 * `agents[].profile` from project.yaml when present. `agentName` is validated as
 * a safe plan id before it can become a path segment in the fallback.
 *
 * Reads only the matching agent's `profile` rather than full-parsing the whole
 * `Project` schema, so an unrelated invalid field elsewhere in project.yaml does
 * not silently redirect a custom profile back to the default.
 *
 * Falls back to the convention when project.yaml is absent/unparseable or the
 * agent is not listed. But a matched agent whose `profile` is an *invalid* path
 * (e.g. `../../etc/x`) throws `CONFIG_ERROR` rather than falling back: the
 * project explicitly declared that path, so silently reading/writing a
 * different file would hide the misconfiguration. The resolved path is validated
 * (`RelativePosixPath`: no `..`, no absolute, no backslash) before use.
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
        // Matched the agent but its declared profile is an invalid path —
        // surface it instead of silently reading/writing the default file.
        const err = new Error(
          `Agent "${agentName}" has an invalid "profile" in .code-pact/project.yaml: ${parsed.error.issues[0]?.message ?? "invalid relative POSIX path"}`,
        );
        (err as NodeJS.ErrnoException).code = "CONFIG_ERROR";
        throw err;
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
