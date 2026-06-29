import { readdir, readFile } from "../project-fs/index.ts";
import { basename, join } from "node:path";
import {
  ArchiveBundle,
  ARCHIVE_BUNDLE_SCHEMA_VERSION,
  type ArchiveBundleKind,
} from "../schemas/archive-bundle.ts";
import { atomicReplaceExistingText, atomicWriteText } from "../../io/atomic-text.ts";
import {
  archiveBundleRelPath,
  archiveDecisionsRelDir,
  archiveEventPacksRelDir,
  archivePhasesRelDir,
  resolveArchiveOwnedPath,
  sha256Hex,
} from "./paths.ts";
import { computeMemberIdsSha256, validateArchiveBundleTier1 } from "./archive-bundle-reader.ts";
import { readPendingDeleteFilters } from "./delete-intent-journal.ts";
import { bindBundleMember } from "./archive-bundle-binding.ts";
import { validateEventPackTier1 } from "./event-pack-reader.ts";
import { buildBundleMemberIndex, reconcileLooseAndBundle } from "./archive-bundle-index.ts";
import { loadArchiveBundles } from "./archive-bundle-loader.ts";

// ---------------------------------------------------------------------------
// Archive-bundle WRITER + READBACK (Layer 2). Folds N loose archive records of one
// kind into one content-addressed `bundles/<kind>-<idsHash16>.json` and verifies it
// reads back identically — WITHOUT deleting the loose records (deletion is Layer 3).
// So after Layer 2 both copies coexist (loose ∪ bundle) and the Layer-1 readers
// resolve them loose-wins; Layer 3 then removes the now-redundant loose copies.
//
// This is the FIRST `strict-reconcile` consumer (archive-level-compaction-rfc.md):
// readback re-reads the bundle from disk, Tier-1-validates it, Tier-2-self-binds
// every member, AND reconciles each member byte-for-byte against the loose record it
// folded (`reconcileLooseAndBundle`) — so a write that corrupted bytes, or a loose
// record that changed under us, fails closed before anything trusts the bundle.
// ---------------------------------------------------------------------------

/** One loose record to fold: its member id (file stem) and canonical bytes. */
export type LooseMember = { id: string; bytes: string };

export type BundleWriteOutcome =
  | { kind: "written"; bundleFile: string; member_count: number }
  | { kind: "superseded"; bundleFile: string; member_count: number }
  | { kind: "noop_already_bundled"; bundleFile: string; member_count: number }
  | { kind: "noop_no_members" };

/** A bundle write/verify/retire failure. `phase` says how far it got; `partial_applied`
 *  is true once disk was mutated (the bundle file reached disk on verify, or some old
 *  bundle was already retired on retire_bundle). */
export class BundleWriteError extends Error {
  readonly code = "ARCHIVE_BUNDLE_WRITE_FAILED";
  readonly phase: "build" | "write_bundle" | "verify_bundle" | "retire_bundle";
  readonly partial_applied: boolean;
  readonly detail: string;
  constructor(phase: BundleWriteError["phase"], partialApplied: boolean, detail: string) {
    super(`Archive bundle ${phase}: ${detail}`);
    this.name = "BundleWriteError";
    this.phase = phase;
    this.partial_applied = partialApplied;
    this.detail = detail;
  }
}

export function serializeArchiveBundle(bundle: ArchiveBundle): string {
  return JSON.stringify(bundle, null, 2) + "\n";
}

/**
 * Build a canonical, Tier-1-shaped `ArchiveBundle` from loose members of one kind.
 * Pure (no I/O). Each member is self-bound (`bindBundleMember` — schema +
 * id↔internal-identity + canonical bytes), so a non-canonical / misidentified loose
 * record is rejected here, fail-closed, before any write. Members are sorted by id
 * (Tier-1 canonical order); `member_ids_sha256` is the sorted id-set checksum.
 * Throws on a duplicate id or an empty member set.
 */
/**
 * Assert a single prospective bundle MEMBER's bytes are foldable into a bundle of `kind`:
 * canonical, self-consistent, id↔internal-identity, and (event_pack) full Tier-1. The
 * underlying validators throw `ARCHIVE_BUNDLE_INVALID` / `EVENT_PACK_INVALID`; this wraps
 * any such fault as `BundleWriteError("build")` so a build-time member fault surfaces as
 * `ARCHIVE_BUNDLE_WRITE_FAILED` (NOT `ARCHIVE_BUNDLE_INVALID`, which means a corrupt bundle
 * STORE). Shared by the writer (over the FULL consolidated set: existing bundle members ∪
 * loose) and the dry-run, so they agree on what is foldable. `sourceLabel` (e.g. "loose
 * record" / "existing bundle member") keeps the error honest about where the bad member came
 * from.
 */
