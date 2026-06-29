import { readFile, readdir, access } from "node:fs/promises";
import { join, basename, extname } from "node:path";
import { parse as parseYaml } from "yaml";
import { Roadmap } from "../core/schemas/roadmap.ts";
import { Phase } from "../core/schemas/phase.ts";
import {
  ProgressLog,
  type ProgressEvent,
} from "../core/schemas/progress-event.ts";
import {
  loadMergedProgress,
  mergeProgressStreams,
} from "../core/progress/io.ts";
import { computeEventId } from "../core/progress/event-id.ts";
import {
  type LoadedEventFile,
  parseEventFileName,
  validateEventFileContent,
} from "../core/progress/events-io.ts";
import {
  readPackSources,
  durableIdsAndArchivedTasks,
  filterArchivedTaskLegacyConflicts,
} from "../core/progress/all-sources.ts";
import { validateSnapshotEventEvidence } from "../core/archive/snapshot-evidence.ts";
import { Project } from "../core/schemas/project.ts";
import { resolveSymlinkFreeProjectPath } from "../core/path-safety.ts";
import { resolveOwnedReadPath } from "../core/project-fs/owned-read.ts";
import {
  ACCEPTED_MODEL_VERSION_INPUTS,
  AgentProfile,
  normalizeModelVersion,
} from "../core/schemas/agent-profile.ts";
import {
  CLAUDE_KNOWN_VENDOR_MODEL_IDS,
  CLAUDE_TIER_MODEL_IDS,
} from "../core/models/catalog.ts";
import { detectModelMapDrift } from "../core/models/model-map-drift.ts";
import { loadDoctorConfig } from "../core/doctor-config.ts";
import { ModelProfile, ModelTier } from "../core/schemas/model-profile.ts";
import {
  detectDuplicatePhaseIds,
  detectDuplicateTaskIds,
  detectOrphanProgressEvents,
  detectProgressEventConflicts,
  phaseIdMismatchRecovery,
} from "../core/plan/checks.ts";
import type { PhaseEntry } from "../core/plan/state.ts";
import type { PlanIssue } from "../core/plan/shared.ts";
import {
  archivedEntriesFromSnapshot,
  discoverUnreferencedSnapshots,
  mergeArchivedTaskIndex,
  resolveMissingPhaseRef,
  type ArchivedTaskEntry,
} from "../core/archive/load-phase-snapshot.ts";
import { validateEventPackTier1 } from "../core/archive/event-pack-reader.ts";
import { bindPackToSnapshot } from "../core/archive/event-pack-binding.ts";
import { PhaseSnapshot } from "../core/schemas/phase-snapshot.ts";
import { isSupportedAgent, type SupportedAgent } from "../core/agents.ts";
import { CONSTITUTION_PLACEHOLDER_MARKERS } from "../core/constitution.ts";
import { readManifest } from "../core/adapters/manifest.ts";
import { auditWrites, runGit } from "../core/audit/index.ts";
import { gitIgnoredControlPlaneAreas } from "../core/control-plane-ignore.ts";
import { matchGlob, validateGlobSyntax } from "../core/glob.ts";
import { inspectAgent, type AdapterDoctorIssue } from "./adapter-doctor.ts";
import { readPackageVersion } from "../lib/package-version.ts";
import type { Locale } from "../i18n/index.ts";

// Per-project doctor configuration (`.code-pact/doctor.yaml`) is loaded via the
// shared `core/doctor-config.ts` so every `disabled_checks` consumer — doctor
// here and the `adapter upgrade --write` MODEL_MAP_STALE hint — reads it
// identically.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Machine-readable recovery guidance for a diagnostic (additive).
 *
 * The `message` already names the recommended command, alternatives, and how
 * to silence the check — but only as prose an agent has to parse. `recovery`
 * surfaces the same three things as structured fields so an agent can pick the
 * next action from JSON without natural-language parsing. Older issues omit it
 * entirely; consumers reading only `code` / `severity` / `message` are
 * unaffected.
 */
export type DoctorIssueRecovery = {
  /**
   * The recommended next command — a runnable template (`<…>` placeholders are
   * agent-supplied). Present when a single command can drive the fix (e.g.
   * `CONTROL_PLANE_NOT_DRIVEN`). Omitted when the fix is a manual edit with no
   * single command — those set `manual_action` instead, so an agent never
   * mistakes prose for something it can execute.
   */
  primary?: string;
  /**
   * A manual fix instruction, for diagnostics whose remedy is an edit with no
   * single runnable command (e.g. narrowing a `.gitignore`). Set INSTEAD of
   * `primary`. Not a shell command — do not execute it.
   */
  manual_action?: string;
  /** A runnable command that verifies the fix worked (e.g. re-run `code-pact doctor`). */
  confirm?: string;
  /** Equally-valid alternative commands, if any (e.g. record out-of-loop work). */
  alternatives?: string[];
  /** How to scope/silence the check: a config key or docs pointer. */
  reference?: string;
};

export type DoctorIssue = {
  code: string;
  severity: "error" | "warning";
  message: string;
  /** Structured recovery guidance (additive). Present on selected
   * actionable diagnostics (the `CONTROL_PLANE_*` advisories and the id-conflict
   * diagnostics DUPLICATE_PHASE_ID / DUPLICATE_TASK_ID / PHASE_ID_MISMATCH). */
  recovery?: DoctorIssueRecovery;
  /** Structured extras threaded from a shared plan detector (additive). e.g. the
   * id-conflict diagnostics carry `colliding_files` / `colliding_phases`, and
   * `PROGRESS_EVENT_CONFLICT` carries `details.events[]` (conflict attribution). */
  details?: Record<string, unknown>;
};

