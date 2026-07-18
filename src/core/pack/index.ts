// Public entry for the context pack. `buildContextPack` reads the design files
// (via ./loaders), renders the Markdown body (via ./formatters/markdown),
// applies the optional byte budget (via ./budget), and — in explain mode —
// annotates the result (via ./explain). `writeContextPack` persists a built
// pack atomically. The loaders, budget elision, and explain machinery live in
// sibling modules; this file is the orchestration + public type surface.

import { join, isAbsolute } from "node:path";
import { atomicWriteText } from "../../io/atomic-text.ts";
import { resolvePhaseInRoadmap } from "../plan/resolve-phase.ts";
import { loadPhase } from "../plan/load-phase.ts";
import {
  makeReadDirectoryCountsProjection,
  makeRelatedDecisionCommitmentsProjection,
  renderSections,
  type ContextProjectionCandidate,
  type DependsOnEntry,
} from "./formatters/markdown.ts";
import { deriveTaskState } from "../progress/task-state.ts";
import { resolveProfileContextOutputPath } from "./context-output-path.ts";
import {
  resolveExplicitContextOutputWritePath,
  resolveExplicitProjectContextOutputWritePath,
  unbrand,
  type OwnedWritePath,
} from "../project-fs/authorities/context-output-authority.ts";
import {
  loadAgentProfile,
  loadConstitution,
  loadRules,
  loadDecisions,
  loadDoneEventsInPhase,
  loadAllProgressEvents,
  loadDeclaredDecisions,
  loadReadMatches,
} from "./loaders.ts";
import { applyBudgetElision } from "./budget.ts";
import type {
  DeferredContextMetadata,
  DeferredContextProjection,
} from "../context-deferral/deferred-section.ts";
import { deferredContextSectionLines } from "../context-deferral/deferred-section.ts";
import {
  validateContextManifestContent,
  type PendingContextManifestArtifact,
} from "../context-deferral/context-manifest.ts";
import { parseContextRef } from "../context-deferral/context-ref.ts";
import { contextError } from "../context-deferral/context-errors.ts";
import { storeContextManifestArtifact } from "../context-deferral/context-store.ts";
import {
  computeExplainSections,
  computeExplainExcluded,
  type ContextExplainSection,
  type ContextExplainExcluded,
  type ContextExplainMetrics,
} from "./explain.ts";

// Re-export the public budget error and explain types so external callers keep
// importing them from `core/pack/index.ts` unchanged.
export { ContextOverBudgetError } from "./budget.ts";
export type {
  ContextSectionReasonCode,
  ContextExcludedReasonCode,
  ContextExplainSection,
  ContextExplainExcluded,
  ContextExplainMetrics,
} from "./explain.ts";

export type BuildContextPackOptions = {
  cwd: string;
  phaseId: string;
  taskId: string;
  agentName: string;
  /**
   * When true, the result includes section-level metadata (`sections`,
   * `excluded`, `totalBytes`). The rendered `content` string is byte-
   * identical regardless of this flag.
   */
  explain?: boolean;
  /**
   * Optional budget enforcement. When set, sections elide in the
   * priority order locked in `src/core/pack/formatters/markdown.ts`
   * (`ELISION_ORDER`) until the pack's UTF-8 byte length falls at or
   * below `budgetBytes`. When the bound cannot be met after maximal
   * elision, `buildContextPack` throws `ContextOverBudgetError`.
   *
   * The no-flag default path is byte-identical (locked by
   * `tests/integration/pack-byte-identical.test.ts`).
   */
  budgetBytes?: number;
  /**
   * Output detail mode. `"minimal"` omits large optional sections
   * (rules, constitution, decision bodies, runbook prose, memory
   * details) and adds explicit retrieval commands. `"full"` (default)
   * retains the existing context pack surface.
   */
  detail?: "minimal" | "full";
};

export type ContextPackResult = {
  content: string;
  taskId: string;
  phaseId: string;
  agent: string;
  charCount: number;
  /**
   * UTF-8 byte length of `content`. Always populated. The acceptance
   * invariant `sum(sections[].bytes) === totalBytes` holds in explain
   * mode (the synthetic `format_overhead` section captures the
   * inter-section newlines).
   */
  totalBytes: number;
  includedRules: string[];
  includedDecisions: string[];
  includedConstitution: boolean;
  /** Present only when `explain: true` was passed to `buildContextPack`. */
  sections?: ContextExplainSection[];
  /** Present only when `explain: true` was passed to `buildContextPack`. */
  excluded?: ContextExplainExcluded[];
  /**
   * Explain metrics. Present only when `explain: true`. Byte-based and
   * deterministic; computing them does not change `content`.
   */
  explainMetrics?: ContextExplainMetrics;
  /**
   * Present only when an explicit budget deferred one or more sections.
   * This is public metadata only; it never includes deferred section content.
   */
  deferredContext?: DeferredContextMetadata;
  /**
   * Internal pending artifact for the caller that is allowed to materialize it
   * (`task prepare` normal mode). `task context`, dry-run prepare, and
   * buildContextPack itself must not write it.
   */
  pendingContextManifest?: PendingContextManifestArtifact;
};