export function assertBundleMemberFoldable(
  kind: ArchiveBundleKind,
  member: LooseMember,
  sourceLabel = "record",
): void {
  try {
    bindBundleMember(kind, { id: member.id, sha256: sha256Hex(member.bytes), bytes: member.bytes }, "(building bundle)");
    if (kind === "event_pack") validateEventPackTier1(member.id, member.bytes, "(building bundle)");
  } catch (err) {
    throw new BundleWriteError("build", false, `${sourceLabel} "${member.id}" is not foldable: ${(err as Error).message}`);
  }
}

export function buildArchiveBundle(kind: ArchiveBundleKind, members: readonly LooseMember[]): ArchiveBundle {
  if (members.length === 0) {
    throw new BundleWriteError("build", false, "cannot build a bundle with no members");
  }
  const seen = new Set<string>();
  const records = members.map((m) => {
    if (seen.has(m.id)) {
      throw new BundleWriteError("build", false, `duplicate member id "${m.id}"`);
    }
    seen.add(m.id);
    assertBundleMemberFoldable(kind, m, "bundle member");
    return { id: m.id, sha256: sha256Hex(m.bytes), bytes: m.bytes };
  });
  records.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return ArchiveBundle.parse({
    schema_version: ARCHIVE_BUNDLE_SCHEMA_VERSION,
    kind,
    member_ids_sha256: computeMemberIdsSha256(records.map((r) => r.id)),
    members: records,
  } satisfies ArchiveBundle);
}

/**
 * Preflight a supersede PERSIST (a same-id-set REPLACE, or a degrade-to-CREATE when no bundle
 * yet sits at the content address) so the primitive is SELF-SAFE — it can never turn a valid
 * bundle store into an unloadable one, even called directly before the wiring layer adds a
 * retire-before-replace plan. Loads the store STRICT (a corrupt bundle ANYWHERE →
 * `ARCHIVE_BUNDLE_INVALID`, fail closed before any write), then refuses
 * (`BundleWriteError("write_bundle")`) when:
 *   - a target bundle EXISTS at the content address but is a different KIND than we are writing
 *     (a misplaced/foreign bundle), or holds a different member ID SET than the rebuilt bundle
 *     (content addresses are by id set, so this is a misplaced file — not the bundle we think
 *     we are replacing). These two checks apply only when a target is present (a degrade-to-
 *     create has no target to validate).
 *   - writing the rebuilt bundle would make ANOTHER bundle collide. A valid store may carry a
 *     member id in more than one bundle byte-identically (a crash-survivor redundant bundle —
 *     deduped across files). Once this write gives that id different bytes — whether by
 *     REPLACING the bundle that held the old bytes, or by CREATING a NEW single-id bundle for a
 *     member a larger consolidated bundle still holds (a partial-id-set supersede / caller bug)
 *     — the other bundle diverges → `duplicate_member_conflict` and the store no longer loads.
 *     Caught by simulating the POST-WRITE store through the SAME cross-bundle index builder the
 *     loader uses (so the conflict rule cannot drift) and refusing rather than corrupt it. The
 *     simulation `bundles - target + rebuilt` models both cases: a present target is filtered
 *     out and replaced; an absent target adds the rebuilt bundle to the existing set.
 */
