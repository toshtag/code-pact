// ---------------------------------------------------------------------------
// Event-pack compaction LAYER 3b-2b-1 — the delete-time ownership gate, as a
// NON-DESTRUCTIVE dry evaluator. NOTHING here unlinks a file.
//
// `evaluateDeleteGate` is the per-file decision the destructive unlink loop
// (Layer 3b-2b-2) will call immediately before each `unlink` (TOCTOU: it re-reads
// disk every time, never trusting a plan-time snapshot). `planLooseCleanup` runs
// it across a phase's whole loose target set and reports, WITHOUT removing
// anything, which files WOULD be unlinked, which would be skipped (with a reason),
// which already vanished, and which trigger a global abort (G6/G7/G8).
//
// Shipping the gate decision first, exhaustively tested and with zero unlink, lets
// the irreversible loop in 3b-2b-2 be layered on a reviewed, fixed gate — the same
// "pure/decision part first, destructive wiring later" cadence as Layers 3a/3b-1.
//
// See design/decisions/event-pack-compaction-rfc.md — the delete-time ownership
// gate table (G0–G8) is the binding source for every disposition here.
// ---------------------------------------------------------------------------

import { open, lstat, readFile, type FileHandle } from "node:fs/promises";
import { constants } from "node:fs";
import {
  planEventPack,
  findLiveTaskOwnersByTaskId,
  type EventPackBlock,
} from "./event-pack.ts";
import { loadPhaseSnapshot } from "./load-phase-snapshot.ts";
import { validateEventPackTier1 } from "./event-pack-reader.ts";
import { bindPackToSnapshot } from "./event-pack-binding.ts";
import { readPackSources } from "../progress/all-sources.ts";
import { resolveWithinProject } from "../path-safety.ts";
import {
  EVENTS_DIR_SEGMENTS,
  parseEventFileName,
  validateEventFileContent,
} from "../progress/events-io.ts";
import { eventPackPath, phaseSnapshotPath, sha256Hex } from "./paths.ts";
import type { CleanupSkipReason } from "./event-pack-cleanup.ts";

/** Project-relative path of a loose event file (matches CleanupSkip.path). */
export function looseEventRelPath(file: string): string {
  return [...EVENTS_DIR_SEGMENTS, file].join("/");
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ENOENT";
}

/** Open read-only WITHOUT following a final-component symlink, where the platform
 *  supports it (`O_NOFOLLOW` falls back to 0 — follow — where it is absent). */
const O_NOFOLLOW_READONLY = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

/**
 * Read a loose event file as a REGULAR file, never following a symlink at the final
 * path component (the RFC's `readRegularEventFileNoSymlink` contract), on EVERY
 * platform — not only where `O_NOFOLLOW` exists. Three layers:
 *   (1) `lstat` first — it never follows a symlink, so a symlink/dir/special is
 *       rejected here on all platforms; `ENOENT` → vanished (already gone).
 *   (2) open with `O_NOFOLLOW` where the platform supports it — a symlink fails the
 *       open (ELOOP) rather than being followed.
 *   (3) `fstat` the OPEN fd and require the SAME inode the `lstat` saw — so a symlink
 *       swapped in BETWEEN the lstat and the open (where, lacking `O_NOFOLLOW`, the
 *       open would follow it) resolves to a different inode and is rejected. This is
 *       the RFC's identity-check fallback; with (1) it never follows a symlink.
 * Returns the body on success, or the gate verdict to emit on failure. Best-effort
 * per the RFC: the threat model is accidental corruption / honest concurrent
 * writers, not a hostile local filesystem racing the read.
 */
