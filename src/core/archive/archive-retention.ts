import { readFile, readdir, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { Phase } from "../schemas/phase.ts";
import { PhaseSnapshot } from "../schemas/phase-snapshot.ts";
import { DecisionStateRecord } from "../schemas/decision-state-record.ts";
import { loadRoadmap } from "../plan/roadmap.ts";
import { resolveWithinProject } from "../path-safety.ts";
import { ARCHIVE_DECISIONS_DIR_SEGMENTS, ARCHIVE_EVENT_PACKS_DIR_SEGMENTS, ARCHIVE_PHASES_DIR_SEGMENTS } from "./paths.ts";
import { loadArchiveBundles } from "./archive-bundle-loader.ts";
import { enumerateArchivedPhaseSnapshots, resolveUnreferencedSnapshot } from "./load-phase-snapshot.ts";
import { bindBundleMember, decisionRecordStem } from "./archive-bundle-binding.ts";
import { validateEventPackTier1 } from "./event-pack-reader.ts";
import { DeleteIntentDurabilityError, readPendingDeleteIds, recoverPendingDeletes } from "./delete-intent-journal.ts";
import { deleteLoosePairsJournaled, type LoosePairToDelete, type PairRetainReason } from "./retention-pair-delete.ts";
import { archiveDecisionsDir, archiveEventPacksDir, archivePhasesDir, normalizeDecisionRef, sha256Hex } from "./paths.ts";
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

const ARCHIVE_EVENT_PACK_LABEL = ".code-pact/state/archive/event-packs";

/** The id the planner emits for a STORE-level (not per-record) fault — a `would_drop`-blocking
 *  diagnostic standing in for "the whole store view was partial, so no record is droppable".
 *  Shared so the destructive apply can recognise a partial event_pack store and fail closed
 *  (never delete a phase snapshot whose dependent pack we could not even enumerate). */
const STORE_BLOCK_ID = "(store)";

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
  | "bundle_stale"
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
  /** sha256 of the loose copy's raw bytes the plan decided on (loose / both records). The
   *  destructive apply's gate confirms the on-disk bytes still match this before unlinking, so
   *  a loose file swapped (even to another valid record) since the plan is not deleted. */
  loose_sha256?: string;
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

/** Assert keep-latest N is an integer ≥ 1 (0 = "drop all unreferenced" needs a future
 *  explicit opt-in). The SINGLE validator both the CLI and the core planner go through, so
 *  a direct `planArchiveRetention(cwd, { keepLatest: 0 })` (the future delete authority)
 *  cannot bypass the bound. */
export function assertKeepLatest(n: number): number {
  if (!Number.isInteger(n) || n < 1) {
    throw new RetentionConfigError(
      `keep-latest must be a positive integer (≥ 1), got ${n} (dropping ALL unreferenced records is not yet supported)`,
    );
  }
  return n;
}

/** Parse + validate the CLI `--keep-latest` value (a non-negative integer string ≥ 1). */
export function resolveKeepLatest(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_KEEP_LATEST;
  if (!/^\d+$/.test(raw)) throw new RetentionConfigError(`--keep-latest must be a positive integer (≥ 1), got "${raw}"`);
  return assertKeepLatest(Number(raw));
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
type SourceResult =
  | {
      ok: true;
      source: SourceMap;
      /** ids present in BOTH loose and a bundle whose two raw copies DIVERGE (not byte-
       *  identical, or the loose unreadable). A retention DELETE removes BOTH physical copies
       *  of a `both` record, so a divergent shadow is unsafe to delete on a loose-wins view —
       *  these are blocked `bundle_stale` (reconcile via compaction/supersession first). */
      divergedBoth: ReadonlySet<string>;
      /** sha256 of each loose record's raw bytes AT PLAN TIME — the gate confirms the on-disk
       *  bytes still match before deleting, so a loose file swapped (even to another VALID
       *  record) between plan and unlink is NOT deleted on the stale verdict. */
      looseSha256: ReadonlyMap<string, string>;
    }
  | { ok: false; detail: string };

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
  let members: ReadonlyMap<string, { sha256: string; bytes: string }>;
  try {
    members = loadArchiveBundles(cwd).index.get(kind) ?? new Map();
  } catch (err) {
    return { ok: false, detail: `bundle store unreadable: ${(err as Error).message}` };
  }
  // A phase_snapshot / event_pack named in a pending delete-intent is mid-deletion —
  // already being dropped — so the planner treats it as LOGICALLY ABSENT (never
  // counts it in the source map, never re-plans its drop). Keeps the dry-run plan
  // consistent with the journal-aware readers. (Decisions are never pending.)
  const pendingAbsentIds = kind === "decision_record" ? new Set<string>() : await readPendingDeleteIds(cwd);
  let looseIds: string[];
  try {
    looseIds = (await readdir(looseDirFor(cwd, kind)))
      .filter((n) => n.endsWith(".json"))
      .map((n) => basename(n, ".json"))
      .filter((id) => !pendingAbsentIds.has(id));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") looseIds = [];
    else return { ok: false, detail: `loose ${kind} dir unreadable: ${(err as Error).message}` };
  }
  const looseSet = new Set(looseIds);
  const source = new Map<string, "loose" | "bundle" | "both">();
  for (const id of looseSet) source.set(id, members.has(id) ? "both" : "loose");
  for (const id of members.keys()) if (!looseSet.has(id) && !pendingAbsentIds.has(id)) source.set(id, "bundle");

  // Read every loose record's raw ONCE: record its digest (the gate's expected-bytes authority)
  // and, for a `both` id, STRICT-RECONCILE against the shadowed bundle member (byte-identical
  // else divergedBoth → blocked bundle_stale, since a delete removes both physical copies).
  const looseSha256 = new Map<string, string>();
  const divergedBoth = new Set<string>();
  for (const [id, src] of source) {
    if (src === "bundle") continue; // no loose copy
    let looseRaw: string | null = null;
    try {
      looseRaw = await readFile(join(looseDirFor(cwd, kind), `${id}.json`), "utf8");
    } catch {
      looseRaw = null;
    }
    if (looseRaw === null) {
      if (src === "both") divergedBoth.add(id); // can't reconcile a shadow we can't read
      continue;
    }
    looseSha256.set(id, sha256Hex(looseRaw));
    if (src === "both" && looseRaw !== members.get(id)!.bytes) divergedBoth.add(id);
  }
  return { ok: true, source, divergedBoth, looseSha256 };
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
    const id = sk.scope === "file" ? sk.fileStem : STORE_BLOCK_ID;
    const reason: RetentionReason = sk.scope === "file" ? "invalid" : "reference_scan_failed";
    items.push({ kind: "phase_snapshot", id, snapshotted_at: null, source: srcOf(id), action: "blocked", reason });
  }
  if (!source.ok) {
    items.push({ kind: "phase_snapshot", id: STORE_BLOCK_ID, snapshotted_at: null, source: "loose", action: "blocked", reason: "reference_scan_failed" });
  }

  // Collect AUTHORITY-valid snapshots; build taskId → owning phase ids for ambiguity. A
  // schema-valid record is NOT enough for a delete authority — resolveUnreferencedSnapshot
  // re-checks archive identity (phase_id === filename, path_sha256 covers original_path,
  // terminal status). An authority-invalid record is `blocked: invalid`, NEVER ranked/dropped
  // (a misfiled `P1.json` whose body is P2 must not be droppable just because the roadmap
  // lists P2). Identity is checked BEFORE any roadmap/dependency classification.
  const valid: { phaseId: string; snapshot: PhaseSnapshot }[] = [];
  const taskToPhases = new Map<string, string[]>();
  for (const { fileStem, res } of entries) {
    const resolved = resolveUnreferencedSnapshot(fileStem, res);
    if (resolved.kind === "tolerated") {
      valid.push({ phaseId: fileStem, snapshot: resolved.snapshot });
      for (const t of resolved.snapshot.tasks) pushTo(taskToPhases, t.id, fileStem);
    } else {
      items.push({ kind: "phase_snapshot", id: fileStem, snapshotted_at: null, source: srcOf(fileStem), action: "blocked", reason: "invalid" });
    }
  }
  const ambiguous = new Set<string>();
  for (const [, phases] of taskToPhases) if (phases.length > 1) for (const ph of phases) ambiguous.add(ph);

  const unreferenced: RetentionItem[] = [];
  const shaOf = (id: string): string | undefined => (source.ok ? source.looseSha256.get(id) : undefined);
  for (const { phaseId, snapshot } of valid) {
    const base = {
      kind: "phase_snapshot" as const,
      id: phaseId,
      snapshotted_at: snapshot.snapshotted_at,
      source: srcOf(phaseId),
      loose_sha256: shaOf(phaseId),
    };
    // Fail-closed: the live graph could not be built, OR the archive enumeration was a
    // partial view (store/source unreadable) → cannot prove this record is unreferenced.
    if (!live.ok || storeFailed) {
      items.push({ ...base, action: "blocked", reason: "reference_scan_failed" });
      continue;
    }
    // A `both` record whose loose and shadowed bundle copies DIVERGE is unsafe to delete
    // (a delete removes both physical copies) → blocked bundle_stale, never ranked.
    if (source.ok && source.divergedBoth.has(phaseId)) {
      items.push({ ...base, action: "blocked", reason: "bundle_stale" });
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
    let record: DecisionStateRecord;
    try {
      record = DecisionStateRecord.parse(JSON.parse(bytes));
    } catch {
      invalid.push(id);
      return;
    }
    // Authority identity (NOT just schema): the record must be FOR this file id, and its
    // path_sha256 must cover its own canonical_ref. A schema-valid record whose id /
    // canonical_ref / path_sha256 disagree is a misfiled/forged artifact → invalid, never
    // ranked/dropped.
    if (
      id !== decisionRecordStem(record.canonical_ref) ||
      record.original_path !== record.canonical_ref ||
      record.path_sha256 !== sha256Hex(record.canonical_ref)
    ) {
      invalid.push(id);
      return;
    }
    records.push({ id, record });
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
    items.push({ kind: "decision_record", id: STORE_BLOCK_ID, snapshotted_at: null, source: "loose", action: "blocked", reason: storeError ? "invalid" : "reference_scan_failed" });
  }

  const unreferenced: RetentionItem[] = [];
  for (const { id, record } of records) {
    const base = {
      kind: "decision_record" as const,
      id,
      snapshotted_at: record.snapshotted_at,
      source: srcOf(id),
      loose_sha256: source.ok ? source.looseSha256.get(id) : undefined,
    };
    if (!live.ok || storeFailed) {
      items.push({ ...base, action: "blocked", reason: "reference_scan_failed" });
      continue;
    }
    // A `both` decision whose loose and shadowed bundle copies diverge → unsafe to delete.
    if (source.ok && source.divergedBoth.has(id)) {
      items.push({ ...base, action: "blocked", reason: "bundle_stale" });
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
  // A partial store/source view is fail-closed: a single blocked diagnostic, no pack dropped.
  if (!source.ok) {
    return partition("event_pack", [
      { kind: "event_pack", id: STORE_BLOCK_ID, snapshotted_at: null, source: "loose", action: "blocked", reason: "reference_scan_failed" },
    ]);
  }
  let bundleMembers: ReadonlyMap<string, { sha256: string; bytes: string }>;
  try {
    bundleMembers = loadArchiveBundles(cwd).index.get("event_pack") ?? new Map();
  } catch {
    return partition("event_pack", [
      { kind: "event_pack", id: STORE_BLOCK_ID, snapshotted_at: null, source: "loose", action: "blocked", reason: "invalid" },
    ]);
  }

  for (const id of [...source.source.keys()].sort()) {
    const src = source.source.get(id)!;
    const base = { kind: "event_pack" as const, id, snapshotted_at: null, source: src, loose_sha256: source.looseSha256.get(id) };
    // AUTHORITY-validate the pack bytes (loose-wins) BEFORE trusting the parent verdict — a
    // schema/Tier-1-invalid OR MISFILED pack (filename id ≠ its body phase_id) must NEVER be
    // dropped just because its FILENAME's phase snapshot is being dropped (it may be another
    // phase's pack). validateEventPackTier1 enforces phase_id === fileStem + per-entry
    // bijection + order + event_ids_sha256; a bundle-only member also self-binds (canonical).
    let bytes: string | null = null;
    try {
      bytes =
        src === "bundle"
          ? bundleMembers.get(id)?.bytes ?? null
          : await readFile(join(archiveEventPacksDir(cwd), `${id}.json`), "utf8");
    } catch {
      bytes = null;
    }
    let valid = false;
    if (bytes !== null) {
      try {
        validateEventPackTier1(id, bytes, ARCHIVE_EVENT_PACK_LABEL);
        if (src === "bundle") {
          const m = bundleMembers.get(id)!;
          bindBundleMember("event_pack", { id, sha256: m.sha256, bytes: m.bytes }, ARCHIVE_EVENT_PACK_LABEL);
        }
        valid = true;
      } catch {
        valid = false;
      }
    }
    if (!valid) {
      items.push({ ...base, action: "blocked", reason: "invalid" });
      continue;
    }
    // A `both` pack whose loose and shadowed bundle copies diverge → unsafe to delete.
    if (source.divergedBoth.has(id)) {
      items.push({ ...base, action: "blocked", reason: "bundle_stale" });
      continue;
    }
    // A VALID pack drops ONLY with its phase snapshot. An orphan (no parent snapshot) is an
    // anomaly → kept (blocked invalid), never dropped on a parent we cannot locate.
    const parent = phaseVerdict.get(id);
    if (parent === "would_drop") {
      items.push({ ...base, action: "would_drop", reason: "older_than_keep_latest" });
    } else if (parent === undefined) {
      items.push({ ...base, action: "blocked", reason: "invalid" });
    } else {
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
  // Validate in the CORE too (not only the CLI) — this planner is the delete authority.
  const keepLatest = assertKeepLatest(opts.keepLatest ?? DEFAULT_KEEP_LATEST);
  const live = await buildLiveGraph(cwd);
  const phaseSource = await buildSourceMap(cwd, "phase_snapshot");
  const decisionSource = await buildSourceMap(cwd, "decision_record");
  const eventSource = await buildSourceMap(cwd, "event_pack");

  const { plan: phasePlan, verdict } = await planPhaseRetention(cwd, keepLatest, live, phaseSource);
  const decisionPlan = await planDecisionRetention(cwd, keepLatest, live, decisionSource);
  const eventPlan = await planEventPackRetention(cwd, eventSource, verdict);

  return [phasePlan, eventPlan, decisionPlan];
}

// --- destructive apply (Layer 4 retention, PR-2a: LOOSE-ONLY) -----------------
// The first layer that actually DROPS old archive truth. Conservative scope: it deletes
// ONLY a `would_drop` record that lives loose-only (a bundle-only / `both` would_drop is
// SKIPPED — physically removing a bundle MEMBER is the separate bundle-member-removal layer).
// Every unlink is gated: the plan is the AUTHORITY (re-run here, never a stale caller plan),
// and each loose file is re-read + re-authority-validated immediately before the unlink
// (TOCTOU-narrowed). A reference-scan / store failure makes the planner block (no would_drop),
// so a partial/uncertain view never deletes. Run under the repo write lock (the verb's job).

export type RetentionDeleteSkipReason =
  | "needs_bundle_member_removal" // bundle-only / both → deferred to the bundle-member-removal layer
  | "requires_atomic_pair_removal" // a phase_snapshot↔event_pack bound pair — PR-2a does not delete pairs
  | "path_escape"
  | "unreadable"
  | "authority_changed" // the loose bytes no longer match the digest the plan decided on (swapped under us)
  | "authority_invalid" // the loose file changed under us and no longer authority-validates
  | "unlink_failed";

export type RetentionDeleteOutcome = {
  kind: ArchiveBundleKind;
  /** loose ids unlinked (old truth dropped). */
  deleted: string[];
  /** ids already gone at gate / unlink time (ENOENT) — idempotent, not a failure. */
  vanished: string[];
  /** ids NOT deleted, per-record reason (fail-closed; never a silent drop). */
  skipped: { id: string; reason: RetentionDeleteSkipReason }[];
};

function looseRelPath(kind: ArchiveBundleKind, id: string): string {
  const segs =
    kind === "phase_snapshot"
      ? ARCHIVE_PHASES_DIR_SEGMENTS
      : kind === "event_pack"
        ? ARCHIVE_EVENT_PACKS_DIR_SEGMENTS
        : ARCHIVE_DECISIONS_DIR_SEGMENTS;
  return [...segs, `${id}.json`].join("/");
}

/** Re-validate a loose record's ARCHIVE AUTHORITY from its current on-disk bytes (the same
 *  checks the planner ran) — so a file that changed between plan and unlink is not deleted on
 *  a stale verdict. */
function looseStillAuthorityValid(kind: ArchiveBundleKind, id: string, raw: string): boolean {
  try {
    if (kind === "phase_snapshot") {
      const snapshot = PhaseSnapshot.parse(JSON.parse(raw));
      return resolveUnreferencedSnapshot(id, { kind: "valid", snapshot }).kind === "tolerated";
    }
    if (kind === "decision_record") {
      const r = DecisionStateRecord.parse(JSON.parse(raw));
      return (
        id === decisionRecordStem(r.canonical_ref) &&
        r.original_path === r.canonical_ref &&
        r.path_sha256 === sha256Hex(r.canonical_ref)
      );
    }
    validateEventPackTier1(id, raw, ARCHIVE_EVENT_PACK_LABEL);
    return true;
  } catch {
    return false;
  }
}

export type LooseDeleteVerdict = { kind: "delete"; abs: string } | { kind: "vanished" } | { kind: "skip"; reason: RetentionDeleteSkipReason };

/** Gate ONE loose record for deletion: path-in-project + fresh re-read + re-authority-validate.
 *  No unlink (the caller does it). Reads disk fresh to narrow the plan→unlink TOCTOU. It
 *  re-validates AUTHORITY (the bytes are still a valid record of this id), but NOT the
 *  reference graph nor `source` — those were established by the re-plan at the start of this
 *  run, and the repo write lock (the caller's job) bars any concurrent code-pact mutation from
 *  adding a reference or a bundle copy mid-run; an external edit outside the lock is the
 *  documented out-of-scope window. Returns `delete` (with the resolved absolute path), `vanished`
 *  (ENOENT — already gone), or `skip` (with the reason). Shared by the per-record apply loop and
 *  the journaled pair delete. */
export async function gateLooseDelete(
  cwd: string,
  kind: ArchiveBundleKind,
  id: string,
  expectedSha256: string | undefined,
): Promise<LooseDeleteVerdict> {
  let abs: string;
  try {
    abs = await resolveWithinProject(cwd, looseRelPath(kind, id));
  } catch {
    return { kind: "skip", reason: "path_escape" };
  }
  let raw: string;
  try {
    raw = await readFile(abs, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "vanished" };
    return { kind: "skip", reason: "unreadable" };
  }
  // Delete EXACTLY the bytes the plan decided to drop, not merely "a valid record at this path":
  // if the loose file was swapped (even to another authority-valid record) since the plan read
  // it, the digest differs → skip, never delete on the stale verdict. A missing expected digest
  // (`expectedSha256` undefined — the planner captured none) is also a SKIP, never a digest-agnostic
  // delete: with no committed-bytes authority there is nothing to delete EXACTLY, so fail safe.
  if (expectedSha256 === undefined || sha256Hex(raw) !== expectedSha256) {
    return { kind: "skip", reason: "authority_changed" };
  }
  if (!looseStillAuthorityValid(kind, id, raw)) return { kind: "skip", reason: "authority_invalid" };
  return { kind: "delete", abs };
}

/** Test seam: a hook fired immediately before each loose record's delete gate, so a test can
 *  inject a between-plan-and-unlink swap and prove the digest gate skips it. */
export type RetentionApplyHooks = { beforeGate?: (kind: ArchiveBundleKind, id: string) => Promise<void> | void };

async function deleteLooseDropped(
  cwd: string,
  plan: RetentionPlan,
  preSkip: ReadonlyMap<string, RetentionDeleteSkipReason> | null,
  hooks: RetentionApplyHooks,
): Promise<RetentionDeleteOutcome> {
  const out: RetentionDeleteOutcome = { kind: plan.kind, deleted: [], vanished: [], skipped: [] };
  for (const item of plan.would_drop) {
    // PR-2a deletes loose-only; a bundle-only / both copy is the bundle-member-removal layer.
    if (item.source !== "loose") {
      out.skipped.push({ id: item.id, reason: "needs_bundle_member_removal" });
      continue;
    }
    // A caller-supplied pre-skip: this loose-only would_drop is half of a phase_snapshot↔event_pack
    // bound pair, which PR-2a defers whole (a pair cannot be unlinked atomically) — held rather
    // than risk a crash/failure between two unlinks leaving exactly one side.
    const pre = preSkip?.get(item.id);
    if (pre) {
      out.skipped.push({ id: item.id, reason: pre });
      continue;
    }
    if (hooks.beforeGate) await hooks.beforeGate(plan.kind, item.id);
    const verdict = await gateLooseDelete(cwd, plan.kind, item.id, item.loose_sha256);
    if (verdict.kind === "vanished") {
      out.vanished.push(item.id);
      continue;
    }
    if (verdict.kind === "skip") {
      out.skipped.push({ id: item.id, reason: verdict.reason });
      continue;
    }
    try {
      await unlink(verdict.abs);
      out.deleted.push(item.id);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") out.vanished.push(item.id);
      else out.skipped.push({ id: item.id, reason: "unlink_failed" });
    }
  }
  return out;
}

/**
 * Apply keep-latest-N retention DESTRUCTIVELY. RECOVERS any crashed prior pair-delete FIRST (under
 * the caller's write lock — a corrupt journal is fail-closed), then RE-RUNS the planner as the
 * delete authority (a caller never passes a stale plan) and removes each `would_drop` record:
 *   - a `decision_record` (no cross-binding) → a single atomic unlink;
 *   - a `phase_snapshot` with NO event_pack (nothing binds to it) → a single atomic unlink;
 *   - a loose `phase_snapshot` ↔ loose `event_pack` PAIR → `deleteLoosePairsJournaled`, which removes
 *     the two files both-or-neither, crash-safe, via the durable delete-intent journal.
 *
 * The pair is MUTUALLY bound (the pack carries the snapshot's `snapshot_sha256`; the snapshot's
 * `progress_events` evidence resolves only from the pack once the loose events are compacted), so a
 * filesystem (which cannot unlink two files atomically) needs the journal to make "both gone" survive
 * a crash. A pair is journaled only when BOTH members are loose-only `would_drop` with captured
 * digests and the event store is fully visible; otherwise it is DEFERRED `requires_atomic_pair_removal`
 * (a bundle-only / `both` member is `needs_bundle_member_removal` — that layer is still later). On a
 * platform that cannot fsync a directory (`DeleteIntentDurabilityError` reason `unsupported`), durable
 * pair deletion is unavailable, so the pairs are deferred (the same conservative posture); a real I/O
 * failure (`failed`) propagates and fails the run.
 *
 * Returns a per-kind partial outcome (deleted / vanished / skipped); nothing is silently dropped.
 * Run under the write lock.
 */
export async function applyArchiveRetention(
  cwd: string,
  opts: { keepLatest?: number } = {},
  hooks: RetentionApplyHooks = {},
): Promise<RetentionDeleteOutcome[]> {
  // 0. Heal any crashed prior pair-delete BEFORE planning, under the caller's write lock — so a
  //    half-deleted pair is completed (both gone) before the planner re-reads. A corrupt journal
  //    throws (DeleteIntentRecoveryError) → fail-closed (the mutation does not proceed).
  await recoverPendingDeletes(cwd);

  const plans = await planArchiveRetention(cwd, opts);
  const byKind = new Map(plans.map((p) => [p.kind, p]));
  const empty = (kind: ArchiveBundleKind): RetentionPlan => ({ kind, would_keep: [], would_drop: [], blocked: [] });
  const eventPlan = byKind.get("event_pack") ?? empty("event_pack");
  const phasePlan = byKind.get("phase_snapshot") ?? empty("phase_snapshot");

  // The `(store)` block marks a PARTIAL event_pack view — we cannot prove a phase has no pack, so
  // we cannot form pairs and must defer fail-closed. `packIds` are the real pack ids the planner saw.
  const eventItems = [...eventPlan.would_keep, ...eventPlan.would_drop, ...eventPlan.blocked];
  const eventStoreUncertain = eventItems.some((i) => i.id === STORE_BLOCK_ID);
  const looseDropPackById = new Map(eventPlan.would_drop.filter((p) => p.source === "loose").map((p) => [p.id, p]));

  // The loose-loose pairs to journal-delete (both members loose `would_drop`, digests captured,
  // store fully visible). Their ids are EXCLUDED from the per-record loops below (the journal owns
  // them); the journal also re-enforces loose-only (a pair with a bundle copy is refused).
  const pairedIds = new Set<string>();
  const pairs: LoosePairToDelete[] = [];
  if (!eventStoreUncertain) {
    for (const phase of phasePlan.would_drop) {
      if (phase.source !== "loose") continue;
      const pack = looseDropPackById.get(phase.id);
      if (!pack || phase.loose_sha256 === undefined || pack.loose_sha256 === undefined) continue;
      pairedIds.add(phase.id);
      pairs.push({ phase_id: phase.id, phase_sha256: phase.loose_sha256, pack_sha256: pack.loose_sha256 });
    }
  }

  // Remove the paired ids from the per-record plans — the journal handles them.
  const withoutPaired = (p: RetentionPlan): RetentionPlan => ({ ...p, would_drop: p.would_drop.filter((i) => !pairedIds.has(i.id)) });

  // 1. Journal-delete the pairs (both-or-neither). On `unsupported` defer them; `failed` propagates.
  let pairOutcome: { deleted: string[]; retained: { phase_id: string; reason: PairRetainReason }[] };
  try {
    pairOutcome = await deleteLoosePairsJournaled(cwd, pairs);
  } catch (err) {
    if (err instanceof DeleteIntentDurabilityError && err.reason === "unsupported") {
      pairOutcome = { deleted: [], retained: pairs.map((p) => ({ phase_id: p.phase_id, reason: "requires_atomic_pair_removal" })) };
    } else {
      throw err; // a real durability failure, or a recovery/other error — fail-closed
    }
  }

  // 2. Non-paired event packs: every remaining loose `would_drop` pack is NOT journal-able (its
  //    phase is bundle/both, or a digest was missing) → defer; a bundle/both pack →
  //    needs_bundle_member_removal by its source.
  const eventPreSkip = new Map<string, RetentionDeleteSkipReason>();
  for (const pack of eventPlan.would_drop) {
    if (pack.source === "loose" && !pairedIds.has(pack.id)) eventPreSkip.set(pack.id, "requires_atomic_pair_removal");
  }
  const eventOut = await deleteLooseDropped(cwd, withoutPaired(eventPlan), eventPreSkip, hooks);

  // 3. Non-paired phase snapshots: delete a loose-only snapshot with NO event_pack (independent);
  //    a snapshot with a pack we could not pair, or an uncertain store, is deferred.
  const phasePreSkip = new Map<string, RetentionDeleteSkipReason>();
  for (const phase of phasePlan.would_drop) {
    if (phase.source !== "loose" || pairedIds.has(phase.id)) continue;
    if (eventStoreUncertain || looseDropPackById.has(phase.id) || hasAnyPack(eventItems, phase.id)) {
      phasePreSkip.set(phase.id, "requires_atomic_pair_removal");
    }
  }
  const phaseOut = await deleteLooseDropped(cwd, withoutPaired(phasePlan), phasePreSkip, hooks);

  // 4. Decisions are independent — delete last.
  const decisionOut = await deleteLooseDropped(cwd, byKind.get("decision_record") ?? empty("decision_record"), null, hooks);

  // Merge the journal pair results into the per-kind outcomes (a pair touches both kinds). A
  // `vanished` retain (a side already gone at gate — idempotent) goes to `vanished`, not `skipped`.
  for (const id of pairOutcome.deleted) {
    phaseOut.deleted.push(id);
    eventOut.deleted.push(id);
  }
  for (const { phase_id, reason } of pairOutcome.retained) {
    if (reason === "vanished") {
      phaseOut.vanished.push(phase_id);
      eventOut.vanished.push(phase_id);
    } else {
      phaseOut.skipped.push({ id: phase_id, reason });
      eventOut.skipped.push({ id: phase_id, reason });
    }
  }

  return [phaseOut, eventOut, decisionOut];
}

/** Whether the planner saw ANY pack (would_keep/drop/blocked) for `id` — a phase with a pack we
 *  could not pair (bundle/both pack, or a missing digest) must not be deleted alone (it would
 *  orphan or strand the pack), so it is deferred. */
function hasAnyPack(eventItems: readonly RetentionItem[], id: string): boolean {
  return eventItems.some((i) => i.id === id && i.id !== STORE_BLOCK_ID);
}