export type { DeferredContextProjection };

export type WriteContextPackOptions = {
  cwd: string;
  agentName: string;
  /** Explicit caller-selected output directory, e.g. `pack --output-dir`. */
  outputDir?: string;
  /**
   * Already validated profile-derived context directory. When provided,
   * `writeContextPack` does not reload the agent profile and still resolves the
   * final path through the `.context/**` authority boundary.
   */
  profileContextDir?: string;
};

export type WriteContextPackResult = {
  outputPath: string;
};

function assertDeferredPackMaterializationPair(
  pack: ContextPackResult,
): PendingContextManifestArtifact | null {
  const metadata = pack.deferredContext;
  const artifact = pack.pendingContextManifest;
  if (!metadata && !artifact) return null;
  if (!metadata || !artifact) {
    throw contextError(
      "CONTEXT_INVALID",
      "context pack has incomplete deferred context materialization metadata",
    );
  }

  const digest = parseContextRef(metadata.manifest_ref);
  if (artifact.ref !== metadata.manifest_ref || artifact.digest !== digest) {
    throw contextError(
      "CONTEXT_INVALID",
      "context pack deferred context reference does not match pending artifact",
    );
  }

  const validated = validateContextManifestContent(
    artifact.content,
    artifact.digest,
  );
  const manifestSections = validated.manifest.sections.map(section => ({
    name: section.name,
    bytes: section.bytes,
  }));
  if (JSON.stringify(manifestSections) !== JSON.stringify(metadata.sections)) {
    throw contextError(
      "CONTEXT_INVALID",
      "context pack deferred context sections do not match pending artifact",
    );
  }

  const manifestLine = deferredContextSectionLines(metadata).find(line =>
    line.startsWith("Manifest reference: "),
  );
  if (!manifestLine || !pack.content.split("\n").includes(manifestLine)) {
    throw contextError(
      "CONTEXT_INVALID",
      "context pack content is missing its deferred context manifest reference",
    );
  }

  return validated;
}

/**
 * Pure-ish context pack builder. Reads design files and renders the
 * Markdown content along with metadata. Does NOT write to disk.
 *
 * Content selection is driven by task attributes:
 * - context_size: large  → includes design/constitution.md + all decisions
 * - context_size: small  → minimal (no rules, decisions, or constitution)
 * - ambiguity: high      → includes constitution.md + recent done events in phase
 * - write_surface: large → includes all rule files (bypasses applies_to filter)
 *
 * Throws an error with code "PHASE_NOT_FOUND" or "TASK_NOT_FOUND" when
 * the requested ids do not exist.
 */
