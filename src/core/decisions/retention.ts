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

export type RetentionSource = "override" | "project" | "default";

export type ResolvedRetention = {
  /** The effective policy in force for this invocation. */
  policy: DecisionRetention;
  /** Where it came from: a `--policy` override, the project's `project.yaml`, or the built-in default. */
  source: RetentionSource;
};

function isRetention(v: unknown): v is DecisionRetention {
  return typeof v === "string" && (DECISION_RETENTION_VALUES as readonly string[]).includes(v);
}

/**
 * Tolerantly read `project.yaml`'s `decision_retention`. `decision prune` operates
 * on `design/decisions/`, so it must not hard-fail just because `project.yaml` is
 * absent, unparseable, or carries an out-of-enum value — those default to
 * `keep-full` here (and are surfaced separately by `validate` / `doctor`, which
 * parse the project through the strict schema). The same tolerance the author
 * reader uses for `collaboration.author`.
 */
export async function readDecisionRetention(cwd: string): Promise<ResolvedRetention> {
  try {
    const raw = await readFile(join(cwd, ".code-pact", "project.yaml"), "utf8");
    const doc = parseYaml(raw) as { decision_retention?: unknown } | null;
    const v = doc?.decision_retention;
    if (isRetention(v)) return { policy: v, source: "project" };
  } catch {
    // fall through to the default
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
