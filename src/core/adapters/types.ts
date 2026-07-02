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

export type AdapterProfilePathContract = {
  instructionFilename: string;
  skillDir?: string;
  hookDir?: string;
};

export type AdapterDescriptor = {
  generateDesiredFiles(
    input: AdapterGenerateInput,
  ): Promise<DesiredAdapterFile[]>;
  capabilities: readonly AdapterCapability[];
  /**
   * Exact static read/hash/overwrite/delete authority. The key is NOT a glob —
   * it must be an exact path string. Adding a wildcard here would silently
   * expand read/delete authority to a shared namespace. A forged manifest
   * must never authorize reading or deleting a user file via this map.
   */
  ownedPathRoles: Readonly<Record<string, DesiredAdapterFileRole>>;
  /**
   * Role-scoped create-only authority: a missing target whose path matches one
   * of these globs AND whose role matches the key may be CREATED. This NEVER
   * grants authority to read, hash, overwrite, or delete an EXISTING file —
   * the shared namespace (e.g. `.claude/skills/*.md`) cannot prove ownership
   * of existing bytes.
   */
  createPathGlobsByRole?: Readonly<
    Partial<Record<DesiredAdapterFileRole, readonly string[]>>
  >;
  /**
   * Canonical profile path contract: the exact values an agent profile MUST
   * declare for this adapter. The validator checks exact equality (not prefix)
   * so a hostile profile cannot redirect instruction_filename, skill_dir, or
   * hook_dir to an unowned path.
   */
  profilePathContract: AdapterProfilePathContract;
  adapterSchemaVersion: number;
};