export type DoctorResult = {
  ok: boolean;
  issues: DoctorIssue[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type SafeYamlResult =
  | { ok: true; data: unknown }
  | {
      ok: false;
      code: "PATH_OUTSIDE_PROJECT" | "PATH_NOT_OWNED" | "INVALID_YAML";
    };

async function safeReadProjectYaml(
  cwd: string,
  relPath: string,
): Promise<SafeYamlResult> {
  let abs: string;
  try {
    abs = await resolveOwnedReadPath(cwd, relPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "PATH_NOT_OWNED") return { ok: false, code: "PATH_NOT_OWNED" };
    return { ok: false, code: "PATH_OUTSIDE_PROJECT" };
  }
  try {
    const raw = await readFile(abs, "utf8");
    return { ok: true, data: parseYaml(raw) };
  } catch {
    return { ok: false, code: "INVALID_YAML" };
  }
}

function pushPathIssue(issues: DoctorIssue[], relPath: string): void {
  issues.push({
    code: "PATH_OUTSIDE_PROJECT",
    severity: "error",
    message: `${relPath} resolves outside the project root or through an unsafe symlink and was not read`,
  });
}

async function projectFileExists(
  cwd: string,
  relPath: string,
): Promise<boolean> {
  try {
    await access(await resolveOwnedReadPath(cwd, relPath));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Individual check groups
// ---------------------------------------------------------------------------

async function checkProjectYaml(
  cwd: string,
  issues: DoctorIssue[],
): Promise<Project | null> {
  const path = ".code-pact/project.yaml";
  const result = await safeReadProjectYaml(cwd, path);
  if (!result.ok) {
    if (
      result.code === "PATH_OUTSIDE_PROJECT" ||
      result.code === "PATH_NOT_OWNED"
    )
      pushPathIssue(issues, path);
    else
      issues.push({
        code: "INVALID_YAML",
        severity: "error",
        message: `Cannot read ${path}`,
      });
    return null;
  }
  const parsed = Project.safeParse(result.data);
  if (!parsed.success) {
    issues.push({
      code: "SCHEMA_ERROR",
      severity: "error",
      message: `project.yaml failed schema validation: ${parsed.error.issues[0]?.message ?? "unknown"}`,
    });
    return null;
  }
  return parsed.data;
}

async function checkRoadmap(
  cwd: string,
  issues: DoctorIssue[],
): Promise<Roadmap | null> {
  const path = "design/roadmap.yaml";
  const result = await safeReadProjectYaml(cwd, path);
  if (!result.ok) {
    if (
      result.code === "PATH_OUTSIDE_PROJECT" ||
      result.code === "PATH_NOT_OWNED"
    )
      pushPathIssue(issues, path);
    else
      issues.push({
        code: "INVALID_YAML",
        severity: "error",
        message: `Cannot read ${path}`,
      });
    return null;
  }
  const parsed = Roadmap.safeParse(result.data);
  if (!parsed.success) {
    issues.push({
      code: "SCHEMA_ERROR",
      severity: "error",
      message: `roadmap.yaml failed schema validation: ${parsed.error.issues[0]?.message ?? "unknown"}`,
    });
    return null;
  }
  return parsed.data;
}

async function checkPhases(
  cwd: string,
  roadmap: Roadmap,
  issues: DoctorIssue[],
): Promise<{
  phases: Phase[];
  phaseEntries: PhaseEntry[];
  archivedKnownTaskIds: Set<string>;
}> {
  const phases: Phase[] = [];
  // PhaseEntry[] (with the REAL roadmap ref + path) so duplicate-id detection
  // can name the colliding files. Built here because this is the only place that
  // has both the ref and the parsed phase.
  const phaseEntries: PhaseEntry[] = [];
  // design-docs-ephemeral (step 4a): archived task-id candidates from tolerated
  // snapshots of hand-deleted COMPLETED phases. Collision-checked AFTER the loop
  // (same merge as the lint loaders), then handed to checkProgressLog so the
  // orphan-event detector treats a deleted phase's task ids as known.
  const archivedCandidates: ArchivedTaskEntry[] = [];

  for (const ref of roadmap.phases) {
    const absPath = join(cwd, ref.path);
    let presence: "present" | "absent" | "inaccessible";
    try {
      await access(await resolveOwnedReadPath(cwd, ref.path));
      presence = "present";
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "PATH_OUTSIDE_PROJECT" || code === "PATH_NOT_OWNED") {
        pushPathIssue(issues, ref.path);
        continue;
      }
      presence = code === "ENOENT" ? "absent" : "inaccessible";
    }
    if (presence === "inaccessible") {
      // Present but unreadable (e.g. a non-searchable parent dir) — fail closed.
      // The snapshot must NOT release a live file that is actually on disk.
      issues.push({
        code: "MISSING_PHASE_FILE",
        severity: "error",
        message: `roadmap.yaml references "${ref.path}" but it cannot be accessed (present but unreadable — check directory permissions)`,
      });
      continue;
    }
    if (presence === "absent") {
      // A hand-deleted COMPLETED phase is tolerated when a valid archive snapshot
      // proves it; a corrupt/mismatched snapshot fails closed loudly; no snapshot
      // is a MISSING_PHASE_FILE error (the roadmap references a phase whose file is
      // gone). Live-wins: a present file never consults the snapshot.
      const res = await resolveMissingPhaseRef(cwd, ref);
      if (res.kind === "tolerated") {
        archivedCandidates.push(...archivedEntriesFromSnapshot(res.snapshot));
        continue;
      }
      if (res.kind === "fail_invalid") {
        issues.push({
          code: "PHASE_SNAPSHOT_INVALID",
          severity: "error",
          message: `roadmap.yaml references "${ref.path}" but the file does not exist and its archive snapshot cannot release it: ${res.reason}`,
        });
        continue;
      }
      issues.push({
        code: "MISSING_PHASE_FILE",
        severity: "error",
        message: `roadmap.yaml references "${ref.path}" but the file does not exist`,
      });
      continue;
    }
    const result = await safeReadProjectYaml(cwd, ref.path);
    if (!result.ok) {
      if (
        result.code === "PATH_OUTSIDE_PROJECT" ||
        result.code === "PATH_NOT_OWNED"
      )
        pushPathIssue(issues, ref.path);
      else {
        issues.push({
          code: "INVALID_YAML",
          severity: "error",
          message: `Cannot parse phase file: ${ref.path}`,
        });
      }
      continue;
    }
    const parsed = Phase.safeParse(result.data);
    if (!parsed.success) {
      issues.push({
        code: "SCHEMA_ERROR",
        severity: "error",
        message: `${ref.path} failed schema validation: ${parsed.error.issues[0]?.message ?? "unknown"}`,
      });
      continue;
    }
    // Check that phase id in YAML matches roadmap ref id
    if (parsed.data.id !== ref.id) {
      issues.push({
        code: "PHASE_ID_MISMATCH",
        severity: "error",
        message: `${ref.path} has id="${parsed.data.id}" but roadmap expects "${ref.id}"`,
        recovery: phaseIdMismatchRecovery(ref.path, ref.id, parsed.data.id),
      });
    }
    phases.push(parsed.data);
    phaseEntries.push({ ref, absPath, phase: parsed.data });
  }

  // Check for phase YAML files in design/phases/ not referenced in roadmap
  let phaseFiles: string[] = [];
  try {
    const phasesDir = await resolveSymlinkFreeProjectPath(cwd, "design/phases");
    phaseFiles = await readdir(phasesDir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "PATH_OUTSIDE_PROJECT" || code === "PATH_NOT_OWNED") {
      pushPathIssue(issues, "design/phases");
    }
  }
  const referencedPaths = new Set(roadmap.phases.map(r => r.path));
  for (const file of phaseFiles) {
    if (!file.endsWith(".yaml")) continue;
    const relPath = `design/phases/${file}`;
    if (!referencedPaths.has(relPath)) {
      issues.push({
        code: "ORPHAN_PHASE_FILE",
        severity: "warning",
        message: `${relPath} exists but is not referenced in roadmap.yaml`,
      });
    }
  }

  // design-docs-ephemeral (step 4b): also discover UNREFERENCED archived phases so a
  // cross-phase depends_on into one is not falsely flagged, AND so a VALID
  // unreferenced snapshot whose ids collide is caught below. doctor DROPS discovery's
  // soft `invalid[]` — emitting the PHASE_SNAPSHOT_INVALID advisory here (even as a
  // warning) would fail `validate --strict` (issues.length === 0), breaking A5 for a
  // project that merely has a corrupt/unreadable unreferenced snapshot. The advisory's
  // home is `plan lint`; doctor needs discovery ONLY for the collision.
  // NOTE: dropping the advisory does NOT suppress INDEPENDENT diagnostics — a corrupt
  // unreferenced snapshot supplies no ids, so a leftover progress event for one of its
  // would-be ids still (correctly) surfaces as ORPHAN_PROGRESS_EVENT below, and
  // `validate --strict` fails on THAT, not on PHASE_SNAPSHOT_INVALID.
  const discovered = await discoverUnreferencedSnapshots(
    cwd,
    new Set(roadmap.phases.map(r => r.id)),
  );
  archivedCandidates.push(...discovered.entries);

  // Collision-checked merge (same as the lint loaders): an archived id that
  // collides with a live id / another snapshot / itself is EXCLUDED and surfaced
  // as PHASE_SNAPSHOT_INVALID — never a silencer. `validate` delegates to doctor,
  // so this is the path that keeps the ambiguity out of validate too.
  const liveTaskIds = new Set<string>();
  for (const phase of phases) {
    for (const task of phase.tasks ?? []) liveTaskIds.add(task.id);
  }
  const merge = mergeArchivedTaskIndex(liveTaskIds, archivedCandidates);
  for (const c of merge.collisions) {
    issues.push({
      code: "PHASE_SNAPSHOT_INVALID",
      severity: "error",
      message: `archive snapshot task id collides with the live plan: ${c.reason}`,
    });
  }

  return {
    phases,
    phaseEntries,
    archivedKnownTaskIds: new Set(merge.index.keys()),
  };
}

async function checkProgressLog(
  cwd: string,
  phases: Phase[],
  archivedKnownTaskIds: Set<string>,
  issues: DoctorIssue[],
): Promise<void> {
  const path = ".code-pact/state/progress.yaml";
  // A missing progress.yaml is NOT an error — event files may still supply
  // events (the post-migration / events-only state). Only an existing but
  // unreadable / schema-invalid legacy file is INVALID_YAML / SCHEMA_ERROR.
  let legacyEvents: ProgressEvent[] = [];
  try {
    const raw = await readFile(await resolveOwnedReadPath(cwd, path), "utf8");
    let doc: unknown;
    try {
      doc = parseYaml(raw);
    } catch {
      issues.push({
        code: "INVALID_YAML",
        severity: "error",
        message: `Cannot read ${path}`,
      });
      return;
    }
    const parsed = ProgressLog.safeParse(doc);
    if (!parsed.success) {
      issues.push({
        code: "SCHEMA_ERROR",
        severity: "error",
        message: `progress.yaml failed schema validation: ${parsed.error.issues[0]?.message ?? "unknown"}`,
      });
      return;
    }
    legacyEvents = parsed.data.events;
  } catch (err) {
    if (
      (err as NodeJS.ErrnoException).code === "PATH_OUTSIDE_PROJECT" ||
      (err as NodeJS.ErrnoException).code === "PATH_NOT_OWNED"
    ) {
      pushPathIssue(issues, path);
      return;
    }
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      issues.push({
        code: "INVALID_YAML",
        severity: "error",
        message: `Cannot read ${path}`,
      });
      return;
    }
    // ENOENT → missing legacy file; fall through with empty legacy events.
  }

  // Merge loose + Tier-2-bound packs for orphan + conflict detection (lenient: a
  // corrupt event file / unbound pack carries its own diagnostic code straight
  // through, so doctor and plan lint never disagree). EVENT_FILE_ID_MISMATCH /
  // INVALID_YAML / EVENT_PACK_INVALID are passed through; anything else → SCHEMA_ERROR.
  let packSources;
  try {
    packSources = await readPackSources(cwd, "lenient");
  } catch (err) {
    const tag = (err as NodeJS.ErrnoException).code;
    const code =
      tag === "EVENT_FILE_ID_MISMATCH" ||
      tag === "INVALID_YAML" ||
      tag === "EVENT_PACK_INVALID"
        ? tag
        : "SCHEMA_ERROR";
    issues.push({ code, severity: "error", message: (err as Error).message });
    return;
  }
  let returnAfterIssues = false;
  for (const issue of packSources.issues) {
    issues.push({
      code: issue.code,
      severity: "error",
      message: issue.message,
    });
    returnAfterIssues = true;
  }
  if (returnAfterIssues) return; // a corrupt/unbound pack: stop before orphan logic
  // Archived-task legacy conflict gate (lenient: collect + exclude from merge).
  const { durableIds, archivedTaskIds, archivedEnumerationComplete } =
    await durableIdsAndArchivedTasks(cwd, packSources);
  const { mergeableLegacyEvents, issues: legacyIssues } =
    filterArchivedTaskLegacyConflicts(
      legacyEvents,
      durableIds,
      archivedTaskIds,
      "lenient",
      archivedEnumerationComplete,
    );
  for (const issue of legacyIssues) {
    issues.push({
      code: issue.code,
      severity: "error",
      message: issue.message,
    });
  }
  const events = mergeProgressStreams(mergeableLegacyEvents, [
    ...packSources.looseFiles,
    ...packSources.validatedPackFiles,
  ]);

  // Known ids = live ∪ archived (step 4a): a ledger event for a hand-deleted
  // COMPLETED phase's task is not an orphan. The archived set is collision-checked
  // upstream, so it never silences a genuinely orphaned event.
  const taskIndex = new Set<string>();
  for (const phase of phases) {
    for (const task of phase.tasks ?? []) taskIndex.add(task.id);
  }
  const known = {
    has: (id: string) => taskIndex.has(id) || archivedKnownTaskIds.has(id),
  };
  for (const planIssue of detectOrphanProgressEvents(events, known)) {
    issues.push(planIssueToDoctor(planIssue));
  }
  for (const planIssue of detectProgressEventConflicts(events)) {
    issues.push(planIssueToDoctor(planIssue));
  }
}

/**
 * Validate every archived-snapshot `progress_events` evidence against the
 * durable ledger (loose ∪ Tier-2-validated packs — never legacy). A snapshot
 * unreadable during the scan is a silent skip (it surfaces elsewhere), matching
 * the fail-soft discovery contract. A corrupt pack read entirely also skips
 * (checkProgressLog owns that error code).
 */
async function checkSnapshotEventEvidence(
  cwd: string,
  issues: DoctorIssue[],
): Promise<void> {
  let packSources;
  try {
    packSources = await readPackSources(cwd, "lenient");
  } catch {
    return; // pack read failure is owned by checkProgressLog
  }
  const resolved = new Map<string, ProgressEvent>();
  for (const f of packSources.looseFiles) resolved.set(f.id, f.event);
  for (const f of packSources.validatedPackFiles) resolved.set(f.id, f.event);
  const { result } = await validateSnapshotEventEvidence(cwd, resolved);
  if (!result.ok) {
    for (const issue of result.issues) {
      issues.push({
        code: "SNAPSHOT_EVENT_EVIDENCE_UNRESOLVABLE",
        severity: "error",
        message: issue.message,
        details: {
          phase_id: issue.phase_id,
          task_id: issue.task_id,
          event_id: issue.event_id,
          reason: issue.reason,
        },
      });
    }
  }
}

function planIssueToDoctor(issue: PlanIssue): DoctorIssue {
  return {
    code: issue.code,
    severity: issue.severity,
    message: issue.message,
    // Thread structured recovery + details through to the doctor surface
    // (additive). PlanIssueRecovery is shape-identical to DoctorIssueRecovery, so
    // collab conflict diagnostics keep their fix guidance and `colliding_files` in
    // `doctor --json` too — parity with `plan lint`.
    ...(issue.recovery !== undefined ? { recovery: issue.recovery } : {}),
    ...(issue.details !== undefined ? { details: issue.details } : {}),
  };
}

async function checkAgentProfiles(
  cwd: string,
  project: Project,
  issues: DoctorIssue[],
): Promise<void> {
  const knownTiers = new Set(ModelTier.options);

  for (const agentRef of project.agents) {
    const profilePath = [".code-pact", agentRef.profile].join("/");
    const result = await safeReadProjectYaml(cwd, profilePath);
    if (!result.ok) {
      if (
        result.code === "PATH_OUTSIDE_PROJECT" ||
        result.code === "PATH_NOT_OWNED"
      )
        pushPathIssue(issues, profilePath);
      else {
        issues.push({
          code: "AGENT_NOT_FOUND",
          severity: "error",
          message: `Agent profile "${agentRef.profile}" cannot be read`,
        });
      }
      continue;
    }
    const parsed = AgentProfile.safeParse(result.data);
    if (!parsed.success) {
      issues.push({
        code: "SCHEMA_ERROR",
        severity: "error",
        message: `${agentRef.profile} failed schema validation: ${parsed.error.issues[0]?.message ?? "unknown"}`,
      });
      continue;
    }
    // Check all tiers are present in model_map
    for (const tier of knownTiers) {
      if (!parsed.data.model_map[tier]) {
        issues.push({
          code: "MISSING_MODEL_TIER",
          severity: "warning",
          message: `Agent "${parsed.data.name}" is missing model_map entry for tier "${tier}"`,
        });
      }
    }

    // Model-id drift checks. Scoped to the claude-code (anthropic) profile:
    // the catalog describes Claude ids only, so comparing codex (gpt-5.x)
    // or other agents against it would emit false positives. Offline — these
    // compare against the bundled catalog, never the network.
    if (parsed.data.name === "claude-code") {
      const knownVendorIds = new Set(CLAUDE_KNOWN_VENDOR_MODEL_IDS);
      // The MODEL_MAP_STALE *condition* is owned by detectModelMapDrift so
      // `adapter upgrade --write`'s remaining-advisory hint can never disagree
      // with doctor about whether a profile is stale. The message text stays
      // here (doctor's full remediation differs from the upgrade hint).
      const staleByTier = new Map(
        detectModelMapDrift(parsed.data.model_map).map(d => [d.tier, d]),
      );
      for (const tier of knownTiers) {
        const id = parsed.data.model_map[tier];
        if (!id) continue; // absence already reported as MISSING_MODEL_TIER
        if (!knownVendorIds.has(id)) {
          // Unknown vendor id: a typo, or a model id not represented in the
          // bundled catalog (e.g. a newer/older release code-pact does not
          // track yet).
          issues.push({
            code: "MODEL_ID_UNKNOWN",
            severity: "warning",
            message: `Agent "${parsed.data.name}" model_map.${tier} is "${id}", which is not in the bundled Claude catalog (known: ${CLAUDE_KNOWN_VENDOR_MODEL_IDS.join(", ")}). Check for a typo, or a model id code-pact does not track yet.`,
          });
        } else if (staleByTier.has(tier)) {
          // Known but not the current catalog default — i.e. the profile was
          // generated before a model bump. Not invalid: a deliberate pin is
          // fine. Surface it so a forgotten default does not silently rot.
          // NB: `adapter upgrade --model` only re-pins model_version, never
          // model_map, so the remediation is a hand-edit of model_map followed
          // by a plain regenerate — do NOT advise --model here.
          issues.push({
            code: "MODEL_MAP_STALE",
            severity: "warning",
            message: `Agent "${parsed.data.name}" model_map.${tier} is "${id}", but the current catalog default is "${CLAUDE_TIER_MODEL_IDS[tier]}" — a difference from the default, not an invalid value. To follow it, set model_map.${tier} to "${CLAUDE_TIER_MODEL_IDS[tier]}" in .code-pact/${agentRef.profile}, then run "code-pact adapter upgrade ${agentRef.name} --write" to regenerate the instruction file. Keep it if the pin is intentional, or silence via .code-pact/doctor.yaml (disabled_checks: [MODEL_MAP_STALE]).`,
          });
        }
      }
      // model_version is a deliberate user pin (set via --model). Flag only a
      // truly unrecognized value; never treat an older-but-known version as
      // "stale" — that would nag a user who explicitly pinned it.
      const mv = parsed.data.model_version;
      if (mv !== undefined && normalizeModelVersion(mv) === null) {
        issues.push({
          code: "MODEL_ID_UNKNOWN",
          severity: "warning",
          message: `Agent "${parsed.data.name}" model_version is "${mv}", which is not a recognized Claude model version (accepted: ${ACCEPTED_MODEL_VERSION_INPUTS.join(", ")}).`,
        });
      }
    }
  }
}

async function checkModelProfiles(
  cwd: string,
  issues: DoctorIssue[],
): Promise<void> {
  const dirRel = ".code-pact/model-profiles";
  let entries: string[] = [];
  try {
    const dir = await resolveOwnedReadPath(cwd, dirRel);
    entries = await readdir(dir);
  } catch (err) {
    if (
      (err as NodeJS.ErrnoException).code === "PATH_OUTSIDE_PROJECT" ||
      (err as NodeJS.ErrnoException).code === "PATH_NOT_OWNED"
    ) {
      pushPathIssue(issues, dirRel);
      return;
    }
    issues.push({
      code: "MISSING_DIR",
      severity: "warning",
      message: `.code-pact/model-profiles/ directory is missing`,
    });
    return;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".yaml")) continue;
    const relPath = `${dirRel}/${entry}`;
    const result = await safeReadProjectYaml(cwd, relPath);
    if (!result.ok) {
      if (
        result.code === "PATH_OUTSIDE_PROJECT" ||
        result.code === "PATH_NOT_OWNED"
      )
        pushPathIssue(issues, relPath);
      else {
        issues.push({
          code: "INVALID_YAML",
          severity: "error",
          message: `.code-pact/model-profiles/${entry} cannot be parsed`,
        });
      }
      continue;
    }
    const parsed = ModelProfile.safeParse(result.data);
    if (!parsed.success) {
      issues.push({
        code: "SCHEMA_ERROR",
        severity: "error",
        message: `.code-pact/model-profiles/${entry} failed schema validation`,
      });
    }
  }
}

