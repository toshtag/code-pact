import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { atomicWriteText } from "../../io/atomic-text.ts";
import {
  AdapterManifest,
  AdapterManifestLenient,
} from "../schemas/adapter-manifest.ts";

// ---------------------------------------------------------------------------
// Per-agent manifest paths
// ---------------------------------------------------------------------------

export const ADAPTER_MANIFEST_DIR_SEGMENTS = [".code-pact", "adapters"];

export function manifestPath(cwd: string, agentName: string): string {
  return join(
    cwd,
    ...ADAPTER_MANIFEST_DIR_SEGMENTS,
    `${agentName}.manifest.yaml`,
  );
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
  const path = manifestPath(cwd, agentName);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const schema = opts.tolerantDuplicatePaths ? AdapterManifestLenient : AdapterManifest;
  return schema.parse(parseYaml(raw) as unknown);
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
  const path = manifestPath(cwd, agentName);
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
