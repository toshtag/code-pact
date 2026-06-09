import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  DECISION_RETENTION_VALUES,
  type DecisionRetention,
} from "../schemas/project.ts";

export { DECISION_RETENTION_VALUES, type DecisionRetention };

/** The shipped default — backward-compatible "keep ADRs forever". */
export const DEFAULT_DECISION_RETENTION: DecisionRetention = "keep-full";

export type RetentionSource = "override" | "project" | "default" | "invalid_project";

export type ResolvedRetention = {
  /** The effective policy in force for this invocation. */
  policy: DecisionRetention;
  /**
   * Where it came from: a `--policy` override, the project's `project.yaml`, the
   * built-in default (field absent), or `invalid_project` — the field is PRESENT
   * but out of enum (a typo). The last keeps `decision prune` honest: it reports
   * the broken config rather than masquerading as `default`.
   */
  source: RetentionSource;
};

function isRetention(v: unknown): v is DecisionRetention {
  return typeof v === "string" && (DECISION_RETENTION_VALUES as readonly string[]).includes(v);
}

/**
 * Tolerantly read `project.yaml`'s `decision_retention`. `decision prune` operates
 * on `design/decisions/`, so it must not hard-fail just because `project.yaml` is
 * absent, unparseable, or carries an out-of-enum value — those fall back to
 * `keep-full` here (and the out-of-enum value is surfaced separately by `validate`
 * / `doctor`, which parse the project through the strict schema, AND reported here
 * via `source: "invalid_project"`). The same tolerance the author reader uses for
 * `collaboration.author`.
 */
export async function readDecisionRetention(cwd: string): Promise<ResolvedRetention> {
  try {
    const raw = await readFile(join(cwd, ".code-pact", "project.yaml"), "utf8");
    const doc = parseYaml(raw) as unknown;
    if (doc && typeof doc === "object" && !Array.isArray(doc)) {
      // Key the decision on PRESENCE, not on the value: a present-but-empty field
      // (`decision_retention:` → YAML null) is a typo, NOT an absent field. The
      // strict schema rejects it (SCHEMA_ERROR), so reporting it as `default` here
      // would diverge from validate/doctor — surface it as `invalid_project` too.
      if (Object.prototype.hasOwnProperty.call(doc, "decision_retention")) {
        const v = (doc as Record<string, unknown>).decision_retention;
        if (isRetention(v)) return { policy: v, source: "project" };
        return { policy: DEFAULT_DECISION_RETENTION, source: "invalid_project" };
      }
    }
  } catch {
    // unreadable / unparseable → the built-in default
  }
  return { policy: DEFAULT_DECISION_RETENTION, source: "default" };
}

/** Resolve the effective policy: a `--policy` override wins, else the project/default. */
export async function resolveRetention(
  cwd: string,
  override?: DecisionRetention,
): Promise<ResolvedRetention> {
  if (override !== undefined) return { policy: override, source: "override" };
  return readDecisionRetention(cwd);
}