async function readRegularEventFileNoSymlink(
  abs: string,
): Promise<{ raw: string } | DeleteGateVerdict> {
  // (1) lstat — does NOT follow a symlink, so this rejects a symlink on every
  // platform, before any open that could follow it.
  let pre;
  try {
    pre = await lstat(abs);
  } catch (err) {
    if (isEnoent(err)) return { disposition: "vanished" };
    return { disposition: "skip", reason: "unreadable" };
  }
  if (!pre.isFile()) return { disposition: "skip", reason: "not_regular_file" };

  // (2) open with O_NOFOLLOW (where supported); (3) fstat + inode identity check.
  let fh: FileHandle;
  try {
    fh = await open(abs, O_NOFOLLOW_READONLY);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { disposition: "vanished" };
    // ELOOP = O_NOFOLLOW refused a symlink; EISDIR/ENOTDIR = not a regular file.
    if (code === "ELOOP" || code === "EISDIR" || code === "ENOTDIR") {
      return { disposition: "skip", reason: "not_regular_file" };
    }
    return { disposition: "skip", reason: "unreadable" };
  }
  try {
    const st = await fh.stat();
    // Not a regular file, OR a different inode than lstat saw (the path was swapped
    // between lstat and open) → refuse to read it.
    if (!st.isFile() || st.ino !== pre.ino || st.dev !== pre.dev) {
      return { disposition: "skip", reason: "not_regular_file" };
    }
    return { raw: await fh.readFile("utf8") };
  } catch (err) {
    if (isEnoent(err)) return { disposition: "vanished" };
    return { disposition: "skip", reason: "unreadable" };
  } finally {
    await fh.close();
  }
}

/**
 * The verified-pack facts the per-file gate needs (G5/G7/G8). Gathered ONCE by the
 * caller from the bound pack + snapshot the G0 re-plan proved valid; `snapshotPath`
 * is re-read inside the gate per file so G8 is a fresh TOCTOU check, not a cached
 * one.
 */
export type DeleteGateContext = {
  /** G5: the archived snapshot's task ids (the pack is bound to these). */
  snapshotTaskIds: ReadonlySet<string>;
  /** G7: the event ids the verified pack covers. */
  packIds: ReadonlySet<string>;
  /** G8: the verified pack's `snapshot_sha256`. */
  packSnapshotSha256: string;
  /** G8: the snapshot file path, re-read each call so divergence is caught live. */
  snapshotPath: string;
};

/** A global abort signal (G6/G7/G8): the pack/snapshot/control-plane is no longer
 *  trustworthy, so the WHOLE run must stop — never a per-file skip. */
export type DeleteGateAbortReason =
  | "live_task_owner" // G6: a live phase owns the event's task_id
  | "live_owner_discovery_incomplete" // G6: cannot prove no live owner (fail closed)
  | "pack_missing_event" // G7: the verified pack does not cover this present loose id
  | "snapshot_diverged"; // G8: pack snapshot_sha256 ≠ the current snapshot bytes

/**
 * One file's gate disposition. Exactly one of:
 *  - `unlink`   — every G1–G8 check passed; the loop MAY remove this file.
 *  - `skip`     — this one file cannot be proven safe; record the reason, keep it.
 *  - `vanished` — already gone (ENOENT at re-read); not a survivor, not removed.
 *  - `abort`    — a global safety gate failed; the loop must STOP, removing no more.
 */
export type DeleteGateVerdict =
  | { disposition: "unlink" }
  | { disposition: "skip"; reason: CleanupSkipReason }
  | { disposition: "vanished" }
  | { disposition: "abort"; reason: DeleteGateAbortReason; detail: string };

/**
 * Re-verify, at delete time, that ONE loose file is safe to unlink. Reads disk
 * fresh on every call (lstat / readFile / live-owner scan / snapshot re-read) —
 * the plan-time facts are NOT trusted (TOCTOU). Performs NO unlink; it only
 * decides. Checks run in the RFC's locked order so a global failure (G6/G7/G8)
 * wins over a per-file skip:
 *
 *   G1 path-in-project · G2 filename shape · G3a present / G3b regular + readable
 *   (O_NOFOLLOW, no symlink follow) · G4 content↔id bijection · G5 task ∈ snapshot ·
 *   G6 no live task owner · G7 pack covers the id · G8 pack↔snapshot bound.
 */
