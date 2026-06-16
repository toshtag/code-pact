import { readFile, readdir } from "node:fs/promises";
import { basename } from "node:path";
import { parse as parseYaml } from "yaml";
import { Phase } from "../schemas/phase.ts";
import { PhaseSnapshot } from "../schemas/phase-snapshot.ts";
import { DecisionStateRecord } from "../schemas/decision-state-record.ts";
import { loadRoadmap } from "../plan/roadmap.ts";
import { resolveWithinProject } from "../path-safety.ts";
import { loadArchiveBundles } from "./archive-bundle-loader.ts";
import { enumerateArchivedPhaseSnapshots } from "./load-phase-snapshot.ts";
import { archiveDecisionsDir, archiveEventPacksDir, archivePhasesDir, normalizeDecisionRef } from "./paths.ts";
import type { ArchiveBundleKind } from "../schemas/archive-bundle.ts";

// ---------------------------------------------------------------------------
// Archive RETENTION planner (keep-latest N) — the CONSERVATIVE, NON-destructive
// foundation. It bounds the archive's UNREFERENCED tail: a record still referenced
// by the live project graph (a roadmap phase, a live task `depends_on` an archived
// task id, a live task `decision_refs` / `acceptance_refs`) is ALWAYS kept (blocked),
// regardless of age — so dropping never breaks a surviving reader. keep-latest N is
// applied PER KIND to the UNREFERENCED pool only (referenced/blocked records are NOT
// counted in N); of the unreferenced, the latest N (by `snapshotted_at`) are kept and
// the older dropped. event_pack is DEPENDENT: a pack drops only with its phase snapshot.
//
// THE PLANNER IS THE DELETE AUTHORITY (the destructive write layer consumes this exact
// plan), so it is held to destructive rigor: a record the planner cannot fully reason
// about — invalid bytes, an unreadable store, a failed reference scan, an ambiguous
// task-id collision — is `blocked`, NEVER silently treated as unreferenced-and-droppable.
// A missing/unparseable roadmap (the live reference set is then unknown) blocks ALL
// phase retention fail-closed, never "everything looks unreferenced".
//
// This bounds `.code-pact/state/archive` ONLY. It NEVER touches a live `design/` doc.
// ---------------------------------------------------------------------------

export const DEFAULT_KEEP_LATEST = 20;

export type RetentionReferenceType = "roadmap_phase" | "task_depends_on" | "decision_ref" | "acceptance_ref";
export type RetentionReference = { type: RetentionReferenceType; from: string; to: string };

export type RetentionAction = "would_keep" | "would_drop" | "blocked";
export type RetentionReason =
  | "within_keep_latest"
  | "older_than_keep_latest"
  | "referenced_by_roadmap"
  | "referenced_by_live_task_dependency"
  | "referenced_by_decision_link"
  | "dependent_on_kept_phase_snapshot"
  | "invalid"
  | "ambiguous"
  | "reference_scan_failed";

export type RetentionItem = {
  kind: ArchiveBundleKind;
  id: string;
  /** ISO `snapshotted_at`; null only for an `invalid` record we could not parse. */
  snapshotted_at: string | null;
  source: "loose" | "bundle" | "both";
  action: RetentionAction;
  reason: RetentionReason;
  /** WHY a record is referenced/kept — so a user can answer "why isn't this dropped?". */
  references?: RetentionReference[];
};

export type RetentionPlan = {
  kind: ArchiveBundleKind;
  would_keep: RetentionItem[];
  would_drop: RetentionItem[];
  blocked: RetentionItem[];
};

export class RetentionConfigError extends Error {
  readonly code = "CONFIG_ERROR";
  constructor(message: string) {
    super(message);
    this.name = "RetentionConfigError";
  }
}

/** Validate keep-latest N: an integer ≥ 1 (0 = "drop all unreferenced" needs a future
 *  explicit opt-in; a non-integer / negative is a config error). */
export function resolveKeepLatest(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_KEEP_LATEST;
  if (!/^\d+$/.test(raw)) throw new RetentionConfigError(`--keep-latest must be a positive integer (≥ 1), got "${raw}"`);
  const n = Number(raw);
  if (n < 1) {
    throw new RetentionConfigError(
      "--keep-latest must be ≥ 1 (dropping ALL unreferenced records is not yet supported)",
    );
  }
  return n;
}