export async function buildContextPack(
  opts: BuildContextPackOptions,
): Promise<ContextPackResult> {
  const { cwd, phaseId, taskId, agentName } = opts;
  const detail = opts.detail ?? "full";

  const ref = await resolvePhaseInRoadmap(cwd, phaseId);

  const phase = await loadPhase(cwd, ref.path);

  const task = phase.tasks?.find(t => t.id === taskId);
  if (!task) {
    const err = new Error(`Task "${taskId}" not found in phase "${phaseId}".`);
    (err as NodeJS.ErrnoException).code = "TASK_NOT_FOUND";
    throw err;
  }

  const isSmall = task.context_size === "small";
  const isLarge = task.context_size === "large";
  const isHighAmbiguity = task.ambiguity === "high";
  const isLargeWriteSurface = task.write_surface === "high";

  // In minimal detail mode, all heavy content loaders are skipped. The
  // render path still receives empty arrays so it can compute section
  // names and explain rows consistently.
  const includeConstitution = detail === "full" && (isLarge || isHighAmbiguity);
  const allDecisions = detail === "full" && isLarge;
  const allRules = detail === "full" && isLargeWriteSurface;

  // Task Readiness Schema declared sections. Each branch is a
  // no-op when the corresponding field is absent or empty, so the pack
  // output for a task that declares no new fields is byte-identical
  // (locked by tests/integration/pack-byte-identical.test.ts).
  const dependsOnIds = task.depends_on ?? [];
  const readGlobs = task.reads ?? [];
  const writeGlobsList = task.writes ?? [];
  const decisionRefs = task.decision_refs ?? [];
  const acceptanceRefsList = task.acceptance_refs ?? [];

  const [
    rules,
    decisions,
    constitution,
    doneEvents,
    allEvents,
    declaredDecisions,
    readMatches,
  ] = await Promise.all([
    isSmall || detail === "minimal"
      ? Promise.resolve([])
      : loadRules(cwd, task.type, allRules),
    isSmall || detail === "minimal"
      ? Promise.resolve([])
      : loadDecisions(cwd, taskId, allDecisions),
    includeConstitution ? loadConstitution(cwd) : Promise.resolve(null),
    detail === "full" && isHighAmbiguity
      ? loadDoneEventsInPhase(cwd, phase)
      : Promise.resolve([]),
    dependsOnIds.length > 0 ? loadAllProgressEvents(cwd) : Promise.resolve([]),
    detail === "full" && decisionRefs.length > 0
      ? loadDeclaredDecisions(cwd, decisionRefs)
      : Promise.resolve([]),
    detail === "full" && readGlobs.length > 0
      ? loadReadMatches(cwd, readGlobs)
      : Promise.resolve([]),
  ]);

  const dependsOn: DependsOnEntry[] | undefined =
    dependsOnIds.length > 0
      ? dependsOnIds.map(id => ({
          id,
          current: deriveTaskState(allEvents, id).current,
        }))
      : undefined;

  const allRendered = renderSections({
    phase,
    task,
    agentName,
    rules,
    decisions,
    constitution,
    doneEvents,
    detail,
    // Only attach the field on the render context when the task
    // actually declared the corresponding optional. Passing undefined
    // (vs an empty array) preserves byte-identical output for tasks
    // that declare none.
    ...(dependsOn !== undefined ? { dependsOn } : {}),
    ...(detail === "full" && readMatches.length > 0 ? { readMatches } : {}),
    ...(writeGlobsList.length > 0 ? { writeGlobs: writeGlobsList } : {}),
    ...(detail === "full" && declaredDecisions.length > 0
      ? { declaredDecisions }
      : {}),
    ...(acceptanceRefsList.length > 0
      ? { acceptanceRefs: acceptanceRefsList }
      : {}),
  });

  const naturalBytes = Buffer.byteLength(
    allRendered.flatMap(section => section.lines).join("\n"),
    "utf8",
  );
  const projectionCandidates: ContextProjectionCandidate[] =
    opts.budgetBytes !== undefined && naturalBytes > opts.budgetBytes
      ? [
          makeReadDirectoryCountsProjection(
            readMatches,
            allRendered.find(section => section.name === "reads"),
          ),
          isLarge
            ? makeRelatedDecisionCommitmentsProjection(
                decisions,
                declaredDecisions,
                allRendered.find(
                  section => section.name === "related_decisions",
                ),
              )
            : null,
        ].filter(
          (candidate): candidate is ContextProjectionCandidate =>
            candidate !== null,
        )
      : [];

  // Budget enforcement. When `budgetBytes` is set, elide sections
  // in `ELISION_ORDER` until the pack falls within budget; throw
  // `ContextOverBudgetError` if maximal elision still cannot meet it.
  // The no-budget path is byte-identical.
  const budgetResult = applyBudgetElision(
    allRendered,
    opts.budgetBytes,
    {
      isLarge,
      isLargeWriteSurface,
    },
    projectionCandidates,
  );
  const renderedSections = budgetResult.sections;
  const elidedNames = budgetResult.elidedNames;
  const elidedSectionsBytes = budgetResult.elidedBytes;

  const content = renderedSections.flatMap(s => s.lines).join("\n");
  const totalBytes = Buffer.byteLength(content, "utf8");

  const result: ContextPackResult = {
    content,
    taskId,
    phaseId,
    agent: agentName,
    charCount: content.length,
    totalBytes,
    includedRules: rules.map(r => r.filename),
    includedDecisions: decisions.map(d => d.filename),
    includedConstitution: constitution !== null,
    ...(budgetResult.deferredContext
      ? { deferredContext: budgetResult.deferredContext }
      : {}),
    ...(budgetResult.pendingContextManifest
      ? { pendingContextManifest: budgetResult.pendingContextManifest }
      : {}),
  };

  if (opts.explain === true) {
    const flags = {
      isSmall,
      isLarge,
      isHighAmbiguity,
      isLargeWriteSurface,
    };
    const declared = {
      dependsOn: dependsOnIds.length > 0,
      reads: readGlobs.length > 0,
      writes: writeGlobsList.length > 0,
      declaredDecisions: decisionRefs.length > 0,
      acceptanceRefs: acceptanceRefsList.length > 0,
    };
    result.sections = computeExplainSections(
      renderedSections,
      flags,
      totalBytes,
    );
    result.excluded = computeExplainExcluded(flags, declared);

    // Additive byte metrics. `saved_*` are the trivial projection of the
    // shared budget facts; `budgetBytes` is attached only when a budget was
    // actually applied (per-invocation, like the elision itself).
    const bm = budgetResult.metrics;
    const savedBytes = bm.naturalBytes - bm.finalBytes;
    result.explainMetrics = {
      naturalBytes: bm.naturalBytes,
      finalBytes: bm.finalBytes,
      ...(opts.budgetBytes !== undefined
        ? { budgetBytes: opts.budgetBytes }
        : {}),
      savedBytes,
      savedRatio: bm.naturalBytes === 0 ? 0 : savedBytes / bm.naturalBytes,
      minimumAchievableBytes: bm.minimumAchievableBytes,
      deferredBytes: bm.deferredBytes,
      elidedSections: bm.elidedSections,
    };

    // Any section elided by --budget-bytes appears in excluded[]
    // with `reason_code: budget_reserved_for_later`. The new entries are
    // appended after the policy-driven exclusions; a single
    // section can only be in one place (elision drops happen on
    // sections that would otherwise have been included, so there is
    // no double-counting).
    if (opts.budgetBytes !== undefined && elidedNames.length > 0) {
      for (const name of elidedNames) {
        result.excluded.push({
          name,
          reason_code: "budget_reserved_for_later",
          details: {
            elided_for_budget_bytes: opts.budgetBytes,
            section_bytes: elidedSectionsBytes.get(name) ?? 0,
          },
        });
      }
    }
  }

  return result;
}

