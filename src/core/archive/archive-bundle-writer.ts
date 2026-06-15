import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  ArchiveBundle,
  ARCHIVE_BUNDLE_SCHEMA_VERSION,
  type ArchiveBundleKind,
} from "../schemas/archive-bundle.ts";
import { atomicWriteText } from "../../io/atomic-text.ts";
import {
  archiveBundlePath,
  archiveDecisionsDir,
  archiveEventPacksDir,
  archivePhasesDir,
  sha256Hex,
} from "./paths.ts";
import { computeMemberIdsSha256, validateArchiveBundleTier1 } from "./archive-bundle-reader.ts";
import { bindBundleMember } from "./archive-bundle-binding.ts";
import { validateEventPackTier1 } from "./event-pack-reader.ts";
import { reconcileLooseAndBundle } from "./archive-bundle-index.ts";

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
  | { kind: "noop_already_bundled"; bundleFile: string; member_count: number }
  | { kind: "noop_no_members" };

/** A bundle write/verify failure. `phase` says how far it got; `partial_applied` is
 *  true once the bundle file reached disk (a verify failure leaves it there). */
export class BundleWriteError extends Error {
  readonly code = "ARCHIVE_BUNDLE_WRITE_FAILED";
  readonly phase: "build" | "write_bundle" | "verify_bundle";
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
 * Assert a single LOOSE record's bytes are a valid prospective bundle member of `kind`:
 * canonical, self-consistent, id↔internal-identity, and (event_pack) full Tier-1. The
 * underlying validators throw `ARCHIVE_BUNDLE_INVALID` / `EVENT_PACK_INVALID`; this wraps
 * any such fault as `BundleWriteError("build")` so a build-time member fault surfaces as
 * `ARCHIVE_BUNDLE_WRITE_FAILED` (NOT `ARCHIVE_BUNDLE_INVALID`, which means a corrupt bundle
 * STORE). Shared by the writer and the dry-run so they agree on what is foldable.
 */
export function assertLooseMemberValid(kind: ArchiveBundleKind, member: LooseMember): void {
  try {
    bindBundleMember(kind, { id: member.id, sha256: sha256Hex(member.bytes), bytes: member.bytes }, "(building bundle)");
    if (kind === "event_pack") validateEventPackTier1(member.id, member.bytes, "(building bundle)");
  } catch (err) {
    throw new BundleWriteError("build", false, `loose record "${member.id}" is not foldable: ${(err as Error).message}`);
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
    assertLooseMemberValid(kind, m);
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
 * Write a bundle folding `members` (loose records of `kind`) and verify the readback.
 * Idempotent by content address: the same id set re-writes to the same path, so an
 * identical existing bundle is a `noop_already_bundled`; an existing file at that path
 * with DIFFERENT bytes (same id set, changed member content) fails closed. NO loose
 * deletion (Layer 3). Run inside a write lock (the caller's job, mirroring
 * `applyEventPackPlan`). An empty member set is `noop_no_members` (a bundle needs ≥1).
 */
export async function writeArchiveBundle(
  cwd: string,
  kind: ArchiveBundleKind,
  members: readonly LooseMember[],
): Promise<BundleWriteOutcome> {
  if (members.length === 0) return { kind: "noop_no_members" };

  const bundle = buildArchiveBundle(kind, members);
  const bytes = serializeArchiveBundle(bundle);
  const path = archiveBundlePath(cwd, kind, bundle.member_ids_sha256);
  const file = join("bundles", basename(path));

  // Idempotency / conflict: a file already at this content-addressed path is either
  // byte-identical (idempotent re-run → noop) or a same-id-set/different-bytes
  // conflict (fail closed — never silently overwrite a diverging bundle).
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
      verifyBundleReadback(existing, kind, members, file);
      return { kind: "noop_already_bundled", bundleFile: file, member_count: members.length };
    }
    throw new BundleWriteError(
      "write_bundle",
      false,
      `a different bundle already exists at ${file} (same id set, different bytes)`,
    );
  }

  try {
    await atomicWriteText(path, bytes, { kind: "absent" }, { mkdir: true });
  } catch (err) {
    throw new BundleWriteError("write_bundle", false, `atomic write failed: ${(err as Error).message}`);
  }

  // Readback: re-read from disk and verify (Tier-1 + Tier-2 + strict-reconcile vs loose).
  let reread: string;
  try {
    reread = await readFile(path, "utf8");
  } catch (err) {
    throw new BundleWriteError("verify_bundle", true, `readback read failed: ${(err as Error).message}`);
  }
  verifyBundleReadback(reread, kind, members, file);
  return { kind: "written", bundleFile: file, member_count: members.length };
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
 *  {@link LooseMember} (file stem → member id, raw bytes). ENOENT dir → none. */
export async function enumerateLooseMembers(
  cwd: string,
  kind: ArchiveBundleKind,
): Promise<LooseMember[]> {
  const dir =
    kind === "phase_snapshot"
      ? archivePhasesDir(cwd)
      : kind === "event_pack"
        ? archiveEventPacksDir(cwd)
        : archiveDecisionsDir(cwd);
  let dirents: import("node:fs").Dirent[];
  try {
    // withFileTypes + isFile so a `.json`-named SUBDIRECTORY can never reach
    // readFile (which would throw an untyped EISDIR out of this module).
    dirents = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const names = dirents
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => e.name)
    .sort();
  const out: LooseMember[] = [];
  for (const name of names) {
    out.push({ id: basename(name, ".json"), bytes: await readFile(join(dir, name), "utf8") });
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