async function checkBakFiles(
  cwd: string,
  issues: DoctorIssue[],
): Promise<void> {
  // Check design/ tree for .bak files
  const dirs = ["design", ".code-pact"];
  for (const relDir of dirs) {
    let entries: string[] = [];
    try {
      const dir = await resolveOwnedReadPath(cwd, relDir);
      entries = await readdir(dir);
    } catch (err) {
      if (
        (err as NodeJS.ErrnoException).code === "PATH_OUTSIDE_PROJECT" ||
        (err as NodeJS.ErrnoException).code === "PATH_NOT_OWNED"
      ) {
        pushPathIssue(issues, relDir);
      }
      continue;
    }
    for (const entry of entries) {
      if (entry.endsWith(".bak")) {
        issues.push({
          code: "BAK_FILE",
          severity: "warning",
          message: `Backup file found: ${relDir}/${entry} — safe to delete`,
        });
      }
    }
  }
}

// Check 9: duplicate phase/task ids across the roadmap — delegates to the shared
// detectors in src/core/plan/checks.ts so `plan lint` and `doctor` surface the
// SAME conflict diagnostics (and the same `recovery`). Uses the real PhaseEntry[]
// (with roadmap ref + path) so DUPLICATE_PHASE_ID can name the colliding files —
// the clean-but-wrong merge where two phase files both claim `P1`.
function checkDuplicateIds(
  phaseEntries: PhaseEntry[],
  issues: DoctorIssue[],
): void {
  for (const planIssue of detectDuplicatePhaseIds(phaseEntries)) {
    issues.push(planIssueToDoctor(planIssue));
  }
  for (const planIssue of detectDuplicateTaskIds(phaseEntries)) {
    issues.push(planIssueToDoctor(planIssue));
  }
}

