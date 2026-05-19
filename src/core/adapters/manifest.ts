import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { atomicWriteText } from "../../io/atomic-text.ts";
import { AdapterManifest } from "../schemas/adapter-manifest.ts";

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

/**
 * Reads and zod-parses the adapter manifest at
 * `.code-pact/adapters/<agent>.manifest.yaml`. Returns `null` when the file
 * does not exist (fresh project / first install). Throws on any other I/O
 * failure or on YAML / schema parse errors so callers can map malformed
 * manifests to `ADAPTER_MANIFEST_INVALID` in P7-T4.
 */
export async function readManifest(
  cwd: string,
  agentName: string,
): Promise<AdapterManifest | null> {
  const path = manifestPath(cwd, agentName);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  return AdapterManifest.parse(parseYaml(raw) as unknown);
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
