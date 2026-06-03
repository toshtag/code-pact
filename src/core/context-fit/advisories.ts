// P50 (Context Fit, layer d). Four opt-in, non-exit-affecting `plan lint
// --include-quality` advisories that flag likely context-size risk before a
// task runs (design/decisions/context-fit-rfc.md § Layer (d)):
//
//   TASK_CONTEXT_PACK_LARGE          natural (pre-elision) pack > balanced budget
//   TASK_CONTEXT_BUDGET_UNACHIEVABLE recommended budget < minimum achievable floor
//   TASK_DECLARED_DECISION_LARGE     a decision_refs body larger than the tight budget
//   TASK_READS_MATCH_TOO_MANY        a reads glob matches more files than the cap
//
// Every advisory is `affects_exit: false` (severity "warning"), mirroring the
// P36 advisory pattern: it never changes the exit code, even under `--strict`.
// All thresholds are deterministic byte/count values (this module is their one
// runtime source of truth). The pass is local and offline — it reads existing
// project/task data, builds each task's pack once via the unchanged P49 explain
// path, and caches per-run reads. No network, model, tokenizer, summarization,
// compression, semantic ranking, or embeddings is involved, and no writes occur.
//
// This is a READINESS layer, not a gate: a large pack, a large decision
// reference, or a broad reads glob can all be legitimate. The advisories
// surface size risk; they never block work or apply a budget automatically.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildContextPack } from "../pack/index.ts";
import { recommendContextFit } from "../recommend/context-fit.ts";
import { STANDARD_CONTEXT_BUDGET_PROFILES } from "./budget-profiles.ts";
import { validateGlobSyntax, walkAndMatch } from "../glob.ts";
import { assertSafeRelativePath } from "../path-safety.ts";
import type { PhaseEntry } from "../plan/state.ts";
import type { PlanIssue } from "../plan/shared.ts";

/**
 * The single runtime source of truth for the P50 advisory thresholds. The byte
 * thresholds derive from the standard profile vocabulary (P47) so they stay in
 * lockstep with the budget contract; the reads cap is a fixed file count. Docs
 * and tests MAY repeat these values as public contract assertions — that locks
 * the contract, it does not create a second runtime source.
 */
export const CONTEXT_FIT_ADVISORY_THRESHOLDS = {
  /**
   * TASK_CONTEXT_PACK_LARGE: a natural pack above the `balanced` fallback
   * budget (60000 bytes) is flagged — most tasks fit under `balanced`, so
   * exceeding it is the documented "consider a wider profile / review scope"
   * signal.
   */
  largeContextBalancedBytes: STANDARD_CONTEXT_BUDGET_PROFILES.balanced,
  /**
   * TASK_DECLARED_DECISION_LARGE: a single decision body larger than the
   * `tight` budget (30000 bytes) would by itself dominate a tight context
   * pack. Byte-based, not a subjective ADR-quality judgment.
   */
  largeDecisionBytes: STANDARD_CONTEXT_BUDGET_PROFILES.tight,
  /**
   * TASK_READS_MATCH_TOO_MANY: a reads glob matching more than this many files
   * may inflate context planning cost. A broad reads glob can be valid (e.g. a
   * cross-cutting refactor), so this is advisory only.
   */
  readsMatchCount: 100,
} as const;

export type ContextFitAdvisoryOptions = {
  cwd: string;
  phases: PhaseEntry[];
  /**
   * The resolved default agent name used for the pack-size builds. When
   * undefined (no readable project.yaml / default_agent), the two pack-size
   * advisories (TASK_CONTEXT_PACK_LARGE / TASK_CONTEXT_BUDGET_UNACHIEVABLE) are
   * skipped; the file/glob advisories still run.
   */
  agentName: string | undefined;
  /**
   * The default agent profile's `context_budget.profiles` block, best-effort
   * resolved at the lint boundary. Passed through to the P48 recommendation so
   * `TASK_CONTEXT_BUDGET_UNACHIEVABLE` judges against the SAME recommended byte
   * value `recommend` / `task prepare` surface — a same-named standard profile
   * override wins over the built-in fallback, exactly as P48 resolves it. Omit
   * (undefined) to use built-in fallback bytes (no override, or none readable).
   */
  agentContextBudgetProfiles?: Record<string, { max_bytes: number }>;
};

