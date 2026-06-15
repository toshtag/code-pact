import { ArchiveBundle, type ArchiveBundleKind } from "../schemas/archive-bundle.ts";
import { sha256Hex } from "./paths.ts";

// ---------------------------------------------------------------------------
// Archive-bundle Tier-1 reader (self / bijection — NO Tier-2 binding yet, NO
// loose∪bundle wiring yet). Mirrors `event-pack-reader.ts`'s
// `validateEventPackTier1`: a strict loader THROWS `ARCHIVE_BUNDLE_INVALID`; the
// lenient surfaces (later) catch it and DROP the bundle. Tier-1 proves a bundle
// is internally consistent — schema, per-member id↔canonical-bytes bijection
// (recompute `sha256Hex(bytes)`), in-bundle id uniqueness, deterministic id
// order, and the `member_ids_sha256` set checksum. Per-member binding to its own
// authority (Tier-2) and the cross-bundle global-uniqueness rule are separate
// later layers (archive-level-compaction-rfc.md).
// ---------------------------------------------------------------------------

export function archiveBundleError(message: string, file: string): NodeJS.ErrnoException {
  const err = new Error(`Archive bundle ${file}: ${message}`) as NodeJS.ErrnoException;
  err.code = "ARCHIVE_BUNDLE_INVALID";
  return err;
}

/**
 * Deterministic member-id-set checksum: sort the ids ascending, hash
 * `JSON.stringify(ids)`. Hashes the id LIST (not the member bytes) — each id is
 * paired with a re-verified `sha256` of its bytes, so the id list pins the
 * members. Decides bundle-vs-loose set identity for the compaction idempotency
 * table; it is NOT independent tamper-detection.
 */
export function computeMemberIdsSha256(ids: readonly string[]): string {
  const sorted = [...ids].sort();
  return sha256Hex(JSON.stringify(sorted));
}

export type LoadedArchiveBundle = {
  kind: ArchiveBundleKind;
  /** member id → its canonical bytes (verbatim), in stored order. */
  members: { id: string; bytes: string }[];
};

/**
 * Validate one archive bundle's Tier-1 self-consistency. Throws
 * `ARCHIVE_BUNDLE_INVALID` on any failure (strict-loader convention).
 */
export function validateArchiveBundleTier1(raw: string, bundleFile: string): LoadedArchiveBundle {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (err) {
    throw archiveBundleError(`not valid JSON: ${(err as Error).message}`, bundleFile);
  }
  const result = ArchiveBundle.safeParse(parsedJson);
  if (!result.success) {
    throw archiveBundleError(`failed schema validation: ${result.error.message}`, bundleFile);
  }
  const bundle = result.data;

  const seenIds = new Set<string>();
  for (const member of bundle.members) {
    // id↔bytes bijection: the manifest's sha256 must equal the hash of the bytes
    // it carries, so the manifest cannot drift from the body.
    const recomputed = sha256Hex(member.bytes);
    if (recomputed !== member.sha256) {
      throw archiveBundleError(
        `member "${member.id}" sha256 mismatch: stored ${member.sha256}, recomputed ${recomputed}`,
        bundleFile,
      );
    }
    if (seenIds.has(member.id)) {
      throw archiveBundleError(`duplicate member id "${member.id}"`, bundleFile);
    }
    seenIds.add(member.id);
  }

  // Deterministic order: members must be stored sorted ascending by id (part of
  // the canonical form), not silently re-sorted.
  for (let i = 1; i < bundle.members.length; i++) {
    if (bundle.members[i - 1]!.id > bundle.members[i]!.id) {
      throw archiveBundleError(`members are not in ascending id order at index ${i}`, bundleFile);
    }
  }

  // member_ids_sha256 self-consistency.
  const recomputedSet = computeMemberIdsSha256(bundle.members.map((m) => m.id));
  if (recomputedSet !== bundle.member_ids_sha256) {
    throw archiveBundleError(
      `member_ids_sha256 mismatch: stored ${bundle.member_ids_sha256}, recomputed ${recomputedSet}`,
      bundleFile,
    );
  }

  return { kind: bundle.kind, members: bundle.members.map((m) => ({ id: m.id, bytes: m.bytes })) };
}
