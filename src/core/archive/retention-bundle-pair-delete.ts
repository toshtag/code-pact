import { basename } from "node:path";
import type { ArchiveBundleKind } from "../schemas/archive-bundle.ts";
import type { BundlePairIntent, BundlePairMember } from "../schemas/delete-intent.ts";
import { computeRemoval, durablyWriteBundle, looseCopyExists, type RemovalComputation } from "./bundle-member-removal.ts";
import { loadArchiveBundles } from "./archive-bundle-loader.ts";
import { serializeArchiveBundle } from "./archive-bundle-writer.ts";
import {
  assertBundlePairsCommittable,
  completeBundlePairsThenClear,
  DeleteIntentDurabilityError,
  fsyncDirRequired,
  PendingDeleteIntentError,
  readDeleteIntent,
  writeDeleteIntent,
} from "./delete-intent-journal.ts";
import { archiveBundleRelPath, archiveBundlesRelDir, resolveArchiveOwnedPath, sha256Hex } from "./paths.ts";

// ---------------------------------------------------------------------------
// Crash-safe BOTH-OR-NEITHER removal of a phase_snapshot ↔ event_pack BUNDLE pair:
// remove each side's bundle member (rebuild its kind's consolidated bundle without
// the removed members, durably write it, retire the old bundle(s)). The two
// old-bundle retires are two unlinks → NOT atomic, so the delete-intent journal is
// the commit point (mirroring the loose pair, #476): durably write BOTH reduced
// bundles → journal the intent (the durable commit) → retire BOTH old bundles →
// clear. A crash before the commit leaves both old bundles (the removed members
// still resolve from them → a re-run completes); a crash after it is rolled forward
// by `recoverPendingDeletes`, which re-verifies each survivor bundle is still durable
// and each old bundle still matches before retiring it. See
// design/decisions/bundle-member-removal-rfc.md (Layer 2).
//
// SHARED-BUNDLE CORRECTNESS: when several pairs live in the SAME bundle, their
// removals are NOT independent (removing P1 from {P1,P2,P3} and P2 from {P1,P2,P3}
// are inconsistent rebuilds). So the consolidated removal is computed PER KIND over
// the FULL committable batch (one reduced bundle = members − all committed ids), and
// every pair's intent references that ONE consolidated survivor bundle; each pair's
// `old_bundles` is the subset of retired bundles that held ITS id.
//
// FOUNDATION layer: NOT yet wired into `state archive-retention --write` (which still
// defers every bundle-backed `would_drop` as `needs_bundle_member_removal`). The CLI
// routing + reader-awareness for pending bundle pairs ship with this.
// ---------------------------------------------------------------------------

/** A bundle pair the planner decided to drop: the `phase_id` names BOTH the
 *  phase_snapshot member and the event_pack member to remove. */
export type BundlePairToDelete = { phase_id: string };

/** Why a pair was NOT committed (deferred whole — never half-removed). */
export type BundlePairSkipReason =
  | "not_bundle_member" // a side is not a current bundle member of its kind → not a bundle pair
  | "unsafe_authority" // a side's kind has an authority-invalid member → fail-closed for the kind
  | "mixed_source" // exactly one side has a surviving loose copy → removing both bundle members would leave a half-state
  | "unsupported_platform"; // the platform cannot fsync a directory → the durable path is deferred

/** Per side, the removed member's outcome: `deleted` (no copy resolves anymore) or
 *  `bundle_member_removed` (a loose copy still resolves — the loose layer drops it next run). */
export type BundlePairSideOutcome = "deleted" | "bundle_member_removed";

export type BundlePairDeleteOutcome = {
  /** pairs whose bundle members were removed both-or-neither, each side's own outcome. */
  removed: { phase_id: string; phase_snapshot: BundlePairSideOutcome; event_pack: BundlePairSideOutcome }[];
  /** pairs deferred whole, with why. */
  skipped: { phase_id: string; reason: BundlePairSkipReason }[];
};

/** Test seam: `beforeIntentWritten` fires after the reduced bundles are durably written
 *  but BEFORE the pre-commit reverify + the commit (so a test can stale a bundle and prove
 *  NO journal is written); `afterIntentWritten` fires after the durable commit (so a test
 *  can simulate a crash and prove recovery converges); `beforeRetire` fires before each old
 *  bundle unlink (a crash between the two retires). */
