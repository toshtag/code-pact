import { stringify as toYaml } from "yaml";
import { atomicWriteText } from "../../io/atomic-text.ts";
import {
  ACCEPTED_MODEL_VERSION_INPUTS,
  AgentProfile,
  normalizeModelVersion,
} from "../schemas/agent-profile.ts";
import { resolveOwnedAgentProfilePath } from "../agent-profile-path.ts";

/**
 * Validates a `--model` input and returns its canonical form, or throws a
 * CONFIG_ERROR when the value is not recognized. No filesystem access — call
 * this before any mutation so an unknown `--model` fails before anything is
 * written. `undefined` input passes through unchanged (no `--model` given).
 */
export function validateModelVersionInput(
  input: string | undefined,
): string | undefined {
  if (input === undefined) return undefined;
  const normalized = normalizeModelVersion(input);
  if (normalized === null) {
    const err = new Error(
      `Unknown --model "${input}". Accepted values: ${ACCEPTED_MODEL_VERSION_INPUTS.join(", ")}.`,
    );
    (err as NodeJS.ErrnoException).code = "CONFIG_ERROR";
    throw err;
  }
  return normalized;
}

/**
 * Resolves the effective model version for an install/upgrade and, when a
 * `--model` value was supplied, PERSISTS it to the agent profile's
 * `model_version` field so `adapter doctor`'s remediation is honest and the
 * pin survives future generation.
 *
 * Validation happens first (via {@link validateModelVersionInput}); an unknown
 * value throws CONFIG_ERROR before the profile — or anything else — is touched.
 * The in-memory `profile` is updated so the caller's fingerprint reflects the
 * new pin. When no `--model` is given, the profile's existing `model_version`
 * is returned and nothing is written.
 */
export async function resolveAndPinModelVersion(opts: {
  cwd: string;
  agentName: string;
  profile: AgentProfile;
  modelVersionInput: string | undefined;
}): Promise<string | undefined> {
  const { cwd, agentName, profile, modelVersionInput } = opts;
  const normalized = validateModelVersionInput(modelVersionInput);
  if (normalized === undefined) return profile.model_version;
  if (normalized !== profile.model_version) {
    profile.model_version = normalized;
    await atomicWriteText(
      await resolveOwnedAgentProfilePath(cwd, agentName),
      toYaml(AgentProfile.parse(profile)),
    );
  }
  return normalized;
}
