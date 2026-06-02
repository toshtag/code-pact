import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { Project } from "../core/schemas/project.ts";
import {
  EXPERIMENTAL_AGENTS,
  SUPPORTED_AGENTS,
  type SupportedAgent,
} from "../core/agents.ts";
import { manifestPath, readManifest } from "../core/adapters/manifest.ts";
import { resolveAgentProfilePath } from "../core/agent-profile-path.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AdapterListEntry = {
  name: SupportedAgent;
  /** Always true — every entry comes from the SUPPORTED_AGENTS registry. */
  supported: true;
  /** True for adapters in EXPERIMENTAL_AGENTS (cursor, gemini-cli). */
  experimental: boolean;
  /** True if listed under project.yaml `agents:` with enabled != false. */
  enabled: boolean;
  /** Absolute manifest path even when the file does not exist. */
  manifestPath: string;
  /** Absolute profile path even when the file does not exist. */
  profilePath: string;
  manifestPresent: boolean;
  /** Set only when manifestPresent and the YAML failed to parse/validate. */
  manifestInvalid?: true;
  /** Number of files recorded in the manifest. Undefined when no manifest. */
  fileCount?: number;
  /** ISO-8601 timestamp from the manifest's `generated_at`. */
  lastGeneratedAt?: string;
  /** Recorded `generator_version` from the manifest. */
  generatorVersion?: string;
};

export type AdapterListResult = {
  agents: AdapterListEntry[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loadEnabledAgentNames(cwd: string): Promise<Set<string>> {
  try {
    const raw = await readFile(join(cwd, ".code-pact", "project.yaml"), "utf8");
    const project = Project.parse(parseYaml(raw) as unknown);
    const names = new Set<string>();
    for (const a of project.agents) {
      if (a.enabled !== false) names.add(a.name);
    }
    return names;
  } catch {
    // Missing or malformed project.yaml → no agents are enabled. The CLI
    // bare-form / `adapter install` will surface AGENT_NOT_FOUND later
    // when the user actually tries to install.
    return new Set<string>();
  }
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

/**
 * Enumerates every registered adapter with its profile path, manifest
 * state, enabled flag (from project.yaml), and experimental flag. Does
 * NOT throw on missing project.yaml or malformed manifest — it surfaces
 * the situation in the result so the caller (agent or human) can see
 * what's there. Manifest validation details belong to `adapter doctor`
 * (P7-T4); list just answers "does it exist and how many files".
 */
export async function runAdapterList(opts: {
  cwd: string;
}): Promise<AdapterListResult> {
  const { cwd } = opts;
  const enabled = await loadEnabledAgentNames(cwd);
  const agents: AdapterListEntry[] = [];

  for (const name of SUPPORTED_AGENTS) {
    // Honor a non-default `agents[].profile` from project.yaml (matching doctor
    // and the adapter/recommend commands). A matched agent whose profile is an
    // invalid path surfaces as CONFIG_ERROR (consistent with the other
    // commands) rather than being masked behind a plausible default path —
    // adapter list's non-throwing contract covers missing project.yaml /
    // malformed manifests, not an explicitly invalid project config path.
    const profilePath = await resolveAgentProfilePath(cwd, name);
    const mPath = manifestPath(cwd, name);

    let manifestPresent = false;
    let manifestInvalid = false;
    let fileCount: number | undefined;
    let lastGeneratedAt: string | undefined;
    let generatorVersion: string | undefined;

    try {
      const m = await readManifest(cwd, name);
      if (m !== null) {
        manifestPresent = true;
        fileCount = m.files.length;
        lastGeneratedAt = m.generated_at;
        generatorVersion = m.generator_version;
      }
    } catch {
      // readManifest throws on YAML parse error or schema violation. We
      // surface that as manifestPresent + manifestInvalid; doctor will
      // emit ADAPTER_MANIFEST_INVALID with the parse detail.
      manifestPresent = true;
      manifestInvalid = true;
    }

    const entry: AdapterListEntry = {
      name,
      supported: true,
      experimental: EXPERIMENTAL_AGENTS.has(name),
      enabled: enabled.has(name),
      manifestPath: mPath,
      profilePath,
      manifestPresent,
    };
    if (manifestInvalid) entry.manifestInvalid = true;
    if (fileCount !== undefined) entry.fileCount = fileCount;
    if (lastGeneratedAt !== undefined) entry.lastGeneratedAt = lastGeneratedAt;
    if (generatorVersion !== undefined) entry.generatorVersion = generatorVersion;

    agents.push(entry);
  }

  return { agents };
}