// Check 10: .local/ is gitignored
async function checkLocalGitignored(
  cwd: string,
  issues: DoctorIssue[],
): Promise<void> {
  let content: string;
  try {
    content = await readFile(
      await resolveOwnedReadPath(cwd, ".gitignore"),
      "utf8",
    );
  } catch {
    issues.push({
      code: "LOCAL_NOT_GITIGNORED",
      severity: "warning",
      message:
        '.gitignore not found — add ".local/" to avoid committing sensitive planning notes',
    });
    return;
  }
  const lines = content.split("\n").map(l => l.trim());
  const isIgnored = lines.some(
    l =>
      l === ".local" ||
      l === ".local/" ||
      l === "/.local" ||
      l === "/.local/" ||
      l.startsWith(".local/"),
  );
  if (!isIgnored) {
    issues.push({
      code: "LOCAL_NOT_GITIGNORED",
      severity: "warning",
      message:
        '.local/ is not in .gitignore — add ".local/" to avoid committing sensitive planning notes',
    });
  }
}

// Check 11: enabled agents have their adapter instruction file on disk.
//
// This legacy check ONLY fires when no manifest exists. With a manifest,
// the manifest-aware checkAdapterManifestAware emits the more precise
// ADAPTER_FILE_MISSING (error) per managed file.
async function checkAdapterMissing(
  cwd: string,
  project: Project,
  issues: DoctorIssue[],
): Promise<void> {
  for (const agentRef of project.agents) {
    if (agentRef.enabled === false) continue;

    if (isSupportedAgent(agentRef.name)) {
      // Skip legacy check when a manifest exists OR is invalid — the
      // manifest-aware path will surface the appropriate finding.
      try {
        const m = await readManifest(cwd, agentRef.name);
        if (m !== null) continue;
      } catch {
        continue;
      }
    }

    const profilePath = [".code-pact", agentRef.profile].join("/");
    const result = await safeReadProjectYaml(cwd, profilePath);
    if (!result.ok) continue; // already reported by checkAgentProfiles
    const parsed = AgentProfile.safeParse(result.data);
    if (!parsed.success) continue;
    if (!(await projectFileExists(cwd, parsed.data.instruction_filename))) {
      issues.push({
        code: "ADAPTER_MISSING",
        severity: "warning",
        message: `Agent "${parsed.data.name}" is enabled but "${parsed.data.instruction_filename}" does not exist — run "code-pact adapter install ${agentRef.name}"`,
      });
    }
  }
}