/**
 * Writes a previously built ContextPackResult to disk under the agent's
 * configured `context_dir` (or an explicit outputDir override). Returns
 * the resolved outputPath.
 *
 * Profile-derived `context_dir` is constrained to the reserved `.context/**`
 * generated namespace and the FULL output path (directory + filename) is
 * resolved through symlink-free project containment via
 * `resolveProfileContextOutputPath`. An explicit `outputDir` is a deliberate
 * caller/CLI choice (`--output-dir`) and is resolved through
 * `resolveSymlinkFreeProjectPath` for containment only — it is NOT subject to
 * the `.context/**` namespace restriction but must still stay inside the
 * project and traverse no symlink.
 *
 * The write goes through `atomicWriteText` (temp-file + rename), so an
 * interrupted process can never leave a half-written pack on disk.
 */
export async function writeContextPack(
  pack: ContextPackResult,
  opts: WriteContextPackOptions,
): Promise<WriteContextPackResult> {
  const { cwd, agentName, outputDir, profileContextDir } = opts;
  if (outputDir !== undefined && profileContextDir !== undefined) {
    const err = new Error(
      "writeContextPack: outputDir and profileContextDir are mutually exclusive.",
    );
    (err as NodeJS.ErrnoException).code = "CONFIG_ERROR";
    throw err;
  }

  const pendingArtifact = assertDeferredPackMaterializationPair(pack);
  if (pendingArtifact) {
    await storeContextManifestArtifact(cwd, pendingArtifact);
  }

  if (outputDir !== undefined) {
    // Explicit --output-dir: caller authority, not profile-derived.
    // Absolute paths are used as-is (explicit user choice, e.g. /tmp).
    // Project-relative paths are resolved through symlink-free containment.
    if (isAbsolute(outputDir)) {
      const outputPath = resolveExplicitContextOutputWritePath(
        outputDir,
        `${pack.taskId}.md`,
      );
      await atomicWriteText(outputPath, pack.content);
      return { outputPath: unbrand(outputPath) };
    } else {
      const outputPath = await resolveExplicitProjectContextOutputWritePath(
        cwd,
        join(outputDir, `${pack.taskId}.md`),
      );
      await atomicWriteText(outputPath, pack.content);
      return { outputPath: unbrand(outputPath) };
    }
  } else {
    // Profile-derived: constrained to .context/** + symlink-free resolution
    // on the FULL path (directory + filename).
    const contextDir =
      profileContextDir ??
      (await loadAgentProfile(cwd, agentName))?.context_dir;
    const outputPath: OwnedWritePath = await resolveProfileContextOutputPath(
      cwd,
      contextDir ?? `.context/${agentName}`,
      pack.taskId,
    );
    await atomicWriteText(outputPath, pack.content);
    return { outputPath: unbrand(outputPath) };
  }
}