function assertSupersedePersistSafe(
  cwd: string,
  kind: ArchiveBundleKind,
  file: string,
  rebuilt: ArchiveBundle,
  rebuiltBytes: string,
): void {
  const store = loadArchiveBundles(cwd); // STRICT: a corrupt bundle store throws here, pre-write.
  const target = store.bundles.find((b) => b.file === file);
  if (target) {
    // A REPLACE: prove we are replacing the same-id-set bundle of this kind we mean to.
    if (target.loaded.kind !== kind) {
      throw new BundleWriteError(
        "write_bundle",
        false,
        `supersede target ${file} is a "${target.loaded.kind}" bundle, not "${kind}" — refusing to replace`,
      );
    }
    // The target's members are Tier-1-sorted, so their id-set checksum is comparable to the
    // rebuilt bundle's member_ids_sha256 (same derivation as buildArchiveBundle).
    if (computeMemberIdsSha256(target.loaded.members.map((m) => m.id)) !== rebuilt.member_ids_sha256) {
      throw new BundleWriteError(
        "write_bundle",
        false,
        `supersede target ${file} holds a different member id set than the rebuilt bundle — refusing to replace`,
      );
    }
  }
  // Simulate the store AFTER the write (replace OR create) and run the loader's own conflict
  // check on it — refuse if the write would make the store unloadable.
  const postWrite = store.bundles
    .filter((b) => b.file !== file)
    .concat([{ file, loaded: validateArchiveBundleTier1(rebuiltBytes, file) }]);
  try {
    buildBundleMemberIndex(postWrite);
  } catch (err) {
    throw new BundleWriteError(
      "write_bundle",
      false,
      `supersede would corrupt the bundle store (another bundle already holds a written member): ${(err as Error).message}`,
    );
  }
}

/** Re-read the just-written bundle from disk and verify it (Tier-1 + Tier-2 +
 *  strict-reconcile vs the folded loose). Shared by the create and supersede paths. */
async function readbackAndVerify(
  path: string,
  kind: ArchiveBundleKind,
  members: readonly LooseMember[],
  file: string,
): Promise<void> {
  let reread: string;
  try {
    reread = await readFile(path, "utf8");
  } catch (err) {
    throw new BundleWriteError("verify_bundle", true, `readback read failed: ${(err as Error).message}`);
  }
  verifyBundleReadback(reread, kind, members, file);
}

/**
 * Persist the consolidated bundle for `members` of `kind` at its content-addressed path
 * and verify the readback. ONE shared core behind {@link writeArchiveBundle} (create) and
 * {@link supersedeArchiveBundle} (replace) so the two entry points cannot drift in how they
 * build, place, write, or verify a bundle — they differ ONLY in what a same-id-set / different
 * -bytes collision means:
 *   - `mode: "create"` — an unintended divergence; **fail closed** (never overwrite).
 *   - `mode: "supersede"` — the intended adoption of a fresher member; **atomically replace**
 *     the stale bundle (TOCTOU-narrowed by expecting the exact old bytes) and verify.
 * A byte-identical existing bundle is an idempotent `noop_already_bundled` in BOTH modes; no
 * existing file is a plain create in both. An empty member set is `noop_no_members`. NO loose
 * deletion here (Layer 3). Run inside a write lock (the caller's job).
 */
