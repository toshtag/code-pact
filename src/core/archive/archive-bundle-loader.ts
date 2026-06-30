import { readdirSync, readFileSync } from "../project-fs/raw-internal.ts";
import { join } from "node:path";
import { archiveBundlesRelDir, resolveArchiveOwnedPathSync } from "./paths.ts";
import { validateArchiveBundleTier1, type LoadedArchiveBundle } from "./archive-bundle-reader.ts";
import { buildBundleMemberIndex, type BundleMemberIndex } from "./archive-bundle-index.ts";

// ---------------------------------------------------------------------------
// Archive-bundle directory loader (Layer 1c-ii-a) — the I/O that reads
// `.code-pact/state/archive/bundles/*.json`, Tier-1-validates EACH file, and
// folds them into the cross-bundle member index. STILL UNWIRED: no reader calls
// this yet, so there is no behavior change — it is the safe I/O foundation the
// load-bearing reader wiring (1c-ii-b) will call.
//
// It guarantees the #458 review's P1.1: only `validateArchiveBundleTier1`-checked
// bundles ever reach `buildBundleMemberIndex`. An ABSENT bundles dir is tolerated
// as an empty store (→ empty index) — never a scandir crash (the all-archived /
// no-bundles edge, same discipline as the design/phases absent-dir fix).
// ---------------------------------------------------------------------------

export type LoadedArchiveBundles = {
  /** Cross-bundle, per-kind id→member index (fail-closed on duplicate_member_conflict). */
  index: BundleMemberIndex;
  /** The Tier-1-validated bundles, in filename order, for diagnostics. */
  bundles: { file: string; loaded: LoadedArchiveBundle }[];
};

/**
 * Read + Tier-1-validate every `*.json` under `state/archive/bundles/` and build
 * the cross-bundle member index. Throws `ARCHIVE_BUNDLE_INVALID` if any bundle
 * fails Tier-1 or if two bundles carry the same id with different bytes. An absent
 * bundles directory yields an empty index (tolerated as an empty store).
 */
export function loadArchiveBundles(cwd: string): LoadedArchiveBundles {
  const dir = resolveArchiveOwnedPathSync(cwd, archiveBundlesRelDir());
  let names: string[];
  try {
    // withFileTypes + isFile() so a `.json`-named SUBDIRECTORY can never reach
    // readFileSync (which would throw an untyped EISDIR instead of the contract's
    // ARCHIVE_BUNDLE_INVALID). Bundles are plain files only.
    names = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".json"))
      .map((e) => e.name)
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { index: new Map(), bundles: [] };
    throw err;
  }
  const bundles = names.map((name) => {
    const file = join("bundles", name); // stable relative label for error messages
    const path = resolveArchiveOwnedPathSync(
      cwd,
      `${archiveBundlesRelDir()}/${name}`,
    );
    const raw = readFileSync(path, "utf8");
    return { file, loaded: validateArchiveBundleTier1(raw, file) };
  });
  return { index: buildBundleMemberIndex(bundles), bundles };
}
