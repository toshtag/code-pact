import { readFile } from "../project-fs/raw-internal.ts";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { atomicWriteText } from "../../io/atomic-text.ts";
import { resolveSymlinkFreeProjectPath } from "../path-safety.ts";
import {
  brandOwnedWrite,
  type OwnedWritePath,
} from "../project-fs/branded-paths-internal.ts";
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

export function manifestRelPath(agentName: string): string {
  return [...ADAPTER_MANIFEST_DIR_SEGMENTS, `${agentName}.manifest.yaml`].join(
    "/",
  );
}

/**
 * Resolves the on-disk manifest path through {@link resolveSymlinkFreeProjectPath} so
 * `.code-pact/adapters` cannot be an in-project symlink alias for another
 * namespace. Throws (fail-closed) when the path escapes the project, traverses a
 * symlink, or `agentName` is structurally unsafe — callers must NOT treat that
 * throw as "manifest missing".
 */
export async function resolveManifestPath(
  cwd: string,
  agentName: string,
): Promise<OwnedWritePath> {
  try {
    return brandOwnedWrite(
      await resolveSymlinkFreeProjectPath(cwd, manifestRelPath(agentName)),
    );
  } catch (err) {
    // A path-containment refusal (a `.code-pact/adapters` symlink that escapes
    // the project) is an ADVERSARIAL but EXPECTED input — surface it as a clean
    // `ADAPTER_MANIFEST_INVALID` (the manifest state is unreachable/untrustable),
    // not as an uncoded throw that the CLI would render as an internal error.
    const e = new Error(
      `Adapter manifest path for "${agentName}" is not an owned project path and was refused: ${
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
  const schema = opts.tolerantDuplicatePaths
    ? AdapterManifestLenient
    : AdapterManifest;
  let parsed: AdapterManifest;
  try {
    parsed = schema.parse(parseYaml(raw) as unknown);
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
  // Identity check: the manifest's agent_name must match the agent being
  // inspected. A mismatch (e.g. a claude-code manifest read as "codex") is
  // either a file-name/agent-name confusion or a hostile swap — refuse it
  // before any caller acts on the manifest's file list.
  if (parsed.agent_name !== agentName) {
    const e = new Error(
      `Adapter manifest at ${path} has agent_name "${parsed.agent_name}" but was read as "${agentName}" — agent identity mismatch`,
    );
    (e as NodeJS.ErrnoException).code = "ADAPTER_MANIFEST_INVALID";
    throw e;
  }
  return parsed;
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
  const planned = await planManifestWrite(cwd, agentName, manifest);
  await atomicWriteText(planned.path, planned.content);
  return planned.path;
}

export async function planManifestWrite(
  cwd: string,
  agentName: string,
  manifest: AdapterManifest,
): Promise<{ path: OwnedWritePath; content: string }> {
  // Fail closed before writing a byte if `.code-pact/adapters` resolves outside
  // the project (symlink escape) — never write a manifest outside cwd.
  // Always re-resolve: a preflight check earlier in the call sequence does NOT
  // substitute for a fresh symlink-free resolution at write time (TOCTOU).
  const path = await resolveManifestPath(cwd, agentName);
  const parsed = AdapterManifest.parse(manifest);
  // Identity check: refuse to write a manifest whose agent_name doesn't match
  // the target agent — never persist a cross-agent manifest under another
  // agent's path.
  if (parsed.agent_name !== agentName) {
    const e = new Error(
      `Refusing to write manifest for "${agentName}" — manifest agent_name is "${parsed.agent_name}" (identity mismatch)`,
    );
    (e as NodeJS.ErrnoException).code = "ADAPTER_MANIFEST_INVALID";
    throw e;
  }
  return { path, content: stringifyYaml(parsed) };
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
