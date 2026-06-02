import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

// Optional per-project doctor configuration (`.code-pact/doctor.yaml`).
//
// Shared so every surface that honors a `disabled_checks` entry reads the same
// file the same way. In particular, `doctor` (which emits `MODEL_MAP_STALE`)
// and the `adapter upgrade --write` remaining-advisory hint (which re-surfaces
// it) must agree on suppression — otherwise a pin a team silenced via
// `disabled_checks: [MODEL_MAP_STALE]` would still nag from the upgrade hint,
// which even points the user back at the silence path they already used.
export const DoctorConfig = z.object({
  disabled_checks: z.array(z.string()).optional().default([]),
  // P34: team-declared escape hatch for CONTROL_PLANE_BRANCH_NOT_DRIVEN.
  // Default empty — no built-in docs/config exemption (a repo decides which
  // paths legitimately change without driving the loop).
  control_plane_branch_not_driven: z
    .object({
      exclude_globs: z.array(z.string()).optional().default([]),
    })
    .optional(),
});
export type DoctorConfig = z.infer<typeof DoctorConfig>;

/**
 * Read `.code-pact/doctor.yaml`. Tolerant: an absent, unreadable, or invalid
 * file yields the all-default config (no checks disabled), matching how a
 * project with no doctor.yaml behaves.
 */
export async function loadDoctorConfig(cwd: string): Promise<DoctorConfig> {
  const path = join(cwd, ".code-pact", "doctor.yaml");
  try {
    const raw = await readFile(path, "utf8");
    const parsed = DoctorConfig.safeParse(parseYaml(raw));
    if (parsed.success) return parsed.data;
  } catch {
    // file absent or unreadable — use defaults
  }
  return { disabled_checks: [] };
}

/** True when `code` appears in the project's `doctor.yaml` `disabled_checks`. */
export async function isDoctorCheckDisabled(
  cwd: string,
  code: string,
): Promise<boolean> {
  const config = await loadDoctorConfig(cwd);
  return config.disabled_checks.includes(code);
}