async function persistArchiveBundle(
  cwd: string,
  kind: ArchiveBundleKind,
  members: readonly LooseMember[],
  mode: "create" | "supersede",
): Promise<BundleWriteOutcome> {
  if (members.length === 0) return { kind: "noop_no_members" };

  const bundle = buildArchiveBundle(kind, members);
  const bytes = serializeArchiveBundle(bundle);
  const path = await resolveArchiveOwnedPath(cwd, archiveBundleRelPath(kind, bundle.member_ids_sha256));
  const file = join("bundles", basename(path));

  let existing: string | null = null;
  try {
    existing = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new BundleWriteError("write_bundle", false, `existing bundle unreadable: ${(err as Error).message}`);
    }
  }

  if (existing !== null) {
    if (existing === bytes) {
      // Same content address, byte-identical → already at the desired state (idempotent).
      verifyBundleReadback(existing, kind, members, file);
      return { kind: "noop_already_bundled", bundleFile: file, member_count: members.length };
    }
    // Same id set, DIFFERENT bytes — a member's content changed under the same address.
    if (mode === "create") {
      // Create mode never overwrites a diverging bundle — fail closed (the #467 guard).
      throw new BundleWriteError(
        "write_bundle",
        false,
        `a different bundle already exists at ${file} (same id set, different bytes)`,
      );
    }
    // Supersede mode: this divergence is the POINT — a fresher loose has been adopted, so
    // replace the stale bundle. FIRST prove the replace is safe (the target is the same-id-set
    // bundle we mean to replace, and the replace will not corrupt the cross-bundle store) so
    // the primitive can never turn a valid store into an unloadable one — see
    // assertSupersedePersistSafe. Read-only; throws fail-closed before any write.
    assertSupersedePersistSafe(cwd, kind, file, bundle, bytes);
    // Then atomically replace in place. atomicReplaceExistingText expects the exact old bytes
    // just before the rename (TOCTOU-narrowed) and does NOT recreate a vanished bundles/ dir.
    // The replace is ATOMIC: rename(2) either fully swaps in the new bytes or fails leaving the
    // old bundle untouched (the temp is cleaned up on throw). So a failure here means NO disk
    // mutation → partial_applied:false (like the create-path write failure below).
    // partial_applied only flips true once readbackAndVerify sees the new bundle on disk but
    // rejects it.
    try {
      await atomicReplaceExistingText(path, bytes, existing);
    } catch (err) {
      throw new BundleWriteError("write_bundle", false, `atomic replace failed: ${(err as Error).message}`);
    }
    await readbackAndVerify(path, kind, members, file);
    return { kind: "superseded", bundleFile: file, member_count: members.length };
  }

  // No existing bundle at this content address — a plain create. In SUPERSEDE mode this is a
  // degrade-to-create, which must ALSO be self-safe: creating a new single-id bundle for a
  // member another (consolidated) bundle still holds would make the store unloadable
  // (duplicate_member_conflict — a partial-id-set supersede / caller bug). So run the same
  // post-write conflict preflight before the create.
  //
  // Create mode (writeArchiveBundle) deliberately does NOT run this preflight — it keeps its
  // thin #464 contract (idempotent content-addressed create; fail-closed only on a same-path
  // BYTE divergence) and trusts the caller to pass a coherent member set, as compactArchive
  // does (it folds the kind's FULL member set, never a partial one). The store-load self-safety
  // guard is specific to the destructive supersede entry point.
  if (mode === "supersede") {
    assertSupersedePersistSafe(cwd, kind, file, bundle, bytes);
  }
  try {
    await atomicWriteText(path, bytes, { kind: "absent" }, { mkdir: true });
  } catch (err) {
    throw new BundleWriteError("write_bundle", false, `atomic write failed: ${(err as Error).message}`);
  }
  await readbackAndVerify(path, kind, members, file);
  return { kind: "written", bundleFile: file, member_count: members.length };
}

/**
 * Write a bundle folding `members` (loose records of `kind`) and verify the readback.
 * Idempotent by content address: the same id set re-writes to the same path, so an
 * identical existing bundle is a `noop_already_bundled`; an existing file at that path
 * with DIFFERENT bytes (same id set, changed member content) **fails closed** — never
 * silently overwrites a diverging bundle (use {@link supersedeArchiveBundle} for the
 * intentional adopt-the-fresher-member replace). NO loose deletion (Layer 3). Run inside
 * a write lock (the caller's job, mirroring `applyEventPackPlan`). An empty member set is
 * `noop_no_members` (a bundle needs ≥1).
 */
export async function writeArchiveBundle(
  cwd: string,
  kind: ArchiveBundleKind,
  members: readonly LooseMember[],
): Promise<BundleWriteOutcome> {
  return persistArchiveBundle(cwd, kind, members, "create");
}

/**
 * Like {@link writeArchiveBundle} but for the INTENTIONAL supersession of a stale bundle:
 * when a bundle already exists at the content address with DIFFERENT bytes (a member whose
 * content a fresher loose record has changed), it is atomically REPLACED with the rebuilt
 * bundle (and the readback verified) rather than failing closed. This is the most truth-
 * destructive bundle op — it drops the old member bytes — so it is a SEPARATE, opt-in entry
 * point, never the default `writeArchiveBundle` collision behavior. A byte-identical existing
 * bundle is a `noop_already_bundled`; an absent one is a plain `written`; a replace is
 * `superseded`. UNWIRED into the compaction flow for now (the loose-wins adoption + the
 * delete gate that consume it land in the next layer). Run inside a write lock.
 */
export async function supersedeArchiveBundle(
  cwd: string,
  kind: ArchiveBundleKind,
  members: readonly LooseMember[],
): Promise<BundleWriteOutcome> {
  return persistArchiveBundle(cwd, kind, members, "supersede");
}

/** Verify on-disk bundle bytes: Tier-1, then per folded member Tier-2 self-bind +
 *  byte-identity against the loose record it folded. Throws BundleWriteError on any
 *  divergence (the bundle file is already on disk → partial_applied true). Exported
 *  for direct testing of the verify path. */
