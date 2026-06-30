import { readFile, lstat, stat, unlink } from "../core/project-fs/raw-internal.ts";
import { dirname } from "node:path";
import { resolvePhaseRef } from "../core/plan/resolve-phase.ts";
import { loadRoadmap } from "../core/plan/roadmap.ts";
import type { PhaseRef } from "../core/schemas/roadmap.ts";
import { resolveSymlinkFreeProjectPath } from "../core/path-safety.ts";
import { sha256Hex, phaseSnapshotPath } from "../core/archive/paths.ts";
import {
  planPhaseSnapshot,
  writePhaseSnapshot,
  type PhaseSnapshotBlock,
} from "../core/archive/phase-snapshot.ts";
import { resolveMissingPhaseRef } from "../core/archive/load-phase-snapshot.ts";

// ---------------------------------------------------------------------------
// `phase archive <phase-id>` — design-docs-ephemeral step 7 PR-B1.
//
// The FIRST destructive verb and the first production caller of
// `writePhaseSnapshot`. It makes a TERMINAL phase's `design/phases/<id>.yaml`
// hand-deletable by (1) writing its phase-snapshot record durably, then
// (2) deleting the YAML — in that least-harmful order, with a reader-contract
// readback verify and a prune-style stale guard between them, so a failure never
// orphans a phase or deletes a YAML whose snapshot a reader can't resolve.
//
// Deliberately does NOT: edit the roadmap (the snapshot reader tolerates a kept
// ref), rewrite links (phases are .yaml, out of the doc-link scope), or append
// any ledger (the snapshot record IS the durable tombstone).
//
// Presence is `lstat`-FIRST (not `access`-based `phaseFilePresence`, which follows
// symlinks): a dangling final symlink is `inaccessible`, never `absent`, so it can
// never be mistaken for an "already archived" phase.
// ---------------------------------------------------------------------------

export type PhaseArchiveOptions = {
  cwd: string;
  phaseId: string;
  /** When true, perform the snapshot write + YAML delete. Default is dry-run. */
  write?: boolean;
  /** Explicit attestations for legacy done-tasks without done events. */
  attestations?: Record<string, { reason: string }>;
  /** Timestamp source — explicit so records are deterministic in tests. */
  now: Date;
};

/** Why a destructive step was refused. Carried in `details.reason` under the
 *  single public code `PHASE_ARCHIVE_STALE`. */
export type PhaseArchiveStaleReason =
  | "source_changed"
  | "identity_changed"
  | "path_inaccessible"
  | "snapshot_unverified";

export type PhaseArchiveResult =
  | { kind: "would_archive"; phase_id: string; yaml_path: string; snapshot_path: string; snapshot_action: "write" | "refresh" | "noop" }
  | { kind: "would_already_archived"; phase_id: string; yaml_path: string; snapshot_path: string }
  // `--write` collapses a refresh plan to a `written` outcome, so `archived` only
  // ever reports "write" | "noop" (never "refresh"); dry-run's `would_archive` can
  // still preview "refresh" from a stale-record plan.
  | { kind: "archived"; phase_id: string; yaml_path: string; snapshot_path: string; snapshot_action: "write" | "noop" }
  | { kind: "already_archived"; phase_id: string; yaml_path: string; snapshot_path: string }
  | { kind: "ineligible"; phase_id: string; yaml_path: string; blocks: PhaseSnapshotBlock[] }
  | { kind: "not_archived"; phase_id: string; yaml_path: string; reason: string }
  | { kind: "stale"; phase_id: string; yaml_path: string; reason: PhaseArchiveStaleReason; detail: string };

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}

async function loadRef(cwd: string, phaseId: string): Promise<PhaseRef> {
  // Contained roadmap seam: a symlinked/`..` design/roadmap.yaml cannot make this
  // mutating command select a target phase from an out-of-project roadmap.
  const roadmap = await loadRoadmap(cwd);
  return resolvePhaseRef(roadmap, phaseId); // throws PHASE_NOT_FOUND / AMBIGUOUS_PHASE_ID
}

type Presence =
  | { kind: "present"; abs: string }
  | { kind: "absent" }
  | { kind: "inaccessible"; reason: PhaseArchiveStaleReason; detail: string };

/** Classify a final-component ENOENT by its PARENT directory. A true-absent phase
 *  has a real, present parent directory with no entry inside it. A parent that is a
 *  symlink (dangling ancestor), missing, or non-directory means the ENOENT is an
 *  ancestor problem, NOT an "already archived" phase → `inaccessible`, fail-closed. */
async function classifyParent(parentAbs: string): Promise<Presence> {
  let pst;
  try {
    pst = await lstat(parentAbs);
  } catch (err) {
    return {
      kind: "inaccessible",
      reason: "path_inaccessible",
      detail: isEnoent(err) ? "parent directory of the phase YAML does not exist" : `lstat parent: ${(err as Error).message}`,
    };
  }
  if (pst.isSymbolicLink()) {
    return { kind: "inaccessible", reason: "identity_changed", detail: "phase YAML's parent is a symlink (dangling or redirected)" };
  }
  if (!pst.isDirectory()) {
    return { kind: "inaccessible", reason: "path_inaccessible", detail: "phase YAML's parent is not a directory" };
  }
  return { kind: "absent" }; // real present parent dir, no entry inside → true-absent
}

