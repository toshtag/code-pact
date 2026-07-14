// Design-file loaders for the context pack. The OPTIONAL context sources
// (rules, decisions, constitution, done events, declared decisions, read globs)
// degrade to null / [] when missing or unreadable, so the builder can compose
// them with Promise.all and render whatever is actually present. The contract
// inputs still fail closed: `loadPhase` (the shared core/plan/load-phase.ts) throws when the phase file is missing,
// and `loadAgentProfile` rejects an unsafe agent name (its catch only swallows
// a missing-but-safe profile). Path-derived DECISION reads (the design/decisions
// listing + decision_refs / per-file reads) route through the shared live seams
// `readLiveDecisionDir` / `readLiveDecisionFile` (core/decisions/adr.ts), which
// reject `..`/absolute and symlink escape via resolveWithinProject; rule reads
// still go through the local `readWithinProject` with the same guarantee. The
// decision seams are FAIL-CLOSED (throw on a non-ENOENT error), so the loaders
// wrap them in a call-site catch to keep their optional degrade-to-[]/skip.

import { readOwnedText, listOwned } from "../project-fs/operations.ts";
import { resolveRulesDirectoryReadPath } from "../project-fs/authority-resolvers.ts";
import { parse as parseYaml } from "yaml";
import { Phase } from "../schemas/phase.ts";
import { AgentProfile } from "../schemas/agent-profile.ts";
import { type ProgressEvent } from "../schemas/progress-event.ts";
import { parseFrontMatter } from "./front-matter.ts";
import {
  classifyAdr,
  parseAdrCommitments,
  readLiveDecisionDir,
  readLiveDecisionFile,
} from "../decisions/adr.ts";
import {
  type DecisionDoc,
  type DecisionProjectionMetadata,
  type ReadGlobMatches,
  type RuleDoc,
} from "./formatters/markdown.ts";
import { loadMergedProgress } from "../progress/io.ts";
import { matchGlob, validateGlobSyntax } from "../glob.ts";
import { assertSafePlanId } from "../schemas/plan-id.ts";
import { readProjectTextOrNull } from "../project-read.ts";
import {
  assertAgentProfileNameMatches,
  resolveAgentProfilePath,
} from "../agent-profile-path.ts";
import { listTrackedProjectFiles } from "../project-files/tracked-files.ts";

// The project-contained read guard (`..`/absolute/symlink-escape → null) lives
// in the shared `core/project-read.ts` (`readProjectTextOrNull`) so the planning
// prompt and any other agent-facing grounding read share one implementation.

export async function loadAgentProfile(
  cwd: string,
  agentName: string,
): Promise<AgentProfile | null> {
  // Validate the agent name and resolve the path OUTSIDE the try, so an unsafe
  // `agentName` is a hard CONFIG_ERROR rather than being swallowed by the catch
  // (which returns null) — a `../evil` name can never read outside the project.
  // resolveAgentProfilePath honors a non-default `agents[].profile` from
  // project.yaml (matching doctor) and falls back to the conventional path.
  // A missing-but-safe profile still degrades gracefully to null.
  assertSafePlanId(agentName, "Agent");
  const profilePath = await resolveAgentProfilePath(cwd, agentName);
  let raw: string;
  try {
    raw = await readOwnedText(profilePath);
  } catch {
    return null;
  }
  let profile: AgentProfile;
  try {
    profile = AgentProfile.parse(parseYaml(raw) as unknown);
  } catch {
    return null;
  }
  assertAgentProfileNameMatches(profile, agentName, profilePath);
  return profile;
}

export async function loadConstitution(cwd: string): Promise<string | null> {
  // Route through the project-contained read helper — identical to rule and
  // decision reads — so a `design/constitution.md` symlinked OUTSIDE the
  // project (resolveWithinProject rejects symlink escape) cannot leak a
  // foreign file into the agent-facing context pack. OPTIONAL source:
  // missing / unreadable / unsafe → null, same degrade contract as before.
  return readProjectTextOrNull(cwd, "design/constitution.md");
}

// includeAll=true bypasses the applies_to filter (used for write_surface: large)
export async function loadRules(
  cwd: string,
  taskType: string,
  includeAll = false,
): Promise<RuleDoc[]> {
  let entries: string[];
  try {
    const rulesDir = await resolveRulesDirectoryReadPath(cwd);
    entries = await listOwned(rulesDir);
  } catch {
    return [];
  }

  const docs: RuleDoc[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".md")) continue;
    // constitution.md is included via the dedicated constitution slot, not rules
    if (entry === "constitution.md") continue;

    const raw = await readProjectTextOrNull(cwd, `design/rules/${entry}`);
    if (raw === null) continue; // unsafe (e.g. symlink escape) or unreadable
    const { frontMatter, body } = parseFrontMatter(raw);
    const tags: string[] = Array.isArray(frontMatter.tags)
      ? (frontMatter.tags as string[])
      : [];
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
function decisionProjectionMetadata(
  raw: string,
): DecisionProjectionMetadata | undefined {
  try {
    const { acceptance } = classifyAdr(raw);
    const commitments = parseAdrCommitments(raw);
    if (
      acceptance !== "accepted" ||
      !commitments.hasSection ||
      commitments.items.length === 0
    ) {
      return undefined;
    }
    return {
      accepted: true,
      commitments: commitments.items,
    };
  } catch {
    return undefined;
  }
}

