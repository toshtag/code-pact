import { RelativePosixPath } from "../schemas/relative-path.ts";
import { matchGlob, validateGlobSyntax } from "../glob.ts";
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
const PROTECTED_CREATE_PREFIXES = [".git/", ".code-pact/"] as const;

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

function assertCreateGlobPath(
  agentName: string,
  label: string,
  pattern: string,
): void {
  const syntax = validateGlobSyntax(pattern);
  if (syntax !== null) {
    throw descriptorError(agentName, `${label} "${pattern}" is invalid: ${syntax}.`);
  }
  if (
    pattern.startsWith("/") ||
    pattern.startsWith("~") ||
    /^[A-Za-z]:/.test(pattern)
  ) {
    throw descriptorError(
      agentName,
      `${label} "${pattern}" must be project-relative POSIX.`,
    );
  }
  const segments = pattern.split("/");
  if (
    segments.some(
      segment => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw descriptorError(
      agentName,
      `${label} "${pattern}" must not contain empty, "." or ".." segments.`,
    );
  }
  if (segments.includes("**")) {
    throw descriptorError(
      agentName,
      `${label} "${pattern}" must not use "**"; create authority must stay narrow.`,
    );
  }
  if (
    PROTECTED_CREATE_PREFIXES.some(
      prefix => pattern === prefix.slice(0, -1) || pattern.startsWith(prefix),
    )
  ) {
    throw descriptorError(
      agentName,
      `${label} "${pattern}" targets a protected namespace.`,
    );
  }
}

function hasCapability(
  descriptor: AdapterDescriptor,
  capability: AdapterCapability,
): boolean {
  return descriptor.capabilities.includes(capability);
}

function roleMatchesCapabilities(
  descriptor: AdapterDescriptor,
  role: DesiredAdapterFileRole,
): boolean {
  return role === "skill"
    ? hasCapability(descriptor, "skills_dir")
    : role === "hook"
      ? hasCapability(descriptor, "hooks_dir")
      : Object.entries(ROLE_BY_CAPABILITY).some(
          ([capability, expectedRole]) =>
            role === expectedRole &&
            hasCapability(descriptor, capability as AdapterCapability),
        );
}

function assertCreateGlobMatchesProfileContract(
  agentName: string,
  descriptor: AdapterDescriptor,
  role: DesiredAdapterFileRole,
  pattern: string,
): void {
  const contract = descriptor.profilePathContract;
  if (role === "skill" && contract.skillDir !== undefined) {
    if (!pattern.startsWith(`${contract.skillDir}/`)) {
      throw descriptorError(
        agentName,
        `create glob "${pattern}" for role "skill" must stay under skillDir "${contract.skillDir}".`,
      );
    }
  }
  if (role === "hook" && contract.hookDir !== undefined) {
    if (!pattern.startsWith(`${contract.hookDir}/`)) {
      throw descriptorError(
        agentName,
        `create glob "${pattern}" for role "hook" must stay under hookDir "${contract.hookDir}".`,
      );
    }
  }
}

export function validateAdapterDescriptor(
  agentName: string,
  descriptor: AdapterDescriptor,
): AdapterDescriptor {
  for (const [path, role] of Object.entries(descriptor.ownedPathRoles)) {
    assertExactRelativePath(agentName, "ownedPathRoles key", path);
    if (!roleMatchesCapabilities(descriptor, role)) {
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

  for (const [role, patterns] of Object.entries(
    descriptor.createPathGlobsByRole ?? {},
  ) as Array<[DesiredAdapterFileRole, readonly string[]]>) {
    if (!roleMatchesCapabilities(descriptor, role)) {
      throw descriptorError(
        agentName,
        `create globs declare role "${role}" but the matching capability is not declared.`,
      );
    }
    for (const pattern of patterns) {
      assertCreateGlobPath(agentName, `createPathGlobsByRole.${role}`, pattern);
      assertCreateGlobMatchesProfileContract(agentName, descriptor, role, pattern);
      for (const [ownedPath, ownedRole] of Object.entries(
        descriptor.ownedPathRoles,
      )) {
        if (matchGlob(pattern, ownedPath) && ownedRole !== role) {
          throw descriptorError(
            agentName,
            `create glob "${pattern}" for role "${role}" overlaps owned path "${ownedPath}" with role "${ownedRole}".`,
          );
        }
      }
    }
  }

  return descriptor;
}
