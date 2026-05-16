import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { AgentProfile } from "../core/schemas/agent-profile.ts";
import { ModelProfile } from "../core/schemas/model-profile.ts";
import { adapterRegistry } from "../core/adapters/index.ts";
import { isSupportedAgent } from "../core/agents.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AdapterOptions = {
  cwd: string;
  agentName: string;
  force: boolean;
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
// Main
// ---------------------------------------------------------------------------

export async function runGenerateAdapter(opts: AdapterOptions): Promise<AdapterResult> {
  const { cwd, agentName, force } = opts;

  const [profile, modelProfiles] = await Promise.all([
    loadAgentProfile(cwd, agentName),
    loadModelProfiles(cwd),
  ]);

  if (!isSupportedAgent(agentName)) {
    const err = new Error(`No adapter implementation for agent "${agentName}".`);
    (err as NodeJS.ErrnoException).code = "AGENT_NOT_FOUND";
    throw err;
  }

  const generator = adapterRegistry[agentName];
  const result = await generator(cwd, profile, modelProfiles, force);

  return { agentName, ...result };
}