export async function evaluateDeleteGate(
  cwd: string,
  file: string,
  ctx: DeleteGateContext,
): Promise<DeleteGateVerdict> {
  // G1 — the path resolves WITHIN the project (no symlink/`..` escape). First, per
  // the RFC's locked order.
  let abs: string;
  try {
    abs = await resolveWithinProject(cwd, looseEventRelPath(file));
  } catch {
    return { disposition: "skip", reason: "path_escape" };
  }

  // G2 — expected event-file name (`<at-compact>-<id>.yaml`). A stray file is a
  // per-file skip, never removed.
  const parsedName = parseEventFileName(file);
  if (!parsedName) return { disposition: "skip", reason: "not_event_file" };

  // G3a / G3b / G1-regular-file — open the final component with O_NOFOLLOW (a
  // symlink fails the open, never followed), fstat the OPEN fd, and read from it:
  // ENOENT → vanished (already gone, not a survivor); symlink/dir/special →
  // not_regular_file; other error → unreadable. The fd-based read closes the
  // stat→open TOCTOU (no separate lstat the read could diverge from).
  const read = await readRegularEventFileNoSymlink(abs);
  if ("disposition" in read) return read;
  const raw = read.raw;

  // G4 — content ↔ filename ↔ id bijection still holds. `validateEventFileContent`
  // recomputes the id and checks the filename/at-compact/stored-id agreement, so a
  // tampered or swapped file fails here. Split the reason for operator recovery:
  // an unparseable / schema-invalid body is `parse_failed`; a parseable event whose
  // recomputed id (or prefix/stored id) disagrees with the filename is `id_mismatch`.
  let loaded;
  try {
    loaded = validateEventFileContent(file, raw);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      disposition: "skip",
      reason: code === "EVENT_FILE_ID_MISMATCH" ? "id_mismatch" : "parse_failed",
    };
  }

  // G5 — the event's task belongs to THIS archived snapshot.
  if (!ctx.snapshotTaskIds.has(loaded.event.task_id)) {
    return { disposition: "skip", reason: "task_not_in_snapshot" };
  }

  // G6 — no LIVE phase owns this task_id (a re-used task_id under a different live
  // phase means the loose event may still be live). ABORT on an owner OR on any
  // unreadable/unparseable/ambiguous scan result (fail closed). This is a global
  // safety signal, not a per-file skip.
  const owners = await findLiveTaskOwnersByTaskId(cwd, loaded.event.task_id);
  if (owners.incomplete !== null) {
    return {
      disposition: "abort",
      reason: "live_owner_discovery_incomplete",
      detail: owners.incomplete,
    };
  }
  if (owners.owners.length > 0) {
    return {
      disposition: "abort",
      reason: "live_task_owner",
      detail: `task "${loaded.event.task_id}" is owned by live phase(s): ${owners.owners
        .map((o) => o.phase_path)
        .join(", ")}`,
    };
  }

  // G7 — the verified pack provably holds this exact event id. A present loose id
  // the pack does NOT cover means the pack no longer matches the live loose set: a
  // coverage failure (`pack_stale_after_cleanup`), so ABORT, never skip.
  if (!ctx.packIds.has(loaded.id)) {
    return {
      disposition: "abort",
      reason: "pack_missing_event",
      detail: `loose event id ${loaded.id} is not covered by the verified pack`,
    };
  }

  // G8 — pack and snapshot have not diverged since the plan. Re-read the snapshot
  // bytes NOW so a swap between plan and this check is caught.
  let currentSnapshotSha256: string;
  try {
    currentSnapshotSha256 = sha256Hex(await readFile(ctx.snapshotPath, "utf8"));
  } catch (err) {
    return {
      disposition: "abort",
      reason: "snapshot_diverged",
      detail: `snapshot became unreadable at delete time: ${(err as Error).message}`,
    };
  }
  if (ctx.packSnapshotSha256 !== currentSnapshotSha256) {
    return {
      disposition: "abort",
      reason: "snapshot_diverged",
      detail: `pack snapshot_sha256 ${ctx.packSnapshotSha256} ≠ current snapshot ${currentSnapshotSha256}`,
    };
  }

  // All G1–G8 passed — the destructive loop MAY unlink this file.
  return { disposition: "unlink" };
}

