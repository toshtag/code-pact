// Design-file loaders for the context pack. The OPTIONAL context sources
// (rules, decisions, constitution, done events, declared decisions, read globs)
// degrade to null / [] when missing or unreadable, so the builder can compose
// them with Promise.all and render whatever is actually present. The contract
// inputs still fail closed: `loadPhase` (the shared core/plan/load-phase.ts) throws when the phase file is missing,
// and `loadAgentProfile` rejects an unsafe agent name (its catch only swallows
// a missing-but-safe profile). Path-derived reads (decision_refs, readdir
// entries) go through `readWithinProject`, which rejects `..`/absolute and
// symlink escape.

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { Phase } from "../schemas/phase.ts";
import { AgentProfile } from "../schemas/agent-profile.ts";
import { type ProgressEvent } from "../schemas/progress-event.ts";
import { parseFrontMatter } from "./front-matter.ts";
import { NON_DECISION_FILES } from "../decisions/adr.ts";
import {
  type DecisionDoc,
  type ReadGlobMatches,
  type RuleDoc,
} from "./formatters/markdown.ts";
import { loadMergedProgress } from "../progress/io.ts";
import { validateGlobSyntax, walkAndMatch } from "../glob.ts";
import { assertSafePlanId } from "../schemas/plan-id.ts";
import { resolveWithinProject } from "../path-safety.ts";
import { resolveAgentProfilePath } from "../agent-profile-path.ts";

/**
 * Read a project file only if `relPath` resolves within the project root —
 * rejects `..`/absolute (lexical) AND symlink escape (via resolveWithinProject).
 * Returns null when unsafe or unreadable so callers can skip silently. This is
 * the read-side guard for every file whose path is derived from loaded YAML
 * (decision_refs) or from a readdir entry (which could be a symlink).
 */
async function readWithinProject(cwd: string, relPath: string): Promise<string | null> {
  try {
    return await readFile(await resolveWithinProject(cwd, relPath), "utf8");
  } catch {
    return null;
  }
}

export async function loadAgentProfile(cwd: string, agentName: string): Promise<AgentProfile | null> {
  // Validate the agent name and resolve the path OUTSIDE the try, so an unsafe
  // `agentName` is a hard CONFIG_ERROR rather than being swallowed by the catch
  // (which returns null) — a `../evil` name can never read outside the project.
  // resolveAgentProfilePath honors a non-default `agents[].profile` from
  // project.yaml (matching doctor) and falls back to the conventional path.
  // A missing-but-safe profile still degrades gracefully to null.
  assertSafePlanId(agentName, "Agent");
  const profilePath = await resolveAgentProfilePath(cwd, agentName);
  try {
    const raw = await readFile(profilePath, "utf8");
    return AgentProfile.parse(parseYaml(raw) as unknown);
  } catch {
    return null;
  }
}

export async function loadConstitution(cwd: string): Promise<string | null> {
  try {
    return await readFile(join(cwd, "design", "constitution.md"), "utf8");
  } catch {
    return null;
  }
}

// includeAll=true bypasses the applies_to filter (used for write_surface: large)
export async function loadRules(
  cwd: string,
  taskType: string,
  includeAll = false,
): Promise<RuleDoc[]> {
  const rulesDir = join(cwd, "design", "rules");
  let entries: string[];
  try {
    entries = await readdir(rulesDir);
  } catch {
    return [];
  }

  const docs: RuleDoc[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".md")) continue;
    // constitution.md is included via the dedicated constitution slot, not rules
    if (entry === "constitution.md") continue;

    const raw = await readWithinProject(cwd, `design/rules/${entry}`);
    if (raw === null) continue; // unsafe (e.g. symlink escape) or unreadable
    const { frontMatter, body } = parseFrontMatter(raw);
    const tags: string[] = Array.isArray(frontMatter.tags) ? (frontMatter.tags as string[]) : [];
    const appliesTo: string[] = Array.isArray(frontMatter.applies_to)
      ? (frontMatter.applies_to as string[])
      : [];

    if (includeAll || appliesTo.length === 0 || appliesTo.includes(taskType)) {
      docs.push({ filename: entry, tags, applies_to: appliesTo, body });
    }
  }
  return docs;
}

