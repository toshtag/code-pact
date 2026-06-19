import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { atomicWriteText } from "../../io/atomic-text.ts";
import { resolveWithinProject } from "../path-safety.ts";
import {
  AdapterManifest,
  AdapterManifestLenient,
} from "../schemas/adapter-manifest.ts";

// ---------------------------------------------------------------------------
// Per-agent manifest paths
// ---------------------------------------------------------------------------

export const ADAPTER_MANIFEST_DIR_SEGMENTS = [".code-pact", "adapters"];

/**
 * LEXICAL manifest path — a display / synchronous helper only. It does NOT
 * touch the filesystem, so it does not guard against symlink escape. Real I/O
 * (readManifest / writeManifest) routes through {@link resolveManifestPath},
 * which fails closed when `.code-pact/adapters` resolves outside the project.
 */
export function manifestPath(cwd: string, agentName: string): string {
  return join(
    cwd,
    ...ADAPTER_MANIFEST_DIR_SEGMENTS,
    `${agentName}.manifest.yaml`,
  );
}

/**
 * Resolves the on-disk manifest path through {@link resolveWithinProject} so a
 * symlinked `.code-pact/adapters` (or a symlinked manifest file) cannot make a
 * read or write escape the project root. Throws (fail-closed) when the path
 * resolves outside the project or `agentName` is structurally unsafe — callers
 * must NOT treat that throw as "manifest missing".
 */
async function resolveManifestPath(cwd: string, agentName: string): Promise<string> {
  try {
    return await resolveWithinProject(
      cwd,
      [...ADAPTER_MANIFEST_DIR_SEGMENTS, `${agentName}.manifest.yaml`].join("/"),
    );
  } catch (err) {
    // A path-containment refusal (a `.code-pact/adapters` symlink that escapes
    // the project) is an ADVERSARIAL but EXPECTED input — surface it as a clean
    // `ADAPTER_MANIFEST_INVALID` (the manifest state is unreachable/untrustable),
    // not as an uncoded throw that the CLI would render as an internal error.
    const e = new Error(
      `Adapter manifest path for "${agentName}" resolves outside the project root and was refused: ${
        (err as Error).message
      }`,
    );
    (e as NodeJS.ErrnoException).code = "ADAPTER_MANIFEST_INVALID";
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Read / Write
// ---------------------------------------------------------------------------

export type ReadManifestOptions = {
  /**
   * When true, parse with the lenient schema that does NOT reject duplicate
   * `files[].path` entries. Only the `adapter install`/`adapter upgrade`
   * repair paths set this so they can read a legacy duplicate-path manifest,
   * regenerate unique desired files, and write a clean manifest. All other
   * callers (doctor, list, conformance) use the strict default, which throws
   * on duplicates so they can report ADAPTER_MANIFEST_INVALID.
   */
  tolerantDuplicatePaths?: boolean;
};

/**
 * Reads and zod-parses the adapter manifest at
 * `.code-pact/adapters/<agent>.manifest.yaml`. Returns `null` when the file
 * does not exist (fresh project / first install). Throws on any other I/O
 * failure or on YAML / schema parse errors so callers can map malformed
 * manifests to `ADAPTER_MANIFEST_INVALID`.
 */
export async function readManifest(
  cwd: string,
  agentName: string,
  opts: ReadManifestOptions = {},
): Promise<AdapterManifest | null> {
  // Resolve OUTSIDE the read try/catch: a symlink-escape throw must propagate
  // (fail-closed) rather than be swallowed as a missing-manifest `null`.
  const path = await resolveManifestPath(cwd, agentName);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    // Any OTHER read failure on a project-controlled (adversarial) manifest path
    // — the path is a directory (EISDIR), an intermediate component is a file
    // (ENOTDIR), it is unreadable (EACCES/EPERM), a symlink that passed
    // containment but then breaks on read, etc. — is tagged ADAPTER_MANIFEST_INVALID
    // so the command layer maps it to a structured envelope (exit 2) instead of
    // letting an uncoded errno surface as an internal error / exit 3. ENOENT alone
    // is "no manifest" (null); everything else is "manifest unreadable".
    const e = new Error(
      `Adapter manifest at ${path} cannot be read: ${(err as Error).message}`,
    );
    (e as NodeJS.ErrnoException).code = "ADAPTER_MANIFEST_INVALID";
    throw e;
  }
  const schema = opts.tolerantDuplicatePaths ? AdapterManifestLenient : AdapterManifest;
  try {
    return schema.parse(parseYaml(raw) as unknown);
  } catch (err) {
    // A project-controlled manifest with malformed YAML or a schema violation is
    // adversarial-but-expected input. Tag it `ADAPTER_MANIFEST_INVALID` so the
    // command layer (install / upgrade / doctor / list) maps it to a structured
    // envelope instead of letting an uncoded throw surface as an internal error.
    // `tolerantDuplicatePaths` still tolerates duplicate paths (no throw there).
    const e = new Error(
      `Adapter manifest at ${path} is malformed (YAML or schema): ${(err as Error).message}`,
    );
    (e as NodeJS.ErrnoException).code = "ADAPTER_MANIFEST_INVALID";
    throw e;
  }
}

/**
 * Atomically writes the adapter manifest. The input is validated through
 * `AdapterManifest` before any bytes hit disk so a caller mistake (extra
 * field, bad path, malformed sha256) fails loudly without corrupting the
 * on-disk state. Returns the absolute path written.
 */
export async function writeManifest(
  cwd: string,
  agentName: string,
  manifest: AdapterManifest,
): Promise<string> {
  // Fail closed before writing a byte if `.code-pact/adapters` resolves outside
  // the project (symlink escape) — never write a manifest outside cwd.
  const path = await resolveManifestPath(cwd, agentName);
  const parsed = AdapterManifest.parse(manifest);
  await atomicWriteText(path, stringifyYaml(parsed));
  return path;
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/**
 * sha256 hex of the LF-normalized UTF-8 bytes of `content`. CRLF line
 * endings are normalized to LF before hashing so the same logical content
 * does not surface as drift just because a user opened the file in an
 * editor that converted line endings. Output is 64 lowercase hex chars,
 * matching the `ManifestFile.sha256` regex.
 */
export function computeContentHash(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n");
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}