/** One loose file that would be skipped, with its project-relative path + reason. */
export type LooseCleanupSkip = { path: string; reason: CleanupSkipReason };

/** One loose file that would trigger a global abort, with the gate reason. */
export type LooseCleanupAbort = {
  path: string;
  reason: DeleteGateAbortReason;
  detail: string;
};

/**
 * The dry-run cleanup plan: what `state compact --write`'s Layer 3 cleanup WOULD do
 * to the loose files, with NOTHING removed. Mirrors the plan verdict that gates the
 * unlink:
 *  - `ineligible`      — G0 re-plan is ineligible (cells 1–8, 13); pass the block.
 *  - `noop_no_events`  — the archived phase has no events (cell 9).
 *  - `needs_pack_write`— a write plan (cell 10): the pack is not on disk yet, so the
 *                        caller must write it (Layer 2) before any cleanup.
 *  - `already_clean`   — a pack covers the phase and no loose remains (cell 11).
 *  - `ready`           — a covering pack + loose remain (cell 12 equal / 14 subset):
 *                        per-file gate verdicts for the whole target set.
 */
export type LooseCleanupDryRun =
  | { kind: "ineligible"; block: EventPackBlock }
  | { kind: "noop_no_events" }
  | { kind: "needs_pack_write" }
  | { kind: "already_clean" }
  | {
      kind: "ready";
      /** Which covering relationship the loose set has to the pack (cell 12/14). */
      relationship: "equal" | "strict_subset";
      /** Files every gate cleared — the unlink loop WOULD remove these. */
      unlinkable: string[];
      /** Files a per-file gate could not clear — kept, with the reason. */
      skipped: LooseCleanupSkip[];
      /** Files already gone (ENOENT) — not survivors, not removed. */
      vanished: string[];
      /** Files that would trigger a global abort (G6/G7/G8). The DESTRUCTIVE run
       *  STOPS at the FIRST such file (unlinking no further); this dry-run lists ALL
       *  of them for diagnostics, so a non-empty `aborts` means the real cleanup
       *  would not complete until the cause is resolved. */
      aborts: LooseCleanupAbort[];
    };

/**
 * Evaluate the delete-time gate across a phase's whole loose target set WITHOUT
 * removing anything (the dry-run column of the Layer 3 cleanup). G0 is the
 * `planEventPack` re-check; the target set is the loose files whose task_id is in
 * the bound snapshot (the same set Layer 2 packs). Each target file is run through
 * `evaluateDeleteGate`. NO unlink, no lock — this is read-only.
 */
