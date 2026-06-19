import type { AgentProfile } from "../schemas/agent-profile.ts";
import type { ModelProfile } from "../schemas/model-profile.ts";
import type { Locale } from "../../i18n/index.ts";

export type AdapterCapability =
  | "instructions_file"
  | "skills_dir"
  | "hooks_dir"
  | "rules_file"
  | "context_dir";

export type DesiredAdapterFileRole = "instruction" | "skill" | "hook" | "rule";

export type DesiredAdapterFile = {
  path: string;
  role: DesiredAdapterFileRole;
  content: string;
};

export type AdapterGenerateInput = {
  cwd: string;
  profile: AgentProfile;
  modelProfiles: ModelProfile[];
  locale: Locale;
  modelVersion?: string;
};

export type AdapterDescriptor = {
  generateDesiredFiles(input: AdapterGenerateInput): Promise<DesiredAdapterFile[]>;
  capabilities: readonly AdapterCapability[];
  /**
   * STATIC paths the generator owns for the DELETE gate (orphan auto-prune, #6).
   * Deliberately NARROW (exact paths, no user-namespace globs) — a forged manifest
   * must never authorize deleting a user file. See the orphan-prune security note.
   */
  ownedPathGlobs: readonly string[];
  adapterSchemaVersion: number;
};
