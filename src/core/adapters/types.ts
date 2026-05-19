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
  ownedPathGlobs: readonly string[];
  adapterSchemaVersion: number;
};