/**
 * `lstat`-first presence for the phase YAML. UNLIKE `phaseFilePresence`
 * (`access`-based, follows symlinks), this never mistakes a dangling final
 * symlink for `absent`: the lexical entry IS there (as a symlink), so it is
 * `inaccessible`, not absent. A final ENOENT is `absent` ONLY when the parent is a
 * real present directory (see `classifyParent`) — a dangling ANCESTOR symlink is
 * `inaccessible`, never absent.
 */
async function phaseYamlPresence(cwd: string, relPath: string): Promise<Presence> {
  let abs: string;
  try {
    abs = await resolveSymlinkFreeProjectPath(cwd, relPath);
  } catch (err) {
    return { kind: "inaccessible", reason: "path_inaccessible", detail: (err as Error).message };
  }
  let st;
  try {
    st = await lstat(abs); // does NOT follow the final symlink
  } catch (err) {
    if (isEnoent(err)) {
      // A final-component ENOENT is "absent" ONLY when the parent is a real,
      // present directory. If the parent is itself a symlink (e.g. a DANGLING
      // `design/phases -> /nonexistent`) or missing / non-directory, the lexical
      // lstat ENOENT is an ANCESTOR problem, not a true-absent phase — never let
      // it read as "already archived". (The ancestor analogue of the final
      // dangling-symlink guard below.)
      return classifyParent(dirname(abs));
    }
    return { kind: "inaccessible", reason: "path_inaccessible", detail: `lstat: ${(err as Error).message}` };
  }
  if (st.isSymbolicLink()) {
    return {
      kind: "inaccessible",
      reason: "identity_changed",
      detail: "phase YAML path is a symlink (dangling or not); refusing to archive through it",
    };
  }
  if (!st.isFile()) {
    return {
      kind: "inaccessible",
      reason: "identity_changed",
      detail: st.isDirectory() ? "phase YAML path is a directory" : "phase YAML path is not a regular file",
    };
  }
  return { kind: "present", abs };
}

type Inspected =
  | { ok: true; abs: string; source_sha256: string; ino: number; dev: number }
  | { ok: false; reason: PhaseArchiveStaleReason; detail: string };

/**
 * The phase-side analogue of prune's `inspectTarget`: a symlink-safe identity +
 * content snapshot of the live YAML. `lstat` REFUSES a symlink final component
 * (stricter than prune's `stat().isFile()`, which would follow a symlink to a
 * regular file); `stat` then supplies the inode/dev for the same-sha-swap guard.
 */
async function inspectPhaseYaml(
  cwd: string,
  relPath: string,
  expected?: { source_sha256: string; ino: number; dev: number },
): Promise<Inspected> {
  let abs: string;
  try {
    abs = await resolveSymlinkFreeProjectPath(cwd, relPath);
  } catch (err) {
    return { ok: false, reason: "path_inaccessible", detail: (err as Error).message };
  }
  let lst;
  try {
    lst = await lstat(abs);
  } catch (err) {
    return {
      ok: false,
      reason: isEnoent(err) ? "source_changed" : "path_inaccessible",
      detail: `lstat: ${(err as Error).message}`,
    };
  }
  if (lst.isSymbolicLink()) {
    return { ok: false, reason: "identity_changed", detail: "phase YAML path is a symlink" };
  }
  if (!lst.isFile()) {
    return { ok: false, reason: "identity_changed", detail: "phase YAML path is not a regular file" };
  }
  let content: string;
  try {
    content = await readFile(abs, "utf8");
  } catch (err) {
    return {
      ok: false,
      reason: isEnoent(err) ? "source_changed" : "path_inaccessible",
      detail: `read: ${(err as Error).message}`,
    };
  }
  const source_sha256 = sha256Hex(content);
  // `stat` (not lstat) for ino/dev — we already proved it's a regular file, not a
  // symlink, so following is a no-op here and gives the canonical inode identity.
  let st;
  try {
    st = await stat(abs);
  } catch (err) {
    return { ok: false, reason: "path_inaccessible", detail: `stat: ${(err as Error).message}` };
  }
  if (expected) {
    if (source_sha256 !== expected.source_sha256) {
      return { ok: false, reason: "source_changed", detail: "phase YAML bytes changed since the baseline" };
    }
    if (st.ino !== expected.ino || st.dev !== expected.dev) {
      return { ok: false, reason: "identity_changed", detail: "phase YAML inode/dev changed (file swapped)" };
    }
  }
  return { ok: true, abs, source_sha256, ino: st.ino, dev: st.dev };
}

/** Validate, via the SAME reader the post-delete readers run, that a missing-YAML
 *  phase resolves from its snapshot. Returns the tolerated snapshot's path + sha,
 *  or null when the readers would NOT resolve it. */
