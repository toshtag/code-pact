import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { parse as parseYaml } from "yaml";
import { AgentProfile } from "../core/schemas/agent-profile.ts";
import { ModelProfile } from "../core/schemas/model-profile.ts";
import { adapterRegistry } from "../core/adapters/index.ts";
import { isSupportedAgent } from "../core/agents.ts";
import type { DesiredAdapterFileRole } from "../core/adapters/types.ts";
import type { Locale } from "../i18n/index.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AdapterOptions = {
  cwd: string;
  agentName: string;
  force: boolean;
  locale: Locale;
  /** Override or set the Claude model version for model-aware CLAUDE.md generation. */
  modelVersion?: string;
  /** Regenerate skill files only (does not overwrite the main instruction file). */
  regenSkills?: boolean;
};

export type AdapterResult = {
  agentName: string;
  created: string[];
  skipped: string[];
};

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

async function loadAgentProfile(cwd: string, agentName: string): Promise<AgentProfile> {
  const path = join(cwd, ".code-pact", "agent-profiles", `${agentName}.yaml`);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    const err = new Error(`Agent profile for "${agentName}" not found at ${path}.`);
    (err as NodeJS.ErrnoException).code = "AGENT_NOT_FOUND";
    throw err;
  }
  return AgentProfile.parse(parseYaml(raw) as unknown);
}

async function loadModelProfiles(cwd: string): Promise<ModelProfile[]> {
  const dir = join(cwd, ".code-pact", "model-profiles");
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const profiles: ModelProfile[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".yaml")) continue;
    const raw = await readFile(join(dir, entry), "utf8");
    try {
      profiles.push(ModelProfile.parse(parseYaml(raw) as unknown));
    } catch {
      // skip malformed profiles
    }
  }
  return profiles;
}

// ---------------------------------------------------------------------------
// Write policy
// ---------------------------------------------------------------------------

function shouldOverwrite(
  role: DesiredAdapterFileRole,
  force: boolean,
  regenSkills: boolean,
): boolean {
  if (role === "skill") return force || regenSkills;
  return force;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runGenerateAdapter(opts: AdapterOptions): Promise<AdapterResult> {
  const { cwd, agentName, force, locale, modelVersion, regenSkills = false } = opts;

  if (!isSupportedAgent(agentName)) {
    const err = new Error(`No adapter implementation for agent "${agentName}".`);
    (err as NodeJS.ErrnoException).code = "AGENT_NOT_FOUND";
    throw err;
  }

  const [profile, modelProfiles] = await Promise.all([
    loadAgentProfile(cwd, agentName),
    loadModelProfiles(cwd),
  ]);

  const descriptor = adapterRegistry[agentName];
  const desiredFiles = await descriptor.generateDesiredFiles({
    cwd,
    profile,
    modelProfiles,
    locale,
    modelVersion,
  });

  // Directory placeholders. context_dir is required for every adapter so
  // context-pack output has a stable home. hook_dir is claude-only — we
  // ensure it whenever the profile sets it.
  await mkdir(join(cwd, profile.context_dir), { recursive: true });
  if (profile.hook_dir) {
    await mkdir(join(cwd, profile.hook_dir), { recursive: true });
  }

  const created: string[] = [];
  const skipped: string[] = [];

  for (const file of desiredFiles) {
    const absPath = join(cwd, file.path);
    const overwrite = shouldOverwrite(file.role, force, regenSkills);

    if (!overwrite) {
      try {
        await readFile(absPath);
        skipped.push(absPath);
        continue;
      } catch {
        // not present — fall through to write
      }
    }
    await mkdir(dirname(absPath), { recursive: true });
    await writeFile(absPath, file.content, "utf8");
    created.push(absPath);
  }

  return { agentName, created, skipped };
}