export type BundlePairDeleteHooks = {
  beforeIntentWritten?: () => Promise<void> | void;
  afterIntentWritten?: () => Promise<void> | void;
  beforeRetire?: (file: string) => Promise<void> | void;
};

/** Build one kind's half of a pair intent from the kind's CONSOLIDATED removal: this
 *  pair's removed id, the old bundle(s) that held it (a subset of the retired set),
 *  and the ONE consolidated survivor bundle (shared across the batch) or the empty marker. */
function intentMemberFor(kind: ArchiveBundleKind, phaseId: string, consolidated: RemovalComputation): BundlePairMember {
  const old_bundles = consolidated.retire
    .filter((r) => r.member_ids.includes(phaseId))
    .map((r) => ({ file: r.file, sha256: r.sha256 }));
  return {
    removed_ids: [phaseId],
    old_bundles,
    new_bundle: consolidated.new_bundle
      ? {
          file: basename(archiveBundleRelPath(kind, consolidated.new_bundle.member_ids_sha256)),
          member_ids_sha256: consolidated.new_bundle.member_ids_sha256,
          sha256: sha256Hex(serializeArchiveBundle(consolidated.new_bundle)),
        }
      : null,
  };
}

/**
 * Remove each phase_snapshot ↔ event_pack BUNDLE pair both-or-neither, crash-safe.
 * Preconditions on a CLEAN journal (the caller recovers first). Defers a pair whole
 * unless BOTH sides are authority-valid current bundle members of their kind. The
 * committed pairs' reduced survivor bundles are durably written FIRST, then ONE atomic
 * journal commits the pair removals, then the old bundles are retired (each through the
 * survivor-still-durable + expected-old-bytes gate) and the journal cleared. MUST run
 * under the write lock.
 */