// Check 11b: manifest-aware adapter health.
//
// Runs only for enabled agents whose manifest file exists on disk. The
// per-agent findings come from inspectAgent (the same code path
// `adapter doctor` uses), so error codes and semantics stay aligned.
// ADAPTER_MANIFEST_MISSING is intentionally dropped — it's an
// `adapter doctor`-only signal, so we don't make existing projects
// suddenly noisy.
async function checkAdapterManifestAware(
  cwd: string,
  project: Project,
  issues: DoctorIssue[],
): Promise<void> {
  const locale = resolveDoctorLocale(project);
  const packageVersion = await readPackageVersion();

  for (const agentRef of project.agents) {
    if (agentRef.enabled === false) continue;
    if (!isSupportedAgent(agentRef.name)) continue;

    let manifestPresent: boolean;
    try {
      const m = await readManifest(cwd, agentRef.name);
      manifestPresent = m !== null;
    } catch {
      // Invalid manifest → let inspectAgent emit ADAPTER_MANIFEST_INVALID.
      manifestPresent = true;
    }
    if (!manifestPresent) continue;

    const findings = await inspectAgent({
      cwd,
      agentName: agentRef.name as SupportedAgent,
      locale,
      enabled: true,
      packageVersion,
    });
    for (const f of findings) {
      if (f.code === "ADAPTER_MANIFEST_MISSING") continue;
      issues.push(adapterIssueToDoctor(f));
    }
  }
}

function resolveDoctorLocale(project: Project): Locale {
  const lc = project.locale;
  return typeof lc === "string" ? lc : lc.default;
}

function adapterIssueToDoctor(issue: AdapterDoctorIssue): DoctorIssue {
  return {
    code: issue.code,
    severity: issue.severity,
    message: `[${issue.agent}] ${issue.message}`,
  };
}

// Check 12: design/brief.md exists.
//
// Gated on a real phase existing, mirroring CONSTITUTION_PLACEHOLDER (Check 13):
// a brand-new project (no phases, or only the TUTORIAL sample) hasn't started
// real work, and brief.md is not generated by init, so nagging for it on the
// first `doctor` run is pure noise. brief.md is also genuinely optional —
// adopting an existing roadmap or planning by hand never needs it. The warning
// fires only once the project has a non-tutorial phase, where a project
// overview becomes useful; `plan prompt` separately notices a missing brief.
async function checkBriefMissing(
  cwd: string,
  phases: Phase[],
  issues: DoctorIssue[],
): Promise<void> {
  const hasRealPhase = phases.some(p => p.id !== "TUTORIAL");
  if (!hasRealPhase) return;

  if (!(await projectFileExists(cwd, "design/brief.md"))) {
    issues.push({
      code: "BRIEF_MISSING",
      severity: "warning",
      message:
        'design/brief.md does not exist — run "code-pact plan brief" to create a project overview',
    });
  }
}

// Check 13: constitution.md is not the unedited initial template.
//
// Gated on a real phase existing: a brand-new project (no phases, or only the
// TUTORIAL sample) hasn't started real work yet, so nagging about the
// placeholder is pure noise. init surfaces the edit nudge via
// suggested_next_steps instead; this warning fires once the project has a
// non-tutorial phase and the constitution is still untouched.
async function checkConstitutionPlaceholder(
  cwd: string,
  phases: Phase[],
  issues: DoctorIssue[],
): Promise<void> {
  const hasRealPhase = phases.some(p => p.id !== "TUTORIAL");
  if (!hasRealPhase) return;

  const path = "design/constitution.md";
  let content: string;
  try {
    content = await readFile(await resolveOwnedReadPath(cwd, path), "utf8");
  } catch {
    return; // file absent — BRIEF_MISSING or similar handles the design dir; skip here
  }
  const isPlaceholder = CONSTITUTION_PLACEHOLDER_MARKERS.some(m =>
    content.includes(m),
  );
  if (isPlaceholder) {
    issues.push({
      code: "CONSTITUTION_PLACEHOLDER",
      severity: "warning",
      message:
        'design/constitution.md still contains the initial template text — edit it or run "code-pact plan constitution"',
    });
  }
}

// Check 14: all phase objectives are non-trivial (>= 10 chars)
function checkEmptyObjectives(phases: Phase[], issues: DoctorIssue[]): void {
  for (const phase of phases) {
    if (!phase.objective || phase.objective.trim().length < 10) {
      issues.push({
        code: "EMPTY_OBJECTIVE",
        severity: "error",
        message: `Phase "${phase.id}" has an empty or too-short objective (must be at least 10 characters)`,
      });
    }
  }
}

// Check 15: enabled agent profiles have model_version set
async function checkAdapterStale(
  cwd: string,
  project: Project,
  issues: DoctorIssue[],
): Promise<void> {
  for (const agentRef of project.agents) {
    if (agentRef.enabled === false) continue;
    const profilePath = [".code-pact", agentRef.profile].join("/");
    const result = await safeReadProjectYaml(cwd, profilePath);
    if (!result.ok) continue; // already reported elsewhere
    const parsed = AgentProfile.safeParse(result.data);
    if (!parsed.success) continue;
    if (!parsed.data.model_version) {
      issues.push({
        code: "ADAPTER_STALE",
        severity: "warning",
        message: `Agent "${parsed.data.name}" has no model_version set — run "code-pact adapter install ${agentRef.name} --model <version>" to pin a model (accepted: ${ACCEPTED_MODEL_VERSION_INPUTS.join(", ")})`,
      });
    }
  }
}

async function checkStaleContext(
  cwd: string,
  phases: Phase[],
  project: Project,
  issues: DoctorIssue[],
): Promise<void> {
  const knownTaskIds = new Set(
    phases.flatMap(p => (p.tasks ?? []).map(t => t.id)),
  );

  for (const agentRef of project.agents) {
    // Derive context dir from agent profile
    const profilePath = [".code-pact", agentRef.profile].join("/");
    const result = await safeReadProjectYaml(cwd, profilePath);
    if (!result.ok) continue;
    const parsed = AgentProfile.safeParse(result.data);
    if (!parsed.success) continue;

    let entries: string[] = [];
    try {
      const contextDir = await resolveOwnedReadPath(
        cwd,
        parsed.data.context_dir,
      );
      entries = await readdir(contextDir);
    } catch (err) {
      if (
        (err as NodeJS.ErrnoException).code === "PATH_OUTSIDE_PROJECT" ||
        (err as NodeJS.ErrnoException).code === "PATH_NOT_OWNED"
      ) {
        pushPathIssue(issues, parsed.data.context_dir);
      }
      continue;
    }
    for (const entry of entries) {
      if (extname(entry) !== ".md") continue;
      const taskId = basename(entry, ".md");
      if (!knownTaskIds.has(taskId)) {
        issues.push({
          code: "STALE_CONTEXT",
          severity: "warning",
          message: `${parsed.data.context_dir}/${entry} exists but task "${taskId}" is not in any phase`,
        });
      }
    }
  }
}