/** A repo-root-relative POSIX path is safe (the lint path-safety contract). */
function isSafePath(path: string): boolean {
  try {
    assertSafeRelativePath(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Compute the four P50 context-fit advisories. Pure-ish: reads files and
 * expands globs (with per-run caches) but performs no writes and no network.
 * Any per-task error (e.g. a phase missing from the roadmap, an unreadable
 * file) is swallowed so the advisory pass never masks or duplicates a real
 * validation error that the structural detectors already report.
 */
export async function detectContextFitAdvisories(
  opts: ContextFitAdvisoryOptions,
): Promise<PlanIssue[]> {
  const { cwd, phases, agentName, agentContextBudgetProfiles } = opts;
  const issues: PlanIssue[] = [];

  // Per-run caches so a repeated decision path / reads glob is measured once,
  // and a task's pack is built at most once. Scoped to this invocation only —
  // nothing is written to disk.
  const fileBytesCache = new Map<string, number | null>();
  const globCountCache = new Map<string, number>();
  const packMetricsCache = new Map<
    string,
    { naturalBytes: number; minimumAchievableBytes: number } | null
  >();

  for (const { phase } of phases) {
    for (const task of phase.tasks ?? []) {
      // --- TASK_DECLARED_DECISION_LARGE -----------------------------------
      const decisionRefs = task.decision_refs ?? [];
      for (let i = 0; i < decisionRefs.length; i++) {
        const ref = decisionRefs[i]!;
        // An unsafe or missing decision ref is already reported by the
        // dedicated structural detectors (TASK_DECISION_REF_UNSAFE_PATH /
        // TASK_DECISION_REF_NOT_FOUND). Skip those here to avoid a misleading
        // duplicate advisory.
        if (!isSafePath(ref)) continue;
        let bytes = fileBytesCache.get(ref);
        if (bytes === undefined) {
          try {
            const content = await readFile(join(cwd, ref), "utf8");
            bytes = Buffer.byteLength(content, "utf8");
          } catch {
            bytes = null; // missing/unreadable → not our advisory to raise
          }
          fileBytesCache.set(ref, bytes);
        }
        if (bytes !== null && bytes > CONTEXT_FIT_ADVISORY_THRESHOLDS.largeDecisionBytes) {
          issues.push({
            code: "TASK_DECLARED_DECISION_LARGE",
            severity: "warning",
            affects_exit: false,
            message: `Task "${task.id}" decision reference "${ref}" is large enough to dominate a tight context budget (${bytes} bytes > ${CONTEXT_FIT_ADVISORY_THRESHOLDS.largeDecisionBytes} bytes). Consider splitting follow-up tasks, using a wider profile, or confirming the task scope justifies it.`,
            phase_id: phase.id,
            task_id: task.id,
            path: `decision_refs[${i}]`,
            details: {
              path: ref,
              bytes,
              threshold_bytes: CONTEXT_FIT_ADVISORY_THRESHOLDS.largeDecisionBytes,
            },
          });
        }
      }

      // --- TASK_READS_MATCH_TOO_MANY --------------------------------------
      const readGlobs = task.reads ?? [];
      for (let i = 0; i < readGlobs.length; i++) {
        const glob = readGlobs[i]!;
        // Skip entries the structural reads detectors already flag (unsafe
        // path or unsupported glob syntax) — those are real errors, not a
        // size advisory.
        if (!isSafePath(glob)) continue;
        if (validateGlobSyntax(glob) !== null) continue;
        let count = globCountCache.get(glob);
        if (count === undefined) {
          count = (await walkAndMatch(cwd, glob)).length;
          globCountCache.set(glob, count);
        }
        if (count > CONTEXT_FIT_ADVISORY_THRESHOLDS.readsMatchCount) {
          issues.push({
            code: "TASK_READS_MATCH_TOO_MANY",
            severity: "warning",
            affects_exit: false,
            message: `Task "${task.id}" reads glob "${glob}" matches many files (${count} > ${CONTEXT_FIT_ADVISORY_THRESHOLDS.readsMatchCount}) and may inflate context planning cost. Consider narrowing the glob if the task can be scoped more precisely.`,
            phase_id: phase.id,
            task_id: task.id,
            path: `reads[${i}]`,
            details: {
              glob,
              match_count: count,
              threshold_count: CONTEXT_FIT_ADVISORY_THRESHOLDS.readsMatchCount,
            },
          });
        }
      }

      // --- pack-size advisories (need a built pack) -----------------------
      // TASK_CONTEXT_PACK_LARGE + TASK_CONTEXT_BUDGET_UNACHIEVABLE both derive
      // from one context-pack build (P49 explain metrics: natural_bytes and
      // the shared minimum_achievable_bytes floor). Skip when no agent could
      // be resolved — a pack build needs an agent name.
      if (agentName === undefined) continue;
      const cacheKey = JSON.stringify([phase.id, task.id]);
      let metrics = packMetricsCache.get(cacheKey);
      if (metrics === undefined) {
        try {
          const pack = await buildContextPack({
            cwd,
            phaseId: phase.id,
            taskId: task.id,
            agentName,
            explain: true,
          });
          metrics = pack.explainMetrics
            ? {
                naturalBytes: pack.explainMetrics.naturalBytes,
                minimumAchievableBytes: pack.explainMetrics.minimumAchievableBytes,
              }
            : null;
        } catch {
          // A phase missing from the roadmap, a not-found task, or any other
          // build error is not a context-fit advisory — skip silently so we
          // never duplicate or mask the structural error.
          metrics = null;
        }
        packMetricsCache.set(cacheKey, metrics);
      }
      if (metrics === null) continue;

      if (metrics.naturalBytes > CONTEXT_FIT_ADVISORY_THRESHOLDS.largeContextBalancedBytes) {
        // The pack already exceeds the `balanced` budget, so the actionable
        // suggestion is the next standard profile above it: `wide`.
        issues.push({
          code: "TASK_CONTEXT_PACK_LARGE",
          severity: "warning",
          affects_exit: false,
          message: `Task "${task.id}" context pack is larger than the balanced context budget (${metrics.naturalBytes} bytes > ${CONTEXT_FIT_ADVISORY_THRESHOLDS.largeContextBalancedBytes} bytes). Consider using a wider profile or reviewing the task scope.`,
          phase_id: phase.id,
          task_id: task.id,
          details: {
            natural_bytes: metrics.naturalBytes,
            threshold_bytes: CONTEXT_FIT_ADVISORY_THRESHOLDS.largeContextBalancedBytes,
            recommended_profile: "wide",
          },
        });
      }

      // TASK_CONTEXT_BUDGET_UNACHIEVABLE: compare the deterministically
      // recommended budget (P48 mapping; built-in fallback bytes) against the
      // shared minimum-achievable floor. Fires only when even maximal eligible
      // elision cannot reach the recommended budget.
      const recommendation = recommendContextFit({
        contextSize: task.context_size,
        ambiguity: task.ambiguity,
        writeSurface: task.write_surface,
        ...(task.requires_decision !== undefined
          ? { requiresDecision: task.requires_decision }
          : {}),
        ...(agentContextBudgetProfiles !== undefined
          ? { agentContextBudgetProfiles }
          : {}),
      });
      if (metrics.minimumAchievableBytes > recommendation.recommendedBudgetBytes) {
        issues.push({
          code: "TASK_CONTEXT_BUDGET_UNACHIEVABLE",
          severity: "warning",
          affects_exit: false,
          message: `Task "${task.id}" recommended context budget may be unachievable: even after maximal eligible elision the pack floor is ${metrics.minimumAchievableBytes} bytes, above the ${recommendation.recommendedProfile} budget (${recommendation.recommendedBudgetBytes} bytes). Consider a wider profile or splitting the task.`,
          phase_id: phase.id,
          task_id: task.id,
          details: {
            profile: recommendation.recommendedProfile,
            budget_bytes: recommendation.recommendedBudgetBytes,
            minimum_achievable_bytes: metrics.minimumAchievableBytes,
          },
        });
      }
    }
  }

  return issues;
}