export async function deleteBundlePairsJournaled(
  cwd: string,
  pairs: BundlePairToDelete[],
  hooks: BundlePairDeleteHooks = {},
): Promise<BundlePairDeleteOutcome> {
  // A pending journal is an un-recovered prior crash — refuse rather than overwrite it.
  const pending = await readDeleteIntent(cwd);
  if (pending.kind !== "absent") throw new PendingDeleteIntentError();

  const inputIds = pairs.map((p) => p.phase_id);
  if (new Set(inputIds).size !== inputIds.length) {
    throw new Error("deleteBundlePairsJournaled: duplicate phase_id in the input pairs");
  }

  const dir = await resolveArchiveOwnedPath(cwd, archiveBundlesRelDir());
  // PREFLIGHT the dir-fsync capability BEFORE any destructive action. `unsupported`
  // (e.g. win32) → the durable path is unavailable, so defer EVERY pair honestly (no
  // write, no retire). A real I/O `failed` fails the run.
  try {
    await fsyncDirRequired(dir, "bundle_removal_preflight");
  } catch (err) {
    if (err instanceof DeleteIntentDurabilityError && err.reason === "unsupported") {
      return { removed: [], skipped: pairs.map((p) => ({ phase_id: p.phase_id, reason: "unsupported_platform" as const })) };
    }
    throw err;
  }

  // A pair is committable only if its id is a current bundle member of BOTH kinds —
  // else it is not a bundle pair (loose/absent side), deferred `not_bundle_member`.
  // (loadArchiveBundles loads STRICT — a corrupt store throws, fail-closed.)
  const index = loadArchiveBundles(cwd).index;
  const skipped: { phase_id: string; reason: BundlePairSkipReason }[] = [];
  const candidateIds: string[] = [];
  for (const { phase_id } of pairs) {
    const isBundlePair = (index.get("phase_snapshot")?.has(phase_id) ?? false) && (index.get("event_pack")?.has(phase_id) ?? false);
    if (isBundlePair) candidateIds.push(phase_id);
    else skipped.push({ phase_id, reason: "not_bundle_member" });
  }

  // MIXED-SOURCE guard (the both-or-neither invariant is PER PAIR, not per side): removing both bundle
  // members is safe ONLY when both sides have the SAME loose presence — both loose-only (→ both
  // `deleted`) or both `both` (→ both `bundle_member_removed`, the loose pair drops next run). If
  // EXACTLY ONE side has a surviving loose copy, removing both bundle members leaves that side
  // resolving (loose) while the other is gone → a snapshot-without-pack / orphan-pack half-state. Defer
  // such a pair WHOLE (`mixed_source`); it needs a coordinated loose+bundle removal this layer omits.
  const committableIds: string[] = [];
  for (const phase_id of candidateIds) {
    const phaseLoose = await looseCopyExists(cwd, "phase_snapshot", phase_id);
    const packLoose = await looseCopyExists(cwd, "event_pack", phase_id);
    if (phaseLoose === packLoose) committableIds.push(phase_id);
    else skipped.push({ phase_id, reason: "mixed_source" });
  }
  if (committableIds.length === 0) return { removed: [], skipped };

  // CONSOLIDATED removal per kind over the FULL committable batch (shared-bundle correct).
  const phaseRemoval = computeRemoval(cwd, "phase_snapshot", committableIds);
  const packRemoval = computeRemoval(cwd, "event_pack", committableIds);
  if (phaseRemoval.unsafe || packRemoval.unsafe) {
    // A kind has an authority-invalid member → the whole kind's removal is unprovable.
    for (const phase_id of committableIds) skipped.push({ phase_id, reason: "unsafe_authority" });
    return { removed: [], skipped };
  }

  const intents: BundlePairIntent[] = committableIds.map((phase_id) => ({
    intent_kind: "bundle_pair",
    phase_id,
    members: {
      phase_snapshot: intentMemberFor("phase_snapshot", phase_id, phaseRemoval),
      event_pack: intentMemberFor("event_pack", phase_id, packRemoval),
    },
  }));
  // Pre-commit invariant: every committed member names ≥1 old bundle to retire (a removed
  // member is never a survivor, so it is always held by a retired bundle). Assert it BEFORE
  // the durable write — an empty `old_bundles` would only surface as a Zod `min(1)` parse
  // failure on the NEXT journal read, permanently wedging recovery. Fail loud, leave no journal.
  for (const intent of intents) {
    for (const kind of ["phase_snapshot", "event_pack"] as const) {
      if (intent.members[kind].old_bundles.length === 0) {
        throw new Error(`deleteBundlePairsJournaled: ${kind} member ${intent.phase_id} has no old bundle to retire (internal invariant violation)`);
      }
    }
  }

  // 1. DURABLY write each kind's ONE consolidated survivor bundle BEFORE the commit.
  if (phaseRemoval.new_bundle) await durablyWriteBundle(cwd, "phase_snapshot", phaseRemoval.new_bundle);
  if (packRemoval.new_bundle) await durablyWriteBundle(cwd, "event_pack", packRemoval.new_bundle);
  if (hooks.beforeIntentWritten) await hooks.beforeIntentWritten();

  // 2. PRE-COMMIT REVERIFY (the #474 principle): the journal is the commit point, and recovery
  //    completes a committed pair by re-reading the old/new bundles and matching their committed
  //    digests — so a bundle that is stale/missing AT COMMIT TIME yields an intent recovery can
  //    NEVER complete (a permanent fail-closed wedge). Detect it HERE, before the durable write:
  //    if any old/survivor bundle no longer matches the plan, throw and write NO journal (the run
  //    fails closed; a re-plan decides afresh). Under the write lock nothing should have changed —
  //    this is the guard that makes "the committed intent is always completable" a proven invariant.
  await assertBundlePairsCommittable(cwd, intents);

  // 3. DURABLE COMMIT: one atomic journal naming every committed bundle pair.
  await writeDeleteIntent(cwd, intents);
  if (hooks.afterIntentWritten) await hooks.afterIntentWritten();

  // 4. Retire both old bundles of every pair (re-verify survivor durable + expected old
  //    bytes), make durable, then clear the journal.
  await completeBundlePairsThenClear(cwd, intents, { beforeRetire: hooks.beforeRetire });

  // 5. Per-side outcome: a removed member whose loose copy still resolves is
  //    `bundle_member_removed` (the loose layer drops it next run); else `deleted`.
  const removed: BundlePairDeleteOutcome["removed"] = [];
  for (const phase_id of committableIds) {
    removed.push({
      phase_id,
      phase_snapshot: (await looseCopyExists(cwd, "phase_snapshot", phase_id)) ? "bundle_member_removed" : "deleted",
      event_pack: (await looseCopyExists(cwd, "event_pack", phase_id)) ? "bundle_member_removed" : "deleted",
    });
  }
  return { removed, skipped };
}