// Check 16: the control plane is scaffolded but not being driven.
// Advisory (warning): fires only when a real (non-TUTORIAL) task exists, the
// loop has never been driven for a non-TUTORIAL task, AND git shows
// uncommitted working changes — i.e. real code is happening outside the loop.
// git-unavailable is a silent skip (never an error).
async function checkControlPlaneNotDriven(
  cwd: string,
  phases: Phase[],
  issues: DoctorIssue[],
): Promise<void> {
  // Gate 1: at least one non-TUTORIAL task is planned.
  const realTasks = phases
    .filter(p => p.id !== "TUTORIAL")
    .reduce((n, p) => n + (p.tasks?.length ?? 0), 0);
  if (realTasks === 0) return;

  // Gate 2: no non-TUTORIAL forward motion. Merged workspace view (legacy
  // progress.yaml + per-event files). Unreadable / invalid / corrupt ledger →
  // skip and let checkProgressLog own the real INVALID_YAML / SCHEMA_ERROR /
  // EVENT_FILE_ID_MISMATCH (don't stack a speculative advisory on a broken
  // state file).
  let events: ProgressEvent[] = [];
  try {
    events = (await loadMergedProgress(cwd)).log.events;
  } catch {
    return;
  }
  const drivenForReal = events.some(
    e =>
      (e.status === "started" || e.status === "done") &&
      !e.task_id.startsWith("TUTORIAL-"),
  );
  if (drivenForReal) return;

  // Gate 3: git available AND uncommitted working changes exist (excluding
  // code-pact's own runtime state, handled by auditWrites). git-unavailable
  // (no repo / no git binary) → git_available:false → silent skip.
  const audit = await auditWrites({ cwd, declaredWrites: [] });
  if (!audit.git_available || audit.files_touched.length === 0) return;

  issues.push({
    code: "CONTROL_PLANE_NOT_DRIVEN",
    severity: "warning",
    message:
      `${realTasks} task(s) are planned and git has uncommitted changes, but the progress ledger has no started/done event for a non-TUTORIAL task — the code-pact scaffold exists but isn't being driven. ` +
      'Start a task with `code-pact task prepare <id> --agent <agent>`, or record out-of-loop work with `code-pact task record-done <id> --evidence "..."`. ' +
      "Silence via .code-pact/doctor.yaml (disabled_checks: [CONTROL_PLANE_NOT_DRIVEN]).",
    recovery: {
      primary: "code-pact task prepare <id> --agent <agent>",
      alternatives: ['code-pact task record-done <id> --evidence "..."'],
      reference:
        ".code-pact/doctor.yaml (disabled_checks: [CONTROL_PLANE_NOT_DRIVEN])",
    },
  });
}

// Check 18: the shared control
// plane is git-ignored. A blanket `/.code-pact/` .gitignore (or any rule that
// matches a shared area) means that state never reaches git, and the
// collaboration model silently no-ops for whatever is ignored: a clean checkout
// or a teammate may miss the project config, profiles, baselines, or the
// progress ledger. ONLY when the ledger itself is ignored does the
// CONTROL_PLANE_BRANCH_NOT_DRIVEN CI gate also silently skip (no tracked ledger
// to read) — a config/profile-only ignore does not affect that gate. `init`
// writes a NARROW ignore but never deletes a user's pre-existing blanket line,
// so the policy can be written yet defeated — this is the authoritative detector
// for that gap.
//
// Authoritative because it asks git, not the .gitignore text: `git check-ignore
// --no-index` matches against the ignore RULES only (what a NEW, untracked file
// would hit), so a force-added file under a blanket ignore does not mask the
// problem, and a negation re-include (`!…`) is honoured (no false positive).
// `gitIgnoredControlPlaneAreas` probes the WHOLE shared control plane (the
// ledger AND project.yaml / profiles / baselines), each via a representative file
// path so a file-scoped rule (`events/*.yaml`) is caught too. Conservative skips:
// no git / not a repo / not a real project. Advisory (warning); disabled_checks
// silences it.
async function checkControlPlaneGitignored(
  cwd: string,
  issues: DoctorIssue[],
): Promise<void> {
  // Only meaningful for a real, initialized project.
  if (!(await projectFileExists(cwd, ".code-pact/project.yaml"))) return;
  const ignoredAreas = await gitIgnoredControlPlaneAreas(cwd);
  if (ignoredAreas.length === 0) return; // none ignored, or git could not answer

  issues.push({
    code: "CONTROL_PLANE_GITIGNORED",
    severity: "warning",
    message:
      `The shared control plane is git-ignored — these areas will not reach git: ${ignoredAreas.join(", ")}. ` +
      "That state stays local: a clean checkout (a teammate, or CI) may be missing the project config, profiles, baselines, or the progress ledger. " +
      "If the ledger itself is ignored, CONTROL_PLANE_BRANCH_NOT_DRIVEN also silently skips — it has no tracked ledger to read. " +
      "A blanket `/.code-pact/` ignore (or a file-scoped rule like `state/events/*.yaml`) is the usual cause; keep only the local/derived subset ignored (`/.code-pact/locks/`, `/.code-pact/cache/`, `/.local/`, `/.context/`) and commit the rest (project.yaml, agent/model profiles, baselines, state/events/). " +
      "code-pact never edits existing .gitignore lines, so narrow the rule yourself, then re-run `code-pact doctor` to confirm. " +
      "Silence via .code-pact/doctor.yaml (disabled_checks: [CONTROL_PLANE_GITIGNORED]) if this repo is intentionally solo/throwaway.",
    recovery: {
      // A manual edit, not a runnable command — `manual_action`, not `primary`.
      manual_action:
        "Narrow .gitignore: remove the blanket `/.code-pact/` (or file-scoped) rule; keep only `/.code-pact/locks/`, `/.code-pact/cache/`, `/.local/`, `/.context/` ignored; commit project.yaml, agent-profiles/, model-profiles/, state/baselines/, and state/events/.",
      confirm: "code-pact doctor",
      reference:
        "docs/cli-contract.md § State file write guarantees (shared-vs-local table); silence via .code-pact/doctor.yaml (disabled_checks: [CONTROL_PLANE_GITIGNORED])",
    },
  });
}

// Reads the committed progress.yaml at a git revision. Returns:
//   - ProgressEvent[]  — present and parseable
//   - []               — absent at that revision (git show failed)
//   - null             — present but unparseable / schema-invalid
async function readProgressEventsAtRev(
  cwd: string,
  rev: string,
): Promise<ProgressEvent[] | null> {
  const res = await runGit(cwd, [
    "show",
    `${rev}:.code-pact/state/progress.yaml`,
  ]);
  if (!res.ok) return []; // absent at this revision
  let doc: unknown;
  try {
    doc = parseYaml(res.stdout);
  } catch {
    return null; // present but invalid YAML
  }
  const parsed = ProgressLog.safeParse(doc);
  if (!parsed.success) return null; // schema invalid
  return parsed.data.events;
}

// Reads the committed per-event files at a git revision. Returns:
//   - LoadedEventFile[] — validated event files present at that revision
//   - []                — none present at that revision
//   - null              — a committed event file is corrupt / breaks its invariant
async function readEventFilesAtRev(
  cwd: string,
  rev: string,
): Promise<LoadedEventFile[] | null> {
  const ls = await runGit(cwd, [
    "ls-tree",
    "-r",
    "--name-only",
    rev,
    ".code-pact/state/events/",
  ]);
  if (!ls.ok) return []; // no events tree at this revision
  const paths = ls.stdout
    .split("\n")
    .map(s => s.trim())
    .filter(p => p.length > 0 && parseEventFileName(basename(p)) !== null);
  const out: LoadedEventFile[] = [];
  for (const p of paths) {
    const show = await runGit(cwd, ["show", `${rev}:${p}`]);
    if (!show.ok) continue;
    try {
      out.push(validateEventFileContent(basename(p), show.stdout));
    } catch {
      return null; // corrupt committed event file
    }
  }
  return out;
}

