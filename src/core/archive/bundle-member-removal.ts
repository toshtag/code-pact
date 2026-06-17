import { basename } from "node:path";
import type { ArchiveBundleKind } from "../schemas/archive-bundle.ts";
import { loadArchiveBundles } from "./archive-bundle-loader.ts";
import { buildArchiveBundle, serializeArchiveBundle, type LooseMember } from "./archive-bundle-writer.ts";
import { archiveBundlePath, sha256Hex } from "./paths.ts";

// ---------------------------------------------------------------------------
// Bundle-member removal — Layer 1a: the READ-ONLY planner (the destructive
// `removeBundleMembers` apply is a separate layer, mirroring how retention split
// the planner (#472) before the apply (#473)).
//
// A bundle is content-addressed by its member-id SET, so a member cannot be edited
// out in place — removal is SUPERSEDE-BY-REMOVAL: rebuild the kind's consolidated
// bundle from (current members − removed), and the apply retires the old bundle(s).
// This planner computes, READ-ONLY, exactly what the apply would do: which ids are
// removable (genuine current members) vs not-a-member, the survivors, the new
// consolidated bundle's content address (or an empty-set verdict), and the existing
// bundle files that would be retired. It mutates NOTHING.
//
// Loads STRICT (`loadArchiveBundles` throws `ARCHIVE_BUNDLE_INVALID` on a corrupt
// store) — a partial/corrupt view never yields a removal plan. See
// design/decisions/bundle-member-removal-rfc.md.
// ---------------------------------------------------------------------------

export type BundleMemberRemovalPlan = {
  kind: ArchiveBundleKind;
  /** `removeIds` that ARE current bundle members of this kind — actually removable. */
  removable: string[];
  /** `removeIds` that are NOT a current bundle member — a no-op, reported (never a silent miss). */
  not_member: string[];
  /** surviving member ids (current members − removable), sorted. */
  survivors: string[];
  /** the consolidated bundle the apply would write (`addr(survivors)`), or `null` when there are
   *  no survivors (the empty-set marker — the apply just deletes the old bundle(s), no replacement). */
  new_bundle: { file: string; member_ids_sha256: string; sha256: string } | null;
  /** existing bundle file names (basename) the apply would retire — every bundle of the kind
   *  EXCEPT one already sitting at `addr(survivors)` (the keep). */
  retire_bundles: string[];
};

/**
 * Plan the removal of `removeIds` from `kind`'s bundle store — READ-ONLY, mutates nothing.
 * Loads STRICT (a corrupt store throws). An id that is not a current member is reported in
 * `not_member` (no-op), never silently dropped.
 */
export function planBundleMemberRemoval(
  cwd: string,
  kind: ArchiveBundleKind,
  removeIds: readonly string[],
): BundleMemberRemovalPlan {
  const { index, bundles } = loadArchiveBundles(cwd);
  const members = index.get(kind) ?? new Map<string, { sha256: string; bytes: string }>();
  const removeSet = new Set(removeIds);

  const removable = [...removeSet].filter((id) => members.has(id)).sort();
  const not_member = [...removeSet].filter((id) => !members.has(id)).sort();
  const survivors = [...members.keys()].filter((id) => !removeSet.has(id)).sort();

  // Nothing removable → a pure no-op: the apply writes/retires nothing (a removal verb that
  // removes no member must not rebuild/consolidate as a side effect).
  if (removable.length === 0) {
    return { kind, removable, not_member, survivors, new_bundle: null, retire_bundles: [] };
  }

  let new_bundle: BundleMemberRemovalPlan["new_bundle"] = null;
  if (survivors.length > 0) {
    const survivorMembers: LooseMember[] = survivors.map((id) => ({ id, bytes: members.get(id)!.bytes }));
    const built = buildArchiveBundle(kind, survivorMembers);
    new_bundle = {
      file: basename(archiveBundlePath(cwd, kind, built.member_ids_sha256)),
      member_ids_sha256: built.member_ids_sha256,
      sha256: sha256Hex(serializeArchiveBundle(built)), // the exact bytes the apply would write
    };
  }

  // Retire every existing bundle of the kind EXCEPT one already at addr(survivors) (the keep) —
  // each old bundle's members are all either survivors (covered by the new bundle byte-identically)
  // or removed, so the consolidated new bundle supersedes them.
  const retire_bundles = bundles
    .filter((b) => b.loaded.kind === kind && basename(b.file) !== new_bundle?.file)
    .map((b) => basename(b.file))
    .sort();

  return { kind, removable, not_member, survivors, new_bundle, retire_bundles };
}