// --- the live reference graph (the gate's authority) -------------------------

type LiveGraph = {
  roadmapPhaseIds: ReadonlySet<string>;
  /** archived-or-live task id depended-on → the live task ids that depend on it. */
  dependsOn: ReadonlyMap<string, string[]>;
  /** normalized decision canonical-ref → the live task references that point at it. */
  decisionRefs: ReadonlyMap<string, RetentionReference[]>;
};

type LiveGraphResult = { ok: true; graph: LiveGraph } | { ok: false; detail: string };

function pushTo<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const arr = m.get(k);
  if (arr) arr.push(v);
  else m.set(k, [v]);
}

/**
 * Build the live reference graph from the roadmap + the live phase YAMLs. FAIL-CLOSED:
 * a missing/unparseable roadmap, or a phase YAML that exists but cannot be read/parsed,
 * returns `{ ok: false }` so the caller blocks retention rather than guessing. A roadmap
 * phase whose YAML is ENOENT is the ARCHIVED case (its tasks are no longer a live
 * reference source) — skipped, not a failure.
 */
async function buildLiveGraph(cwd: string): Promise<LiveGraphResult> {
  let roadmap;
  try {
    roadmap = await loadRoadmap(cwd);
  } catch (err) {
    return { ok: false, detail: `roadmap unreadable: ${(err as Error).message}` };
  }
  const roadmapPhaseIds = new Set(roadmap.phases.map((p) => p.id));
  const dependsOn = new Map<string, string[]>();
  const decisionRefs = new Map<string, RetentionReference[]>();

  for (const p of roadmap.phases) {
    let raw: string;
    try {
      raw = await readFile(await resolveWithinProject(cwd, p.path), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; // archived phase — not a live ref source
      return { ok: false, detail: `live phase "${p.id}" (${p.path}) unreadable: ${(err as Error).message}` };
    }
    let phase;
    try {
      phase = Phase.parse(parseYaml(raw));
    } catch (err) {
      return { ok: false, detail: `live phase "${p.id}" (${p.path}) invalid: ${(err as Error).message}` };
    }
    for (const t of phase.tasks ?? []) {
      for (const dep of t.depends_on ?? []) pushTo(dependsOn, dep, t.id);
      for (const ref of t.decision_refs ?? []) {
        pushTo(decisionRefs, normalizeDecisionRef(ref) ?? ref, { type: "decision_ref", from: t.id, to: ref });
      }
      for (const ref of t.acceptance_refs ?? []) {
        pushTo(decisionRefs, normalizeDecisionRef(ref) ?? ref, { type: "acceptance_ref", from: t.id, to: ref });
      }
    }
  }
  return { ok: true, graph: { roadmapPhaseIds, dependsOn, decisionRefs } };
}

// --- per-kind loose ∪ bundle source map --------------------------------------

type SourceMap = ReadonlyMap<string, "loose" | "bundle" | "both">;
type SourceResult = { ok: true; source: SourceMap } | { ok: false; detail: string };

function looseDirFor(cwd: string, kind: ArchiveBundleKind): string {
  return kind === "phase_snapshot"
    ? archivePhasesDir(cwd)
    : kind === "event_pack"
      ? archiveEventPacksDir(cwd)
      : archiveDecisionsDir(cwd);
}

/** Map every record id of `kind` to whether it lives loose-only / bundle-only / both.
 *  Loads the bundle store STRICT — a corrupt store is a fail-closed `{ ok: false }`
 *  (the planner must not under-count members and mis-rank/mis-drop). */
async function buildSourceMap(cwd: string, kind: ArchiveBundleKind): Promise<SourceResult> {
  let bundleIds: Set<string>;
  try {
    bundleIds = new Set(loadArchiveBundles(cwd).index.get(kind)?.keys() ?? []);
  } catch (err) {
    return { ok: false, detail: `bundle store unreadable: ${(err as Error).message}` };
  }
  let looseIds: string[];
  try {
    looseIds = (await readdir(looseDirFor(cwd, kind))).filter((n) => n.endsWith(".json")).map((n) => basename(n, ".json"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") looseIds = [];
    else return { ok: false, detail: `loose ${kind} dir unreadable: ${(err as Error).message}` };
  }
  const looseSet = new Set(looseIds);
  const source = new Map<string, "loose" | "bundle" | "both">();
  for (const id of looseSet) source.set(id, bundleIds.has(id) ? "both" : "loose");
  for (const id of bundleIds) if (!looseSet.has(id)) source.set(id, "bundle");
  return { ok: true, source };
}

// --- keep-latest partition (the shared selection) ----------------------------

/** Partition unreferenced items by keep-latest N: sort by snapshotted_at DESC then id
 *  ASC (deterministic), keep the first N, drop the rest. */
function applyKeepLatest(unreferenced: RetentionItem[], keepLatest: number): void {
  unreferenced.sort((a, b) => {
    const at = a.snapshotted_at ?? "";
    const bt = b.snapshotted_at ?? "";
    if (at !== bt) return at < bt ? 1 : -1; // DESC (newest first)
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; // tie-break id ASC
  });
  unreferenced.forEach((item, i) => {
    if (i < keepLatest) {
      item.action = "would_keep";
      item.reason = "within_keep_latest";
    } else {
      item.action = "would_drop";
      item.reason = "older_than_keep_latest";
    }
  });
}

function partition(kind: ArchiveBundleKind, items: RetentionItem[]): RetentionPlan {
  return {
    kind,
    would_keep: items.filter((i) => i.action === "would_keep"),
    would_drop: items.filter((i) => i.action === "would_drop"),
    blocked: items.filter((i) => i.action === "blocked"),
  };
}

// --- phase_snapshot retention -------------------------------------------------

/** The per-phase decision (so event_pack can follow its parent). */
type PhaseVerdict = ReadonlyMap<string, RetentionAction>;

async function planPhaseRetention(
  cwd: string,
  keepLatest: number,
  live: LiveGraphResult,
  source: SourceResult,
): Promise<{ plan: RetentionPlan; verdict: PhaseVerdict }> {
  const items: RetentionItem[] = [];
  const verdict = new Map<string, RetentionAction>();
  const srcOf = (id: string): "loose" | "bundle" | "both" => (source.ok ? source.source.get(id) ?? "loose" : "loose");

  const { entries, skipped } = await enumerateArchivedPhaseSnapshots(cwd);
  // A DIRECTORY/STORE-level enumeration skip (loose dir or bundle store unreadable) OR a
  // corrupt bundle SOURCE means the enumeration is INCOMPLETE — bundle-only snapshots may be
  // invisible, so any "unreferenced" verdict is on a PARTIAL view. Fail closed: every record
  // is then `blocked` (never ranked/dropped). A per-FILE skip is a single-record fault only.
  const storeFailed = !source.ok || skipped.some((sk) => sk.scope === "directory");
  for (const sk of skipped) {
    const id = sk.scope === "file" ? sk.fileStem : "(store)";
    const reason: RetentionReason = sk.scope === "file" ? "invalid" : "reference_scan_failed";
    items.push({ kind: "phase_snapshot", id, snapshotted_at: null, source: srcOf(id), action: "blocked", reason });
  }
  if (!source.ok) {
    items.push({ kind: "phase_snapshot", id: "(store)", snapshotted_at: null, source: "loose", action: "blocked", reason: "reference_scan_failed" });
  }

  // Collect valid snapshots; build taskId → owning phase ids for ambiguity detection.
  const valid: { phaseId: string; snapshot: PhaseSnapshot }[] = [];
  const taskToPhases = new Map<string, string[]>();
  for (const { fileStem, res } of entries) {
    if (res.kind === "valid") {
      valid.push({ phaseId: fileStem, snapshot: res.snapshot });
      for (const t of res.snapshot.tasks) pushTo(taskToPhases, t.id, fileStem);
    } else if (res.kind === "invalid") {
      items.push({ kind: "phase_snapshot", id: fileStem, snapshotted_at: null, source: srcOf(fileStem), action: "blocked", reason: "invalid" });
    }
    // res.kind === "absent" cannot occur from enumeration (only present entries).
  }
  const ambiguous = new Set<string>();
  for (const [, phases] of taskToPhases) if (phases.length > 1) for (const ph of phases) ambiguous.add(ph);

  const unreferenced: RetentionItem[] = [];
  for (const { phaseId, snapshot } of valid) {
    const base = { kind: "phase_snapshot" as const, id: phaseId, snapshotted_at: snapshot.snapshotted_at, source: srcOf(phaseId) };
    // Fail-closed: the live graph could not be built, OR the archive enumeration was a
    // partial view (store/source unreadable) → cannot prove this record is unreferenced.
    if (!live.ok || storeFailed) {
      items.push({ ...base, action: "blocked", reason: "reference_scan_failed" });
      continue;
    }
    // A task-id collision across archived snapshots → cannot attribute a depends_on safely.
    if (ambiguous.has(phaseId)) {
      items.push({ ...base, action: "blocked", reason: "ambiguous" });
      continue;
    }
    // Referenced by the live roadmap.
    if (live.graph.roadmapPhaseIds.has(snapshot.phase_id)) {
      items.push({ ...base, action: "blocked", reason: "referenced_by_roadmap", references: [{ type: "roadmap_phase", from: "roadmap", to: snapshot.phase_id }] });
      continue;
    }
    // Referenced by a live task that depends_on one of this snapshot's archived task ids.
    const depRefs: RetentionReference[] = [];
    for (const t of snapshot.tasks) {
      for (const from of live.graph.dependsOn.get(t.id) ?? []) depRefs.push({ type: "task_depends_on", from, to: t.id });
    }
    if (depRefs.length > 0) {
      items.push({ ...base, action: "blocked", reason: "referenced_by_live_task_dependency", references: depRefs });
      continue;
    }
    // Unreferenced → subject to keep-latest N.
    unreferenced.push({ ...base, action: "blocked", reason: "older_than_keep_latest" });
  }
  applyKeepLatest(unreferenced, keepLatest);
  items.push(...unreferenced);

  for (const item of items) verdict.set(item.id, item.action);
  return { plan: partition("phase_snapshot", items), verdict };
}

// --- decision_record retention -----------------------------------------------

async function enumerateArchivedDecisions(
  cwd: string,
): Promise<{ records: { id: string; record: DecisionStateRecord }[]; invalid: string[]; storeError: string | null }> {
  const records: { id: string; record: DecisionStateRecord }[] = [];
  const invalid: string[] = [];
  let bundleMembers: ReadonlyMap<string, { bytes: string }>;
  let storeError: string | null = null;
  try {
    bundleMembers = loadArchiveBundles(cwd).index.get("decision_record") ?? new Map();
  } catch (err) {
    return { records: [], invalid: [], storeError: `bundle store unreadable: ${(err as Error).message}` };
  }
  const seen = new Set<string>();
  // Loose decisions win over bundle members (reader-loose-wins).
  let looseNames: string[];
  try {
    looseNames = (await readdir(archiveDecisionsDir(cwd))).filter((n) => n.endsWith(".json"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") looseNames = [];
    else return { records: [], invalid: [], storeError: `loose decisions dir unreadable: ${(err as Error).message}` };
  }
  const parseInto = (id: string, bytes: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    try {
      records.push({ id, record: DecisionStateRecord.parse(JSON.parse(bytes)) });
    } catch {
      invalid.push(id);
    }
  };
  for (const name of looseNames.sort()) {
    const id = basename(name, ".json");
    try {
      parseInto(id, await readFile(await resolveWithinProject(cwd, `.code-pact/state/archive/decisions/${name}`), "utf8"));
    } catch {
      invalid.push(id);
      seen.add(id);
    }
  }
  for (const [id, m] of bundleMembers) parseInto(id, m.bytes);
  return { records, invalid, storeError };
}

async function planDecisionRetention(
  cwd: string,
  keepLatest: number,
  live: LiveGraphResult,
  source: SourceResult,
): Promise<RetentionPlan> {
  const items: RetentionItem[] = [];
  const srcOf = (id: string): "loose" | "bundle" | "both" => (source.ok ? source.source.get(id) ?? "loose" : "loose");
  const { records, invalid, storeError } = await enumerateArchivedDecisions(cwd);

  for (const id of invalid) {
    items.push({ kind: "decision_record", id, snapshotted_at: null, source: srcOf(id), action: "blocked", reason: "invalid" });
  }
  // A store-read failure (bundle store / loose dir) means a PARTIAL view → block EVERY record
  // fail-closed, never rank/drop on it (defends against any future enumerator that returns
  // records alongside a storeError).
  const storeFailed = storeError !== null || !source.ok;
  if (storeFailed) {
    items.push({ kind: "decision_record", id: "(store)", snapshotted_at: null, source: "loose", action: "blocked", reason: storeError ? "invalid" : "reference_scan_failed" });
  }

  const unreferenced: RetentionItem[] = [];
  for (const { id, record } of records) {
    const base = { kind: "decision_record" as const, id, snapshotted_at: record.snapshotted_at, source: srcOf(id) };
    if (!live.ok || storeFailed) {
      items.push({ ...base, action: "blocked", reason: "reference_scan_failed" });
      continue;
    }
    const refs = live.graph.decisionRefs.get(record.canonical_ref);
    if (refs && refs.length > 0) {
      items.push({ ...base, action: "blocked", reason: "referenced_by_decision_link", references: refs });
      continue;
    }
    unreferenced.push({ ...base, action: "blocked", reason: "older_than_keep_latest" });
  }
  applyKeepLatest(unreferenced, keepLatest);
  items.push(...unreferenced);
  return partition("decision_record", items);
}

// --- event_pack retention (DEPENDENT on its phase snapshot) -------------------

async function planEventPackRetention(
  cwd: string,
  source: SourceResult,
  phaseVerdict: PhaseVerdict,
): Promise<RetentionPlan> {
  const items: RetentionItem[] = [];
  const srcOf = (id: string): "loose" | "bundle" | "both" => (source.ok ? source.source.get(id) ?? "loose" : "loose");

  // Enumerate pack ids = loose ∪ bundle (the stem is the phase id). A store read failure
  // is fail-closed: a single blocked diagnostic, no pack dropped on a partial view.
  let packIds: Set<string>;
  try {
    const looseNames = await readdir(archiveEventPacksDir(cwd)).catch((err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [] as string[];
      throw err;
    });
    const bundleIds = loadArchiveBundles(cwd).index.get("event_pack")?.keys() ?? [];
    packIds = new Set([...looseNames.filter((n) => n.endsWith(".json")).map((n) => basename(n, ".json")), ...bundleIds]);
  } catch {
    return partition("event_pack", [
      { kind: "event_pack", id: "(store)", snapshotted_at: null, source: "loose", action: "blocked", reason: "invalid" },
    ]);
  }

  for (const id of packIds) {
    const parent = phaseVerdict.get(id);
    const base = { kind: "event_pack" as const, id, snapshotted_at: null, source: srcOf(id) };
    if (parent === "would_drop") {
      // Drops as a dependent of its phase snapshot (which aged out of keep-latest).
      items.push({ ...base, action: "would_drop", reason: "older_than_keep_latest" });
    } else if (parent === undefined) {
      // ORPHAN: no phase snapshot for this pack id — an anomaly, NOT "dependent on a kept
      // snapshot". Keep it (never drop a pack whose parent we cannot locate).
      items.push({ ...base, action: "blocked", reason: "invalid" });
    } else {
      // Parent kept (would_keep) or blocked → the pack is kept with it.
      items.push({ ...base, action: "blocked", reason: "dependent_on_kept_phase_snapshot" });
    }
  }
  return partition("event_pack", items);
}

// --- orchestrator -------------------------------------------------------------

/**
 * Plan keep-latest-N retention across all archive kinds (READ-ONLY). The conservative
 * model: referenced records are always blocked (kept) regardless of age; of the
 * unreferenced, the latest N per kind are kept and older dropped; event_pack follows
 * its phase snapshot. Every record the planner cannot reason about is blocked, never
 * silently dropped — so this plan is a safe authority for the destructive write layer.
 */
export async function planArchiveRetention(
  cwd: string,
  opts: { keepLatest?: number } = {},
): Promise<RetentionPlan[]> {
  const keepLatest = opts.keepLatest ?? DEFAULT_KEEP_LATEST;
  const live = await buildLiveGraph(cwd);
  const phaseSource = await buildSourceMap(cwd, "phase_snapshot");
  const decisionSource = await buildSourceMap(cwd, "decision_record");
  const eventSource = await buildSourceMap(cwd, "event_pack");

  const { plan: phasePlan, verdict } = await planPhaseRetention(cwd, keepLatest, live, phaseSource);
  const decisionPlan = await planDecisionRetention(cwd, keepLatest, live, decisionSource);
  const eventPlan = await planEventPackRetention(cwd, eventSource, verdict);

  return [phasePlan, eventPlan, decisionPlan];
}