// Reads the committed event packs at a git revision, binding each pack to the
// snapshot AT THAT REVISION (snapshot_sha256 / phase_id / task membership), so a
// corrupt/forged committed pack cannot enter the drift comparison as valid
// history. Returns:
//   - LoadedEventFile[] — events from packs that pass Tier-1 + rev-level binding
//   - []                — no packs at that revision
//   - null              — a committed pack is corrupt / fails rev-level binding
async function readEventPacksAtRev(
  cwd: string,
  rev: string,
  looseAtRev: readonly LoadedEventFile[],
): Promise<LoadedEventFile[] | null> {
  const ls = await runGit(cwd, [
    "ls-tree",
    "-r",
    "--name-only",
    rev,
    ".code-pact/state/archive/event-packs/",
  ]);
  if (!ls.ok) return []; // no packs tree at this revision
  const paths = ls.stdout
    .split("\n")
    .map(s => s.trim())
    .filter(p => p.length > 0 && p.endsWith(".json"));
  const looseById = new Map<string, LoadedEventFile>();
  for (const f of looseAtRev) looseById.set(f.id, f);
  const out: LoadedEventFile[] = [];
  for (const p of paths) {
    const fileStem = basename(p, ".json");
    const show = await runGit(cwd, ["show", `${rev}:${p}`]);
    if (!show.ok) continue;
    let loaded;
    try {
      loaded = validateEventPackTier1(fileStem, show.stdout, p);
    } catch {
      return null; // corrupt committed pack
    }
    // Rev-level binding: the snapshot at THIS revision must match the pack.
    const snapShow = await runGit(cwd, [
      "show",
      `${rev}:.code-pact/state/archive/phases/${fileStem}.json`,
    ]);
    if (!snapShow.ok) return null; // pack with no snapshot at the rev — unbound
    let snapshot;
    try {
      snapshot = PhaseSnapshot.parse(JSON.parse(snapShow.stdout) as unknown);
    } catch {
      return null; // corrupt committed snapshot at the rev
    }
    // FULL Tier-2 binding at the rev (identity + membership + evidence + semantic
    // replay) via the shared pure core — so the rev reader can never accept a pack
    // the workspace reader would reject (Finding C). loose ∪ ownPack at the rev.
    const issues = bindPackToSnapshot(
      loaded,
      snapshot,
      snapShow.stdout,
      looseById,
    );
    if (issues.length > 0) return null; // unbound/forged committed pack
    out.push(...loaded.entries);
  }
  return out;
}

// The merged committed ledger at a revision: legacy progress.yaml + per-event
// files + event packs (rev-bound). Reads the git OBJECT tree ONLY — never the
// workspace, so a dirty working tree cannot leak into the branch-diff. Applies
// the same LEGACY_EVENT_FOR_ARCHIVED_TASK exclusion at the rev so working-tree
// and git-rev readers treat archived-task legacy events identically. null when
// any source is unparseable / corrupt at that revision.
async function readMergedEventsAtRev(
  cwd: string,
  rev: string,
): Promise<ProgressEvent[] | null> {
  const legacy = await readProgressEventsAtRev(cwd, rev);
  if (legacy === null) return null;
  const events = await readEventFilesAtRev(cwd, rev);
  if (events === null) return null;
  const packs = await readEventPacksAtRev(cwd, rev, events);
  if (packs === null) return null;
  // Rev-level legacy-conflict exclusion, scoped to archived task_ids at the rev.
  const { ids: archivedTaskIds, complete } = await readArchivedTaskIdsAtRev(
    cwd,
    rev,
  );
  // FAIL CLOSED (the rev twin of the workspace gate): a corrupt snapshot at the
  // rev shrinks the archived-task set, so a committed legacy event for a
  // now-invisible archived task could slip through. With the set known-incomplete
  // and legacy events present at the rev, the committed ledger cannot be trusted
  // for the branch-drift comparison → skip (null), never accept it as valid.
  if (!complete && legacy.length > 0) return null;
  const durableIds = new Set<string>();
  for (const f of events) durableIds.add(f.id);
  for (const f of packs) durableIds.add(f.id);
  const mergeableLegacy = legacy.filter(e => {
    if (!archivedTaskIds.has(e.task_id)) return true;
    return durableIds.has(computeEventId(e));
  });
  return mergeProgressStreams(mergeableLegacy, [...events, ...packs]);
}

// The archived task_ids committed at a revision (snapshot task ids in the git
// tree at `rev`), plus `complete`: false when ANY committed snapshot was
// unreadable, so callers can fail closed rather than trust a shrunk set.
async function readArchivedTaskIdsAtRev(
  cwd: string,
  rev: string,
): Promise<{ ids: Set<string>; complete: boolean }> {
  const ids = new Set<string>();
  const ls = await runGit(cwd, [
    "ls-tree",
    "-r",
    "--name-only",
    rev,
    ".code-pact/state/archive/phases/",
  ]);
  // `ls-tree` non-zero = no archive/phases tree at this rev = zero archived
  // tasks, which is COMPLETE (an empty-but-known set), the normal never-archived
  // state. Incompleteness comes only from a snapshot file that EXISTS in the tree
  // but cannot be read/parsed (below).
  if (!ls.ok) return { ids, complete: true };
  const paths = ls.stdout
    .split("\n")
    .map(s => s.trim())
    .filter(p => p.length > 0 && p.endsWith(".json"));
  let complete = true;
  for (const p of paths) {
    const show = await runGit(cwd, ["show", `${rev}:${p}`]);
    if (!show.ok) {
      complete = false; // a snapshot we cannot read shrinks the set
      continue;
    }
    try {
      const snapshot = PhaseSnapshot.parse(JSON.parse(show.stdout) as unknown);
      for (const t of snapshot.tasks) ids.add(t.id);
    } catch {
      complete = false; // a corrupt committed snapshot shrinks the set
    }
  }
  return { ids, complete };
}

// A stable identity key for a progress event — the same content id the ledger
// uses everywhere, so two events that differ in any persisted field
// (evidence, reason, agent, …) are distinct. The ledger is append-only, so
// "added on the branch" = HEAD events whose id is absent at the base.
function eventKey(e: ProgressEvent): string {
  return computeEventId(e);
}