// allDecisions=true returns every decision file (used for context_size: large)
export async function loadDecisions(
  cwd: string,
  taskId: string,
  allDecisions = false,
): Promise<DecisionDoc[]> {
  const decisionsDir = join(cwd, "design", "decisions");
  let entries: string[];
  try {
    entries = await readdir(decisionsDir);
  } catch {
    return [];
  }

  const docs: DecisionDoc[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".md")) continue;
    if (NON_DECISION_FILES.has(entry)) continue; // index + prune ledger are not decisions
    if (!allDecisions && !entry.includes(taskId)) continue;

    const raw = await readWithinProject(cwd, `design/decisions/${entry}`);
    if (raw === null) continue; // unsafe (e.g. symlink escape) or unreadable
    const { body } = parseFrontMatter(raw);
    docs.push({ filename: entry, body });
  }
  return docs;
}

// Returns the most recent done events for tasks in the given phase (up to 5).
// Used when ambiguity: high to give the agent context on completed similar work.
export async function loadDoneEventsInPhase(
  cwd: string,
  phase: Phase,
): Promise<ProgressEvent[]> {
  const taskIds = new Set((phase.tasks ?? []).map((t) => t.id));
  if (taskIds.size === 0) return [];
  try {
    const { log } = await loadMergedProgress(cwd);
    return log.events
      .filter((e) => e.status === "done" && taskIds.has(e.task_id))
      .slice(-5);
  } catch {
    return [];
  }
}

// Loads every event from the progress ledger (per-event files under
// .code-pact/state/events/ merged with the legacy .code-pact/state/progress.yaml)
// or returns [] when the ledger is missing / unparseable. The pack uses this to
// derive the current state of each id listed in task.depends_on.
export async function loadAllProgressEvents(cwd: string): Promise<ProgressEvent[]> {
  try {
    const { log } = await loadMergedProgress(cwd);
    return log.events;
  } catch {
    return [];
  }
}

// Loads the decision files referenced by task.decision_refs,
// regardless of context_size. Skips entries that do not exist on disk
// — the plan-lint surface (TASK_DECISION_REF_NOT_FOUND) is responsible
// for warning the user about misconfigured refs at lint time; the pack
// renderer just shows what is actually loadable.
export async function loadDeclaredDecisions(
  cwd: string,
  refs: readonly string[],
): Promise<DecisionDoc[]> {
  const docs: DecisionDoc[] = [];
  for (const ref of refs) {
    // `ref` comes from task.decision_refs (loaded YAML) and is read into the
    // pack body, so it must be confined to the project root — a value like
    // `../../.ssh/id_rsa` would otherwise exfiltrate an arbitrary file into
    // the context pack. resolveWithinProject also rejects symlink escape. The
    // decision gate (adr.ts) already fail-closes unsafe refs; this is the
    // matching guard on the pack-render path.
    const raw = await readWithinProject(cwd, ref);
    if (raw === null) continue; // unsafe path or not loadable — see comment above
    const { body } = parseFrontMatter(raw);
    // Use just the basename for the section header so the rendered
    // pack matches the existing "Related Decisions" presentation
    // (which keys by filename, not full path).
    const filename = ref.split("/").pop() ?? ref;
    docs.push({ filename, body });
  }
  return docs;
}

// Walks the project for each declared `reads` glob and returns the
// matched paths per glob. Skips any glob that the lint surface would
// reject (path safety / syntax) so the pack renderer never sees a
// half-parsed pattern. Returns [] when task.reads is absent or empty.
export async function loadReadMatches(
  cwd: string,
  reads: readonly string[],
): Promise<ReadGlobMatches[]> {
  const result: ReadGlobMatches[] = [];
  for (const glob of reads) {
    if (validateGlobSyntax(glob) !== null) {
      // Pattern lint failed — still surface it in the pack with no
      // matches so the agent sees that this glob was declared.
      result.push({ glob, matches: [] });
      continue;
    }
    let matches: string[];
    try {
      matches = await walkAndMatch(cwd, glob);
    } catch {
      matches = [];
    }
    result.push({ glob, matches });
  }
  return result;
}
