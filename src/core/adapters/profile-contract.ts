import type { AgentProfile } from "../schemas/agent-profile.ts";
import type { AdapterDescriptor } from "./types.ts";

/**
 * Early validation that an agent profile's path fields are consistent with the
 * adapter descriptor's declared canonical values. This catches misconfigured or
 * hostile profiles BEFORE the install/upgrade engine touches the filesystem —
 * e.g. a profile that declares `instruction_filename: .env` is refused at the
 * contract boundary, not after the generator has already produced a desired
 * file at that path.
 *
 * Checks use **exact equality** against `descriptor.profilePathContract`:
 *  - `instruction_filename` must exactly match `contract.instructionFilename`.
 *  - `skill_dir` (when present) must exactly match `contract.skillDir` (if the
 *    contract defines one; if the contract has no skillDir, the profile must
 *    not declare one either).
 *  - `hook_dir` (when present) must exactly match `contract.hookDir` (same rule).
 *
 * The old prefix-based check (`p.startsWith(skill_dir + "/")`) allowed a
 * profile to declare `skill_dir: .` which would prefix-match any owned path.
 * Exact match eliminates that class of bypass.
 */
export function validateAgentProfileForAdapter(
  profile: AgentProfile,
  descriptor: AdapterDescriptor,
): void {
  const contract = descriptor.profilePathContract;

  if (profile.instruction_filename !== contract.instructionFilename) {
    const e = new Error(
      `Agent profile instruction_filename "${profile.instruction_filename}" does not match the canonical value "${contract.instructionFilename}" for this adapter.`,
    );
    (e as NodeJS.ErrnoException).code = "CONFIG_ERROR";
    throw e;
  }

  if (contract.skillDir !== undefined) {
    if (profile.skill_dir !== contract.skillDir) {
      const e = new Error(
        `Agent profile skill_dir "${profile.skill_dir ?? "(unset)"}" does not match the canonical value "${contract.skillDir}" for this adapter.`,
      );
      (e as NodeJS.ErrnoException).code = "CONFIG_ERROR";
      throw e;
    }
  } else if (profile.skill_dir !== undefined) {
    const e = new Error(
      `Agent profile declares skill_dir "${profile.skill_dir}" but this adapter does not support a skill_dir.`,
    );
    (e as NodeJS.ErrnoException).code = "CONFIG_ERROR";
    throw e;
  }

  if (contract.hookDir !== undefined) {
    if (profile.hook_dir !== contract.hookDir) {
      const e = new Error(
        `Agent profile hook_dir "${profile.hook_dir ?? "(unset)"}" does not match the canonical value "${contract.hookDir}" for this adapter.`,
      );
      (e as NodeJS.ErrnoException).code = "CONFIG_ERROR";
      throw e;
    }
  } else if (profile.hook_dir !== undefined) {
    const e = new Error(
      `Agent profile declares hook_dir "${profile.hook_dir}" but this adapter does not support a hook_dir.`,
    );
    (e as NodeJS.ErrnoException).code = "CONFIG_ERROR";
    throw e;
  }
}