export async function loadDecisions(
  cwd: string,
  taskId: string,
  allDecisions = false,
): Promise<DecisionDoc[]> {
  // OPTIONAL context source: degrade to [] on ANY listing error. The shared
  // live-listing seam (readLiveDecisionDir) is fail-closed (throws on non-ENOENT),
  // so wrap it here to keep this loader's degrade-on-any-error contract — the
  // leniency stays at the call site, never pushed into the seam. README.md and
  // PRUNED.md are already filtered out by the seam via normalizeDecisionRefPath.
  let entries: string[];
  try {
    entries = (await readLiveDecisionDir(cwd)).entries;
  } catch {
    return [];
  }

  const docs: DecisionDoc[] = [];
  for (const entry of entries.sort()) {
    const basename = entry.split("/").pop() ?? entry;
    if (!entry.endsWith(".md")) continue;
    if (!allDecisions && !basename.includes(taskId)) continue;

    // Live per-file read seam; missing/unsafe → skip (identical to the prior
    // readWithinProject → null → skip). A non-ENOENT read error throws from the
    // seam; catch it to preserve the optional-source skip contract.
    let raw: string;
    try {
      const r = await readLiveDecisionFile(cwd, entry);
      if (r.kind !== "ok") continue; // unsafe (e.g. symlink escape) or missing
      raw = r.content;
    } catch {
      continue; // unexpected read error — skip, same as before (optional source)
    }
    const { body } = parseFrontMatter(raw);
    const projection = decisionProjectionMetadata(raw);
    docs.push({
      filename: entry,
      body,
      ...(projection ? { projection } : {}),
    });
  }
  return docs;
}

// Returns the most recent done events for tasks in the given phase (up to 5).
// Used when ambiguity: high to give the agent context on completed similar work.
export async function loadDoneEventsInPhase(
  cwd: string,
  phase: Phase,
): Promise<ProgressEvent[]> {
  const taskIds = new Set((phase.tasks ?? []).map(t => t.id));
  if (taskIds.size === 0) return [];
  try {
    const { log } = await loadMergedProgress(cwd);
    return log.events
      .filter(e => e.status === "done" && taskIds.has(e.task_id))
      .slice(-5);
  } catch {
    return [];
  }
}

// Loads every event from the progress ledger (per-event files under
// .code-pact/state/events/ merged with the legacy .code-pact/state/progress.yaml)
// or returns [] when the ledger is missing / unparseable. The pack uses this to
// derive the current state of each id listed in task.depends_on.
export async function loadAllProgressEvents(
  cwd: string,
): Promise<ProgressEvent[]> {
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
    // the context pack. The shared live read seam rejects symlink escape
    // (resolveWithinProject). The decision gate (adr.ts) already fail-closes
    // unsafe refs; routing onto the same seam keeps the pack-render path's
    // path-safety identical to the gate's. OPTIONAL source: missing/unsafe →
    // skip, and a non-ENOENT read error is caught → skip (preserves the prior
    // readWithinProject degrade-on-any-error contract).
    let raw: string;
    try {
      const r = await readLiveDecisionFile(cwd, ref);
      if (r.kind !== "ok") continue; // unsafe path or not loadable — see comment above
      raw = r.content;
    } catch {
      continue; // unexpected read error — skip (optional source)
    }
    const { body } = parseFrontMatter(raw);
    const projection = decisionProjectionMetadata(raw);
    docs.push({
      filename: ref,
      body,
      ...(projection ? { projection } : {}),
    });
  }
  return docs;
}

// Matches each declared `reads` glob against Git tracked filenames only. This
// deliberately does not walk the filesystem: task.reads is an agent-facing
// declaration surface, and untracked local filenames must not become observable
// through the context pack. Non-git projects fail closed when reads are present.
export async function loadReadMatches(
  cwd: string,
  reads: readonly string[],
): Promise<ReadGlobMatches[]> {
  const result: ReadGlobMatches[] = [];
  const tracked = await listTrackedProjectFiles(cwd);
  for (const glob of reads) {
    if (validateGlobSyntax(glob) !== null) {
      // Pattern lint failed — still surface it in the pack with no
      // matches so the agent sees that this glob was declared.
      result.push({ glob, matches: [] });
      continue;
    }
    const matches = tracked.filter(path => matchGlob(glob, path));
    result.push({ glob, matches });
  }
  return result;
}
