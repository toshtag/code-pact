import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { RelativePosixPath } from "./schemas/relative-path.ts";
import { assertSafePlanId } from "./schemas/plan-id.ts";
import { resolveWithinProject } from "./path-safety.ts";

// Single source of truth for where an agent's profile lives.
//
// `doctor` resolves the profile via the project's `agents[].profile` (a
// schema-validated project-relative path), but every other command
// hardcodes `agent-profiles/<name>.yaml`. For a project whose `agents[].profile`
// is non-default, that made doctor point at one file while `adapter upgrade`
// (and recommend / task prepare / pack / the model_version pin) read another.
// These helpers make all of them agree with doctor.
//
// Resolution honors `project.yaml`'s matching `agents[].profile`, falling back
// to the conventional `agent-profiles/<name>.yaml` (what `init` writes) ONLY
// when project.yaml is absent or the agent is not listed. A present-but-broken
// config — unparseable project.yaml, or a matched agent whose `profile` is an
// invalid path — fails with CONFIG_ERROR rather than being masked behind the
// default. (An unrelated invalid field elsewhere does not block resolution: we
// read just the matched agent's `profile`.)

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
 * Falls back to the convention only when project.yaml is absent (ENOENT) or the
 * agent is not listed in a valid `agents` array. A present-but-broken config —
 * unreadable or unparseable project.yaml, a missing / non-array `agents`, or a
 * matched agent whose `profile` is an *invalid* path (e.g. `../../etc/x`) —
 * throws `CONFIG_ERROR` rather than falling back: the project exists and (for
 * the profile case) explicitly declared that path, so silently reading/writing
 * a different file would hide the misconfiguration. The resolved path is
 * validated (`RelativePosixPath`: no `..`, no absolute, no backslash) before use.
 */
export async function resolveAgentProfileRel(
  cwd: string,
  agentName: string,
): Promise<string> {
  assertSafePlanId(agentName, "Agent");
  let raw: string;
  try {
    raw = await readFile(await resolveWithinProject(cwd, ".code-pact/project.yaml"), "utf8");
  } catch (err) {
    // Absent project.yaml → convention. But a present-but-unreadable file
    // (EACCES, EISDIR, transient I/O) is a real problem: surface it rather than
    // silently reading/writing the default profile.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return defaultProfileRel(agentName);
    }
    const e = new Error(
      `Cannot read .code-pact/project.yaml while resolving the agent profile for "${agentName}".`,
    );
    (e as NodeJS.ErrnoException).code = "CONFIG_ERROR";
    throw e;
  }
  let doc: unknown;
  try {
    doc = parseYaml(raw) as unknown;
  } catch {
    // project.yaml is present but not parseable YAML — a real misconfiguration.
    // Surface it rather than silently reading/writing the default file.
    const err = new Error(
      `Cannot parse .code-pact/project.yaml while resolving the agent profile for "${agentName}".`,
    );
    (err as NodeJS.ErrnoException).code = "CONFIG_ERROR";
    throw err;
  }
  // `agents` is the field we actually read, and the Project schema requires it
  // (array, min 1). A present project.yaml that lacks it / has a non-array
  // `agents` is broken — not "agent unlisted" — so surface it rather than
  // falling back. (Unrelated fields are still ignored; only `agents` is read.)
  const agents = (doc as { agents?: unknown } | null)?.agents;
  if (!doc || typeof doc !== "object" || !Array.isArray(agents)) {
    const err = new Error(
      `Cannot resolve the agent profile for "${agentName}": .code-pact/project.yaml has no valid "agents" array.`,
    );
    (err as NodeJS.ErrnoException).code = "CONFIG_ERROR";
    throw err;
  }
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
  // agents array exists but the target agent is not listed → convention.
  return defaultProfileRel(agentName);
}

/**
 * Absolute path form of {@link resolveAgentProfileRel}, CONTAINED to the project.
 *
 * `resolveAgentProfileRel` validates the path lexically (`RelativePosixPath`: no
 * `..`/absolute/backslash), but a lexical `join` cannot stop a symlinked
 * `.code-pact/agent-profiles` (or a symlinked profile file) from resolving
 * outside the project. Every profile READ and — critically — the `--model` pin's
 * WRITE flow through this single resolver, so the containment belongs here:
 * route through {@link resolveWithinProject} so a symlink escape fails closed
 * before any I/O. The escape is mapped to `CONFIG_ERROR` (a project/profile
 * configuration problem — consistent with this resolver's other throws) so every
 * caller's existing CONFIG_ERROR handling applies unchanged, with no new code to
 * map at each of the ~9 call sites.
 */
export async function resolveAgentProfilePath(
  cwd: string,
  agentName: string,
): Promise<string> {
  const rel = await resolveAgentProfileRel(cwd, agentName);
  try {
    return await resolveWithinProject(cwd, [".code-pact", rel].join("/"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "PATH_OUTSIDE_PROJECT") {
      const e = new Error(
        `Agent profile path for "${agentName}" resolves outside the project root and was refused: ${(err as Error).message}`,
      );
      (e as NodeJS.ErrnoException).code = "CONFIG_ERROR";
      throw e;
    }
    throw err;
  }
}