async function readbackResolve(
  cwd: string,
  ref: PhaseRef,
): Promise<{ ok: true; snapshot_path: string; source_sha256: string } | { ok: false; detail: string }> {
  const res = await resolveMissingPhaseRef(cwd, { id: ref.id, path: ref.path });
  if (res.kind === "tolerated") {
    // Reconstruct the record path the same way the writer does.
    return { ok: true, snapshot_path: phaseSnapshotPath(cwd, ref.id), source_sha256: res.snapshot.source_sha256 };
  }
  if (res.kind === "fail_invalid") return { ok: false, detail: res.reason };
  return { ok: false, detail: "no archive snapshot for this phase" };
}

export async function runPhaseArchive(opts: PhaseArchiveOptions): Promise<PhaseArchiveResult> {
  const { cwd, phaseId, write = false, attestations, now } = opts;
  const ref = await loadRef(cwd, phaseId); // throws on not-found / ambiguous
  const yamlPath = ref.path;

  const presence = await phaseYamlPresence(cwd, ref.path);

  // ---- inaccessible (symlink / non-regular / escape) → never absent, never archive
  if (presence.kind === "inaccessible") {
    return { kind: "stale", phase_id: ref.id, yaml_path: yamlPath, reason: presence.reason, detail: presence.detail };
  }

  // ---- LIVE-ABSENT branch (lexical lstat ENOENT only) ----
  if (presence.kind === "absent") {
    const rb = await readbackResolve(cwd, ref);
    if (!rb.ok) {
      return { kind: "not_archived", phase_id: ref.id, yaml_path: yamlPath, reason: rb.detail };
    }
    return write
      ? { kind: "already_archived", phase_id: ref.id, yaml_path: yamlPath, snapshot_path: rb.snapshot_path }
      : { kind: "would_already_archived", phase_id: ref.id, yaml_path: yamlPath, snapshot_path: rb.snapshot_path };
  }

  // ---- LIVE-PRESENT branch ----
  // Identity baseline (also the dry-run path-safety preflight, for fidelity).
  const baseline = await inspectPhaseYaml(cwd, ref.path);
  if (!baseline.ok) {
    return { kind: "stale", phase_id: ref.id, yaml_path: yamlPath, reason: baseline.reason, detail: baseline.detail };
  }

  if (!write) {
    const plan = await planPhaseSnapshot(cwd, phaseId, { now, ...(attestations ? { attestations } : {}) });
    if (plan.kind === "ineligible") {
      return { kind: "ineligible", phase_id: ref.id, yaml_path: yamlPath, blocks: plan.blocks };
    }
    const action = plan.kind === "noop_same_source" || plan.kind === "noop_record_authoritative" ? "noop" : plan.kind;
    return {
      kind: "would_archive",
      phase_id: ref.id,
      yaml_path: yamlPath,
      snapshot_path: plan.path,
      snapshot_action: action as "write" | "refresh" | "noop",
    };
  }

  // ---- --write: snapshot durable → readback verify → stale guard → delete ----
  const outcome = await writePhaseSnapshot(cwd, phaseId, { now, ...(attestations ? { attestations } : {}) });
  if (outcome.kind === "ineligible") {
    return { kind: "ineligible", phase_id: ref.id, yaml_path: yamlPath, blocks: outcome.blocks };
  }
  const snapshotPath = outcome.path;
  const snapshotAction =
    outcome.kind === "written" ? "write" : "noop"; // noop_same_source / noop_record_authoritative

  // READBACK VERIFY (the writer is NOT trusted): the readers must resolve it, and
  // the tolerated snapshot's source_sha256 must match the YAML we're about to delete.
  const rb = await readbackResolve(cwd, ref);
  if (!rb.ok) {
    return { kind: "stale", phase_id: ref.id, yaml_path: yamlPath, reason: "snapshot_unverified", detail: rb.detail };
  }
  if (rb.source_sha256 !== baseline.source_sha256) {
    return {
      kind: "stale",
      phase_id: ref.id,
      yaml_path: yamlPath,
      reason: "snapshot_unverified",
      detail: "tolerated snapshot source_sha256 does not match the live YAML bytes",
    };
  }

  // STALE GUARD before delete (prune parity — sha + ino/dev + symlink refuse).
  const guard = await inspectPhaseYaml(cwd, ref.path, {
    source_sha256: baseline.source_sha256,
    ino: baseline.ino,
    dev: baseline.dev,
  });
  if (!guard.ok) {
    return { kind: "stale", phase_id: ref.id, yaml_path: yamlPath, reason: guard.reason, detail: guard.detail };
  }

  // DELETE the YAML (LAST, only irreversible step). Unlink the LEXICAL path —
  // guard.abs is resolveWithinProject's lexical (not realpath) target, and the
  // lstat above already refused a symlink, so this removes the regular file itself.
  // (POSIX residual: a concurrent process could swap an ancestor to an escaping
  // symlink in the sub-ms window between the guard and this unlink — the same
  // unavoidable race `decision prune` carries; not closable without an O_NOFOLLOW
  // dir-fd unlinkat, out of scope here.)
  await unlink(guard.abs);

  return {
    kind: "archived",
    phase_id: ref.id,
    yaml_path: yamlPath,
    snapshot_path: snapshotPath,
    snapshot_action: snapshotAction,
  };
}