// Check 17: branch-diff control-plane drift, for PR CI. Advisory
// (warning). Runs ONLY when `--base-ref` is supplied. Fires when real,
// non-excluded files changed on the branch (merge-base..HEAD) but the branch
// added NO event that is a started/done for a KNOWN non-TUTORIAL task — i.e.
// code changed without driving the loop. Conservative skips: no git /
// unresolved merge-base / untracked progress.yaml / unparseable HEAD
// progress.yaml / only excluded paths changed.
async function checkControlPlaneBranchNotDriven(
  cwd: string,
  phases: Phase[],
  issues: DoctorIssue[],
  baseRef: string,
  excludeGlobs: string[],
): Promise<void> {
  // Gate 1: at least one non-TUTORIAL task; collect known task ids.
  const realTaskIds = new Set<string>();
  for (const p of phases) {
    if (p.id === "TUTORIAL") continue;
    for (const t of p.tasks ?? []) realTaskIds.add(t.id);
  }
  if (realTaskIds.size === 0) return;

  // Gate 2: branch diff (merge-base mode). Skip when git/merge-base unavailable.
  const audit = await auditWrites({ cwd, declaredWrites: [], baseRef });
  if (!audit.git_available || audit.base_kind !== "merge-base") return;

  // files_touched already excludes code-pact runtime state. Drop team-declared
  // exclude_globs (default empty). If nothing real remains → skip.
  const validExcludeGlobs = excludeGlobs.filter(
    g => validateGlobSyntax(g) === null,
  );
  const realChanged = audit.files_touched.filter(
    f => !validExcludeGlobs.some(g => matchGlob(g, f)),
  );
  if (realChanged.length === 0) return;

  // Gate 3: the committed ledger must be git-tracked — `progress.yaml`, the
  // per-event files, AND/OR the event packs. After compaction the loose events
  // are gone and the history lives in packs, so a repo whose entire ledger is in
  // packs still counts as tracked (else the gate silently skips post-compaction).
  const trackedLegacy = await runGit(cwd, [
    "ls-files",
    "--error-unmatch",
    ".code-pact/state/progress.yaml",
  ]);
  const trackedEvents = await runGit(cwd, [
    "ls-files",
    ".code-pact/state/events/",
  ]);
  const trackedEventPacks = await runGit(cwd, [
    "ls-files",
    ".code-pact/state/archive/event-packs/",
  ]);
  const ledgerTracked =
    trackedLegacy.ok ||
    (trackedEvents.ok && trackedEvents.stdout.trim().length > 0) ||
    (trackedEventPacks.ok && trackedEventPacks.stdout.trim().length > 0);
  if (!ledgerTracked) return;

  // Gate 4: did the branch ADD a started/done for a KNOWN non-TUTORIAL task?
  // Reads the committed git tree (legacy progress.yaml + per-event files) at
  // each revision — never the workspace.
  const mb = await runGit(cwd, ["merge-base", "HEAD", baseRef]);
  if (!mb.ok) return;
  const baseSha = mb.stdout.trim();
  const headEvents = await readMergedEventsAtRev(cwd, "HEAD");
  if (headEvents === null) return; // unparseable HEAD → INVALID_YAML/SCHEMA_ERROR owns it
  const baseEvents = await readMergedEventsAtRev(cwd, baseSha);
  // A corrupt/unparseable BASE ledger must NOT be treated as empty: that would
  // make every historical event look "added on the branch" and falsely satisfy
  // the gate. Can't compute the diff → skip.
  if (baseEvents === null) return;
  const baseKeys = new Set(baseEvents.map(eventKey));
  const driven = headEvents.some(
    e =>
      !baseKeys.has(eventKey(e)) &&
      (e.status === "started" || e.status === "done") &&
      !e.task_id.startsWith("TUTORIAL-") &&
      realTaskIds.has(e.task_id),
  );
  if (driven) return;

  issues.push({
    code: "CONTROL_PLANE_BRANCH_NOT_DRIVEN",
    severity: "warning",
    message:
      `This branch changed real files vs ${baseRef} but added no started/done event for a known non-TUTORIAL task in the committed ledger (state/events/**, state/archive/event-packs/**, and legacy progress.yaml) — code changed without driving the control plane. ` +
      'Drive a task with `code-pact task prepare <id> --agent <agent>` (or record out-of-loop work with `code-pact task record-done <id> --evidence "..."`) and commit the new event file(s) under .code-pact/state/events/. ' +
      "Exempt docs/config-only paths via .code-pact/doctor.yaml (control_plane_branch_not_driven.exclude_globs), or silence via disabled_checks: [CONTROL_PLANE_BRANCH_NOT_DRIVEN].",
    recovery: {
      primary: "code-pact task prepare <id> --agent <agent>",
      alternatives: ['code-pact task record-done <id> --evidence "..."'],
      reference:
        ".code-pact/doctor.yaml (control_plane_branch_not_driven.exclude_globs to exempt paths; disabled_checks: [CONTROL_PLANE_BRANCH_NOT_DRIVEN] to silence)",
    },
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export type RunDoctorOptions = {
  /** Branch base ref for the CI branch-drift check. When omitted,
   * CONTROL_PLANE_BRANCH_NOT_DRIVEN does not run. */
  baseRef?: string;
};

export async function runDoctor(
  cwd: string,
  opts: RunDoctorOptions = {},
): Promise<DoctorResult> {
  const allIssues: DoctorIssue[] = [];
  const config = await loadDoctorConfig(cwd);
  const disabled = new Set(config.disabled_checks);

  // 1. project.yaml
  const project = await checkProjectYaml(cwd, allIssues);

  // 2. roadmap.yaml
  const roadmap = await checkRoadmap(cwd, allIssues);

  // 3. phase files (requires roadmap)
  const { phases, phaseEntries, archivedKnownTaskIds } = roadmap
    ? await checkPhases(cwd, roadmap, allIssues)
    : {
        phases: [] as Phase[],
        phaseEntries: [] as PhaseEntry[],
        archivedKnownTaskIds: new Set<string>(),
      };

  // 4. progress.yaml (requires phases + archived ids for the orphan check)
  await checkProgressLog(cwd, phases, archivedKnownTaskIds, allIssues);

  // 4b. archived-snapshot evidence: every progress_events event_id must resolve
  // from the durable ledger (loose ∪ validated packs). Closes the silent
  // provenance-loss gap. So `validate` (which delegates here) enforces it too.
  await checkSnapshotEventEvidence(cwd, allIssues);

  // 5. agent profiles + model_map completeness (requires project)
  if (project) {
    await checkAgentProfiles(cwd, project, allIssues);
  }

  // 6. model profiles
  await checkModelProfiles(cwd, allIssues);

  // 7. .bak files
  await checkBakFiles(cwd, allIssues);

  // 8. stale generated context (requires phases + project)
  if (project) {
    await checkStaleContext(cwd, phases, project, allIssues);
  }

  // 9. duplicate phase/task ids across the roadmap
  checkDuplicateIds(phaseEntries, allIssues);

  // 10. .local/ gitignored
  await checkLocalGitignored(cwd, allIssues);

  // 11. enabled agents have adapter instruction files (legacy, no-manifest only)
  if (project) {
    await checkAdapterMissing(cwd, project, allIssues);
  }

  // 11b. manifest-aware adapter health (only when manifest exists)
  if (project) {
    await checkAdapterManifestAware(cwd, project, allIssues);
  }

  // 12. design/brief.md present (only once a real phase exists)
  await checkBriefMissing(cwd, phases, allIssues);

  // 13. constitution.md is not the unedited template (only once a real phase exists)
  await checkConstitutionPlaceholder(cwd, phases, allIssues);

  // 14. phase objectives are non-trivial
  checkEmptyObjectives(phases, allIssues);

  // 15. enabled agents have model_version set
  if (project) {
    await checkAdapterStale(cwd, project, allIssues);
  }

  // 16. control plane scaffolded but not driven. Guarded so a
  // disabled advisory never spawns git; the trailing filter still covers it.
  if (!disabled.has("CONTROL_PLANE_NOT_DRIVEN")) {
    await checkControlPlaneNotDriven(cwd, phases, allIssues);
  }

  // 17. branch-diff control-plane drift. Runs only when --base-ref is
  // given (CI). Guarded so a disabled advisory never spawns git.
  if (
    opts.baseRef !== undefined &&
    !disabled.has("CONTROL_PLANE_BRANCH_NOT_DRIVEN")
  ) {
    await checkControlPlaneBranchNotDriven(
      cwd,
      phases,
      allIssues,
      opts.baseRef,
      config.control_plane_branch_not_driven?.exclude_globs ?? [],
    );
  }

  // 18. shared control plane git-ignored. Guarded so a disabled advisory
  // never spawns git.
  if (!disabled.has("CONTROL_PLANE_GITIGNORED")) {
    await checkControlPlaneGitignored(cwd, allIssues);
  }

  // Apply disabled_checks filter
  const issues =
    disabled.size > 0
      ? allIssues.filter(i => !disabled.has(i.code))
      : allIssues;

  const ok = issues.every(i => i.severity !== "error");
  return { ok, issues };
}

// ---------------------------------------------------------------------------
// Human-readable formatter
// ---------------------------------------------------------------------------

export function formatDoctor(result: DoctorResult): string {
  if (result.issues.length === 0) {
    return "No issues found. Project is healthy.";
  }
  const lines = result.issues.map(i => {
    const mark = i.severity === "error" ? "[error]" : "[warn] ";
    return `  ${mark} ${i.code}: ${i.message}`;
  });
  const summary = result.ok
    ? `${result.issues.length} warning(s) found.`
    : `${result.issues.filter(i => i.severity === "error").length} error(s), ${result.issues.filter(i => i.severity === "warning").length} warning(s) found.`;
  return [summary, ...lines].join("\n");
}
