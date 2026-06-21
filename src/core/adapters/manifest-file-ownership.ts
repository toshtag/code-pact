import { matchGlob } from "../glob.ts";
import { resolveOwnedProjectPath } from "../path-safety.ts";
import type { AdapterDescriptor } from "./types.ts";

/**
 * Verdict for "may this manifest entry path be READ by a diagnostic
 * (conformance / doctor)?".
 *
 *   - `owned`     → the path is in the adapter's trusted generated-write set
 *                   AND traverses no symlink → safe to resolve + read.
 *   - `unowned`   → the path is NOT one the adapter could have generated. A
 *                   forged manifest naming `.env` lands here.
 *   - `unsafe`    → the path resolves through a symlink (or escapes the root).
 *                   An in-project `.claude/skills -> ../../etc` redirect lands
 *                   here even if the lexical glob matched.
 *
 * On `owned`, `absPath` is the resolved, symlink-free absolute path to read.
 */
export type ManifestFileOwnership =
  | { kind: "owned"; absPath: string }
  | { kind: "unowned" }
  | { kind: "unsafe" };

/**
 * SECURITY (CWE-22/CWE-59/CWE-200 — forged-manifest file-content/SHA oracle):
 * a manifest is project-supplied and attacker-controllable. Its `files[].path`
 * is just a `RelativePosixPath`, so a hostile repo can list `path: .env` (or any
 * credential file) and have a diagnostic READ it and emit its SHA-256 / heading
 * substrings — a content oracle. This validator gates EVERY manifest-entry read
 * behind the SAME trusted authority the WRITER uses (`writePathGlobs ??
 * ownedPathGlobs` — the exact static set the adapter may create/overwrite), plus
 * the owned-path symlink guard. A path the adapter could never have generated is
 * `unowned` and is NEVER read; the diagnostic reports an ownership failure
 * instead of hashing or inspecting the file.
 *
 * This deliberately mirrors the install-time write guard
 * (adapter-install.ts: `allowedGlobs.some(matchGlob) && !pathTraversesSymlink`)
 * so the READ surface and the WRITE surface share one ownership definition.
 */
export async function classifyManifestFileForRead(
  cwd: string,
  descriptor: AdapterDescriptor,
  relPath: string,
): Promise<ManifestFileOwnership> {
  const allowedGlobs = descriptor.writePathGlobs ?? descriptor.ownedPathGlobs;
  if (!allowedGlobs.some((g) => matchGlob(g, relPath))) {
    return { kind: "unowned" };
  }
  try {
    // Rejects any symlink component (and `..` / absolute / drive paths): a
    // lexical glob match is not proof the real destination is owned.
    const absPath = await resolveOwnedProjectPath(cwd, relPath);
    return { kind: "owned", absPath };
  } catch {
    return { kind: "unsafe" };
  }
}