export function verifyBundleReadback(
  diskBytes: string,
  kind: ArchiveBundleKind,
  members: readonly LooseMember[],
  file: string,
): void {
  let loaded;
  try {
    loaded = validateArchiveBundleTier1(diskBytes, file);
  } catch (err) {
    throw new BundleWriteError("verify_bundle", true, `Tier-1 readback failed: ${(err as Error).message}`);
  }
  if (loaded.kind !== kind) {
    throw new BundleWriteError("verify_bundle", true, `readback kind "${loaded.kind}" != "${kind}"`);
  }
  if (loaded.members.length !== members.length) {
    throw new BundleWriteError(
      "verify_bundle",
      true,
      `readback member count ${loaded.members.length} != folded ${members.length}`,
    );
  }
  const byId = new Map(loaded.members.map((m) => [m.id, m]));
  for (const folded of members) {
    const lm = byId.get(folded.id);
    if (!lm) {
      throw new BundleWriteError("verify_bundle", true, `folded member "${folded.id}" missing after readback`);
    }
    try {
      // strict-reconcile: the folded loose bytes and the re-read bundle bytes must
      // be byte-identical (else bundle_stale), and the member self-binds to its kind.
      reconcileLooseAndBundle(folded.id, folded.bytes, { sha256: lm.sha256, bytes: lm.bytes }, file);
      bindBundleMember(kind, lm, file);
    } catch (err) {
      throw new BundleWriteError("verify_bundle", true, `member "${folded.id}" readback: ${(err as Error).message}`);
    }
  }
}

/** Enumerate every loose record of `kind` from its archive directory as a
 *  {@link LooseMember} (file stem → member id, raw bytes). ENOENT dir → none.
 *
 *  A phase_snapshot / event_pack named in ANY pending delete-intent is mid-deletion
 *  and LOGICALLY ABSENT — it is NOT enumerated, so compaction never folds a record
 *  that retention is deleting into a bundle. Both intent kinds must be excluded: a
 *  LOOSE-pair id (its loose copy is being unlinked); AND a BUNDLE-pair id whose record
 *  is `both` — its loose copy SURVIVES the bundle-member removal, but folding it into a
 *  new bundle mid-removal would resurrect the member into a bundle and rewrite the very
 *  bundle the pending journal's retire-gate re-reads by digest (wedging recovery). So
 *  this skips BOTH `looseAbsentIds` and `bundleAbsentIds`. (`compactArchive` does NOT
 *  run recovery first — unlike `applyArchiveRetention` — so the filter, not the caller,
 *  is the chokepoint.) */
export async function enumerateLooseMembers(
  cwd: string,
  kind: ArchiveBundleKind,
): Promise<LooseMember[]> {
  const relDir =
    kind === "phase_snapshot"
      ? archivePhasesRelDir()
      : kind === "event_pack"
        ? archiveEventPacksRelDir()
        : archiveDecisionsRelDir();
  const dir = await resolveArchiveOwnedPath(cwd, relDir);
  let dirents: import("node:fs").Dirent[];
  try {
    // withFileTypes + isFile so a `.json`-named SUBDIRECTORY can never reach
    // readFile (which would throw an untyped EISDIR out of this module).
    dirents = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const { looseAbsentIds, bundleAbsentIds } =
    kind === "decision_record"
      ? { looseAbsentIds: new Set<string>(), bundleAbsentIds: new Set<string>() }
      : await readPendingDeleteFilters(cwd);
  const names = dirents
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => e.name)
    .sort();
  const out: LooseMember[] = [];
  for (const name of names) {
    const id = basename(name, ".json");
    if (looseAbsentIds.has(id) || bundleAbsentIds.has(id)) continue; // mid-deletion pair → not folded into a bundle
    out.push({ id, bytes: await readFile(await resolveArchiveOwnedPath(cwd, `${relDir}/${name}`), "utf8") });
  }
  return out;
}

/**
 * Driver: fold ALL loose records of `kind` into one bundle and verify it. Layer 2
 * (no deletion). Sharding (bounding bundle file SIZE by a member cap) is deferred —
 * one bundle per kind for now; the content-addressed path + cross-bundle uniqueness
 * already support multiple bundles per kind when sharding lands. Run under a write
 * lock. The bundles directory is created on demand by the atomic write.
 */
export async function bundleLooseRecords(
  cwd: string,
  kind: ArchiveBundleKind,
): Promise<BundleWriteOutcome> {
  const members = await enumerateLooseMembers(cwd, kind);
  return writeArchiveBundle(cwd, kind, members);
}
