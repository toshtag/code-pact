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
  /**
   * STATIC namespace globs the generator may auto-OVERWRITE (re-render a
   * managed-clean-but-stale generated file). Defaults to {@link ownedPathGlobs}
   * when omitted. This is SEPARATE from (and may be broader than) the delete gate:
   * an overwrite writes the GENERATOR's own benign output, so the conventional
   * generated namespace (e.g. `.claude/skills/*.md` for dynamic skills) is safe
   * here, whereas the delete gate must stay narrow. It is matched against the
   * GENERATED path, NOT the (attacker-controllable) profile fields, so a profile
   * that redirects `instruction_filename`/`skill_dir` at an arbitrary in-project
   * file (e.g. `package.json`) produces a path OUTSIDE this namespace → refused,
   * never overwritten on a project-supplied manifest's say-so (CWE-345/CWE-22).
   */
  overwriteOwnedPathGlobs?: readonly string[];
  adapterSchemaVersion: number;
};