export async function planLooseCleanup(
  cwd: string,
  phaseId: string,
): Promise<LooseCleanupDryRun> {
  // G0 — the plan must still describe a valid, bound pack with loose to clean.
  const plan = await planEventPack(cwd, phaseId);
  if (plan.kind === "ineligible") return { kind: "ineligible", block: plan.block };
  if (plan.kind === "noop_no_events") return { kind: "noop_no_events" };
  if (plan.kind === "write") return { kind: "needs_pack_write" };
  // plan.kind === "noop_already_packed"
  if (plan.loose_relationship === "empty") return { kind: "already_clean" };
  const relationship = plan.loose_relationship; // "equal" | "strict_subset"

  // Re-load the snapshot (task set + path for G8) and the verified pack (ids +
  // snapshot_sha256). The plan just proved both valid; a race that broke them since
  // is reported as the matching ineligible block rather than crashing.
  const snapRes = await loadPhaseSnapshot(cwd, phaseId);
  if (snapRes.kind !== "valid") {
    return {
      kind: "ineligible",
      block:
        snapRes.kind === "absent"
          ? { kind: "snapshot_missing" }
          : { kind: "snapshot_invalid", detail: String(snapRes.error) },
    };
  }
  const snapshot = snapRes.snapshot;
  const snapshotTaskIds = new Set(snapshot.tasks.map((t) => t.id));

  // The cleanup TARGET SET — the loose files for the snapshot's tasks (the set the
  // pack covers), the same selection Layer 2 packs. Read leniently so an unrelated
  // phase's broken PACK can't block enumeration; a target file that breaks AFTER
  // this read is caught per-file by the gate (G3a/G3b/G4). (A broken LOOSE file — of
  // this OR another phase — makes G0's `planEventPack` throw first, the same as
  // Layer 2; tolerating an out-of-scope broken loose file is the reconciliation
  // layer's job (Layer 3b-2b-2), not this dry-run's.)
  const sources = await readPackSources(cwd, "lenient");
  const target = sources.looseFiles.filter((f) => snapshotTaskIds.has(f.event.task_id));
  const looseEventsById = new Map(target.map((f) => [f.id, f] as const));

  // Load the pack for the gate ctx and RE-BIND it (Tier-1 + Tier-2) against the
  // snapshot. NOTE this is a SECOND read of the pack (G0's `planEventPack` already
  // validated it), so re-checking Tier-1 ALONE is not enough: a concurrent swap to a
  // Tier-1-valid but Tier-2-UNBOUND pack would feed the gate a bogus id-set / binding
  // and the dry-run could report a file as unlinkable against an unbound pack. So
  // re-run the full snapshot binding and report `pack_invalid` if it fails. (Dry-run
  // only — for a read-only run a swap at worst yields a stale verdict; re-run to
  // refresh. The DESTRUCTIVE loop (Layer 3b-2b-2) MUST instead build the gate ctx
  // from the SAME pack its G0 re-plan verified UNDER THE WRITE LOCK, never a second
  // read.)
  const packPath = eventPackPath(cwd, phaseId);
  let packIds: Set<string>;
  let packSnapshotSha256: string;
  try {
    const snapshotRaw = await readFile(phaseSnapshotPath(cwd, phaseId), "utf8");
    const loadedPack = validateEventPackTier1(phaseId, await readFile(packPath, "utf8"), packPath);
    const bindIssues = bindPackToSnapshot(loadedPack, snapshot, snapshotRaw, looseEventsById);
    if (bindIssues.length > 0) {
      return {
        kind: "ineligible",
        block: { kind: "pack_invalid", detail: bindIssues.map((i) => i.message).join("; ") },
      };
    }
    packIds = new Set(loadedPack.pack.events.map((e) => e.id));
    packSnapshotSha256 = loadedPack.pack.snapshot_sha256;
  } catch (err) {
    return { kind: "ineligible", block: { kind: "pack_invalid", detail: (err as Error).message } };
  }

  const ctx: DeleteGateContext = {
    snapshotTaskIds,
    packIds,
    packSnapshotSha256,
    snapshotPath: phaseSnapshotPath(cwd, phaseId),
  };

  const unlinkable: string[] = [];
  const vanished: string[] = [];
  const skipped: LooseCleanupSkip[] = [];
  const aborts: LooseCleanupAbort[] = [];
  for (const f of target) {
    const verdict = await evaluateDeleteGate(cwd, f.file, ctx);
    switch (verdict.disposition) {
      case "unlink":
        unlinkable.push(f.file);
        break;
      case "vanished":
        vanished.push(f.file);
        break;
      case "skip":
        skipped.push({ path: looseEventRelPath(f.file), reason: verdict.reason });
        break;
      case "abort":
        aborts.push({ path: looseEventRelPath(f.file), reason: verdict.reason, detail: verdict.detail });
        break;
    }
  }

  return { kind: "ready", relationship, unlinkable, skipped, vanished, aborts };
}
