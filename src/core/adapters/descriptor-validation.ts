import { RelativePosixPath } from "../schemas/relative-path.ts";
import type {
  AdapterCapability,
  AdapterDescriptor,
  DesiredAdapterFileRole,
} from "./types.ts";

const ROLE_BY_CAPABILITY: Partial<
  Record<AdapterCapability, DesiredAdapterFileRole>
> = {
  instructions_file: "instruction",
  rules_file: "rule",
};

const GLOB_META = /[*?[\]{}]/;

function descriptorError(agentName: string, message: string): Error {
  const err = new Error(`Invalid adapter descriptor for "${agentName}": ${message}`);
  (err as NodeJS.ErrnoException).code = "CONFIG_ERROR";
  return err;
}

function assertExactRelativePath(agentName: string, label: string, path: string): void {
  const parsed = RelativePosixPath.safeParse(path);
  if (!parsed.success) {
    throw descriptorError(agentName, `${label} "${path}" is not a relative POSIX path.`);
  }
  if (GLOB_META.test(path)) {
    throw descriptorError(agentName, `${label} "${path}" must be an exact path, not a glob.`);
  }
}

function hasCapability(
  descriptor: AdapterDescriptor,
  capability: AdapterCapability,
): boolean {
  return descriptor.capabilities.includes(capability);
}

export function validateAdapterDescriptor(
  agentName: string,
  descriptor: AdapterDescriptor,
): AdapterDescriptor {
  for (const [path, role] of Object.entries(descriptor.ownedPathRoles)) {
    assertExactRelativePath(agentName, "ownedPathRoles key", path);
    const roleAllowed =
      role === "skill"
        ? hasCapability(descriptor, "skills_dir")
        : role === "hook"
          ? hasCapability(descriptor, "hooks_dir")
          : Object.entries(ROLE_BY_CAPABILITY).some(
              ([capability, expectedRole]) =>
                role === expectedRole &&
                hasCapability(descriptor, capability as AdapterCapability),
            );
    if (!roleAllowed) {
      throw descriptorError(
        agentName,
        `owned path "${path}" has role "${role}" but the matching capability is not declared.`,
      );
    }
  }

  const instructionPath = descriptor.profilePathContract.instructionFilename;
  assertExactRelativePath(
    agentName,
    "profilePathContract.instructionFilename",
    instructionPath,
  );
  const instructionRole = descriptor.ownedPathRoles[instructionPath];
  if (instructionRole !== "instruction" && instructionRole !== "rule") {
    throw descriptorError(
      agentName,
      `profile instruction_filename "${instructionPath}" is not present in ownedPathRoles as an instruction or rule.`,
    );
  }

  if (descriptor.profilePathContract.skillDir !== undefined) {
    assertExactRelativePath(
      agentName,
      "profilePathContract.skillDir",
      descriptor.profilePathContract.skillDir,
    );
    if (!hasCapability(descriptor, "skills_dir")) {
      throw descriptorError(agentName, "skillDir is declared without the skills_dir capability.");
    }
  }

  if (descriptor.profilePathContract.hookDir !== undefined) {
    assertExactRelativePath(
      agentName,
      "profilePathContract.hookDir",
      descriptor.profilePathContract.hookDir,
    );
    if (!hasCapability(descriptor, "hooks_dir")) {
      throw descriptorError(agentName, "hookDir is declared without the hooks_dir capability.");
    }
  }

  return descriptor;
}
