import type { AgentProfile } from "../schemas/agent-profile.ts";
import type { AdapterDescriptor } from "./types.ts";

/**
 * Early validation that an agent profile's path fields are consistent with the
 * adapter descriptor's declared capabilities and owned paths. This catches
 * misconfigured or hostile profiles BEFORE the install/upgrade engine touches
 * the filesystem — e.g. a profile that declares `instruction_filename:
 * .env` is refused at the contract boundary, not after the generator has
 * already produced a desired file at that path.
 *
 * Checks:
 *  - `instruction_filename` must match an adapter-owned instruction or rule path.
 *    (Cursor uses `role: "rule"` for its instruction file; claude/codex/gemini
 *    use `role: "instruction"`.)
 *  - `context_dir` is already schema-constrained to `.context/**` (ContextOutputDir).
 *  - `skill_dir` (when present) must be a prefix of at least one owned skill path.
 *  - `hook_dir` (when present) must be a prefix of at least one owned hook path.
 */
export function validateAgentProfileForAdapter(
  profile: AgentProfile,
  descriptor: AdapterDescriptor,
): void {
  // instruction_filename must be one of the adapter's owned instruction or rule paths.
  const ownedInstructionPaths = Object.entries(descriptor.ownedPathRoles)
    .filter(([, role]) => role === "instruction" || role === "rule")
    .map(([path]) => path);

  if (!ownedInstructionPaths.includes(profile.instruction_filename)) {
    const e = new Error(
      `Agent profile instruction_filename "${profile.instruction_filename}" is not an owned instruction or rule path for this adapter. Expected one of: ${ownedInstructionPaths.join(", ")}`,
    );
    (e as NodeJS.ErrnoException).code = "CONFIG_ERROR";
    throw e;
  }

  // skill_dir (when present) must be a prefix of at least one owned skill path.
  if (profile.skill_dir !== undefined) {
    const ownedSkillPaths = Object.entries(descriptor.ownedPathRoles)
      .filter(([, role]) => role === "skill")
      .map(([path]) => path);

    if (ownedSkillPaths.length > 0) {
      const hasMatch = ownedSkillPaths.some(p =>
        p.startsWith(profile.skill_dir! + "/"),
      );
      if (!hasMatch) {
        const e = new Error(
          `Agent profile skill_dir "${profile.skill_dir}" does not contain any owned skill path for this adapter. Expected a prefix of: ${ownedSkillPaths.join(", ")}`,
        );
        (e as NodeJS.ErrnoException).code = "CONFIG_ERROR";
        throw e;
      }
    }
  }

  // hook_dir (when present) must be a prefix of at least one owned hook path.
  if (profile.hook_dir !== undefined) {
    const ownedHookPaths = Object.entries(descriptor.ownedPathRoles)
      .filter(([, role]) => role === "hook")
      .map(([path]) => path);

    if (ownedHookPaths.length > 0) {
      const hasMatch = ownedHookPaths.some(p =>
        p.startsWith(profile.hook_dir! + "/"),
      );
      if (!hasMatch) {
        const e = new Error(
          `Agent profile hook_dir "${profile.hook_dir}" does not contain any owned hook path for this adapter. Expected a prefix of: ${ownedHookPaths.join(", ")}`,
        );
        (e as NodeJS.ErrnoException).code = "CONFIG_ERROR";
        throw e;
      }
    }
  }
}
