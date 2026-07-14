// Budget enforcement for the context pack. Given the structured
// intermediate form from `renderSections` and an optional byte budget,
// `applyBudgetElision` returns the surviving sections, the names of any elided
// sections (in elision order), a name → byte-size map for them, and the
// byte metrics. Throws `ContextOverBudgetError` when maximal elision still
// leaves the pack above the requested bound.

import {
  ELISION_ORDER,
  type ContextProjectionCandidate,
  type RenderedSection,
} from "./formatters/markdown.ts";
import {
  buildContextManifest,
  type PendingContextManifestArtifact,
} from "../context-deferral/context-manifest.ts";
import {
  makeDeferredContextRenderedSection,
  type DeferredContextMetadata,
} from "../context-deferral/deferred-section.ts";

/**
 * Thrown by `buildContextPack` when `budgetBytes` is set but maximal
 * elision still leaves the pack above the requested bound. Carries
 * structured details so callers can adjust the budget or split the
 * task.
 */
export class ContextOverBudgetError extends Error {
  readonly code = "CONTEXT_OVER_BUDGET";
  readonly budget_bytes: number;
  readonly minimum_achievable_bytes: number;
  readonly unelidable_sections: ReadonlyArray<string>;
  constructor(
    budget: number,
    minimum: number,
    unelidable: ReadonlyArray<string>,
  ) {
    super(
      `Context pack cannot be reduced below ${minimum} bytes; --budget-bytes ${budget} is unachievable for this task.`,
    );
    this.name = "ContextOverBudgetError";
    this.budget_bytes = budget;
    this.minimum_achievable_bytes = minimum;
    this.unelidable_sections = unelidable;
  }
}

// Byte facts derived from one application of the budget path. Pure
// (UTF-8 byte counts only) and unit-testable. `saved_bytes` / `saved_ratio`
// are NOT stored here — they are a trivial projection the explain layer
// derives (see buildContextPack), keeping this struct to raw measured bytes.
export type BudgetElisionMetrics = {
  naturalBytes: number;
  finalBytes: number;
  minimumAchievableBytes: number;
  deferredBytes: number;
  elidedSections: Array<{ name: string; bytes: number }>;
};

export type BudgetElisionResult = {
  sections: RenderedSection[];
  elidedNames: string[];
  elidedBytes: Map<string, number>;
  metrics: BudgetElisionMetrics;
  deferredContext?: DeferredContextMetadata;
  pendingContextManifest?: PendingContextManifestArtifact;
};

// The readiness signals that gate conditional elision eligibility.
// `related_decisions` / `rules` are only elidable when they are the
// large-context / high-write-surface expansions — see applyBudgetElision.
export type BudgetElisionEligibility = {
  isLarge: boolean;
  isLargeWriteSurface: boolean;
};

const PROJECTION_ORDER = [
  "reads",
  "related_decisions",
] as const satisfies ReadonlyArray<ContextProjectionCandidate["sectionName"]>;

function computeRenderedBytes(sections: ReadonlyArray<RenderedSection>): number {
  if (sections.length === 0) return 0;
  return Buffer.byteLength(
    sections.flatMap((s) => s.lines).join("\n"),
    "utf8",
  );
}

function sectionBytes(section: RenderedSection): number {
  return Buffer.byteLength(section.lines.join("\n"), "utf8");
}

function insertDeferredContextSection(
  sections: ReadonlyArray<RenderedSection>,
  metadata: DeferredContextMetadata,
  projectedSections: ReadonlySet<ContextProjectionCandidate["sectionName"]> = new Set(),
): RenderedSection[] {
  const result = [...sections];
  const taskDefinitionIndex = result.findIndex(
    section => section.name === "task_definition",
  );
  const insertAt =
    taskDefinitionIndex === -1 ? Math.min(1, result.length) : taskDefinitionIndex + 1;
  result.splice(
    insertAt,
    0,
    makeDeferredContextRenderedSection(metadata, { projectedSections }),
  );
  return result;
}

// Elision ELIGIBILITY is conditional, per context-budget-rfc.md.
// `related_decisions` is elidable only when it is the `context_size: large`
// "all decisions" expansion; `rules` only when it is the `write_surface: high`
// "all rules" expansion. Outside those expansions the section holds task-id-
// matched decisions / applies_to-matched rules the RFC marks unelidable —
// dropping them for budget would silently remove context the task opted into.
// The priority (ELISION_ORDER) is unchanged; only the eligible subset narrows
// per invocation. This is the SINGLE source of the eligible set: both the
// elision loop and the minimum-achievable floor read it.
function eligibleElisionOrder(eligibility: BudgetElisionEligibility): string[] {
  return ELISION_ORDER.filter((name) => {
    if (name === "related_decisions") return eligibility.isLarge;
    if (name === "rules") return eligibility.isLargeWriteSurface;
    return true;
  });
}

function computeMinimumAchievableBytesWithDeferral(
  rendered: ReadonlyArray<RenderedSection>,
  eligibility: BudgetElisionEligibility,
): number {
  const eligible = new Set(eligibleElisionOrder(eligibility));
  const deferred = rendered.filter(section => eligible.has(section.name));
  const surviving = rendered.filter(section => !eligible.has(section.name));
  if (deferred.length === 0) return computeRenderedBytes(surviving);
  const manifest = buildContextManifest(deferred);
  return computeRenderedBytes(
    insertDeferredContextSection(surviving, manifest.metadata),
  );
}

function candidateProjectionSubsets(
  candidates: ReadonlyArray<ContextProjectionCandidate>,
): ContextProjectionCandidate[][] {
  const byName = new Map(
    candidates.map(candidate => [candidate.sectionName, candidate]),
  );
  const ordered = PROJECTION_ORDER.flatMap(name => {
    const candidate = byName.get(name);
    return candidate ? [candidate] : [];
  });
  const subsets: ContextProjectionCandidate[][] = [[]];
  for (const candidate of ordered) {
    const current = [...subsets];
    for (const subset of current) {
      subsets.push([...subset, candidate]);
    }
  }
  return subsets;
}

function applyProjectionSubset(
  rendered: ReadonlyArray<RenderedSection>,
  subset: ReadonlyArray<ContextProjectionCandidate>,
): RenderedSection[] {
  if (subset.length === 0) return [...rendered];
  const byName = new Map(
    subset.map(candidate => [candidate.sectionName, candidate]),
  );
  return rendered.map(section =>
    byName.get(section.name as "reads" | "related_decisions")?.projected ??
    section,
  );
}

type CandidatePlan = {
  sections: RenderedSection[];
  elidedNames: string[];
  elidedBytes: Map<string, number>;
  projectedNames: ContextProjectionCandidate["sectionName"][];
  finalBytes: number;
  deferredContext?: DeferredContextMetadata;
  pendingContextManifest?: PendingContextManifestArtifact;
};

function makeCandidatePlan(
  sections: RenderedSection[],
  elidedNames: string[],
  elidedBytes: Map<string, number>,
  projectedNames: ContextProjectionCandidate["sectionName"][],
  manifestSections: ReadonlyArray<RenderedSection>,
): CandidatePlan {
  if (manifestSections.length === 0) {
    return {
      sections,
      elidedNames,
      elidedBytes,
      projectedNames,
      finalBytes: computeRenderedBytes(sections),
    };
  }
  const manifest = buildContextManifest(manifestSections);
  const withDeferredContext = insertDeferredContextSection(
    sections,
    manifest.metadata,
    new Set(projectedNames),
  );
  return {
    sections: withDeferredContext,
    elidedNames,
    elidedBytes,
    projectedNames,
    finalBytes: computeRenderedBytes(withDeferredContext),
    deferredContext: manifest.metadata,
    pendingContextManifest: manifest.artifact,
  };
}

function evaluateProjectionSubset(
  rendered: ReadonlyArray<RenderedSection>,
  subset: ReadonlyArray<ContextProjectionCandidate>,
  eligibility: BudgetElisionEligibility,
  budgetBytes: number,
): { success?: CandidatePlan; floor: CandidatePlan } {
  const projectedNames = subset.map(candidate => candidate.sectionName);
  const projectedNameSet = new Set(projectedNames);
  const deferredOriginals = subset.map(candidate => candidate.original);
  let projectedSurviving = applyProjectionSubset(rendered, subset);
  let comparisonSurviving = [...rendered];
  const elidedNames: string[] = [];
  const elidedBytes = new Map<string, number>();

  const makeStagePlans = (
    fullDeferredProjected: ReadonlyArray<RenderedSection>,
    fullDeferredComparison: ReadonlyArray<RenderedSection>,
  ): { projected: CandidatePlan; comparison: CandidatePlan } => ({
    projected: makeCandidatePlan(
      projectedSurviving,
      [...elidedNames],
      new Map(elidedBytes),
      projectedNames,
      [...deferredOriginals, ...fullDeferredProjected],
    ),
    comparison: makeCandidatePlan(
      comparisonSurviving,
      [...elidedNames],
      new Map(elidedBytes),
      [],
      fullDeferredComparison,
    ),
  });

  const projectionIsBeneficial = (
    projected: CandidatePlan,
    comparison: CandidatePlan,
  ): boolean => subset.length === 0 || projected.finalBytes < comparison.finalBytes;

  let fullDeferredProjected: RenderedSection[] = [];
  let fullDeferredComparison: RenderedSection[] = [];
  let stage = makeStagePlans(fullDeferredProjected, fullDeferredComparison);
  let floor = stage.projected;
  if (
    stage.projected.finalBytes <= budgetBytes &&
    projectionIsBeneficial(stage.projected, stage.comparison)
  ) {
    return { success: stage.projected, floor };
  }

  for (const name of eligibleElisionOrder(eligibility)) {
    if (projectedNameSet.has(name as ContextProjectionCandidate["sectionName"])) {
      continue;
    }
    const projectedIdx = projectedSurviving.findIndex(section => section.name === name);
    const comparisonIdx = comparisonSurviving.findIndex(section => section.name === name);
    if (projectedIdx === -1 || comparisonIdx === -1) continue;
    const projectedDeferred = projectedSurviving[projectedIdx]!;
    const comparisonDeferred = comparisonSurviving[comparisonIdx]!;
    fullDeferredProjected = [...fullDeferredProjected, projectedDeferred];
    fullDeferredComparison = [...fullDeferredComparison, comparisonDeferred];
    elidedBytes.set(name, sectionBytes(comparisonDeferred));
    projectedSurviving = projectedSurviving.filter((_, i) => i !== projectedIdx);
    comparisonSurviving = comparisonSurviving.filter((_, i) => i !== comparisonIdx);
    elidedNames.push(name);

    stage = makeStagePlans(fullDeferredProjected, fullDeferredComparison);
    floor = stage.projected;
    if (
      stage.projected.finalBytes <= budgetBytes &&
      projectionIsBeneficial(stage.projected, stage.comparison)
    ) {
      return { success: stage.projected, floor };
    }
  }

  return { floor };
}

function projectionTieBreak(
  names: ReadonlyArray<ContextProjectionCandidate["sectionName"]>,
): number[] {
  return names.map(name => PROJECTION_ORDER.indexOf(name));
}

function compareCandidatePlans(a: CandidatePlan, b: CandidatePlan): number {
  if (a.elidedNames.length !== b.elidedNames.length) {
    return a.elidedNames.length - b.elidedNames.length;
  }
  if (a.projectedNames.length !== b.projectedNames.length) {
    return a.projectedNames.length - b.projectedNames.length;
  }
  const aProjectionOrder = projectionTieBreak(a.projectedNames);
  const bProjectionOrder = projectionTieBreak(b.projectedNames);
  const maxLength = Math.max(aProjectionOrder.length, bProjectionOrder.length);
  for (let i = 0; i < maxLength; i += 1) {
    const left = aProjectionOrder[i] ?? Number.POSITIVE_INFINITY;
    const right = bProjectionOrder[i] ?? Number.POSITIVE_INFINITY;
    if (left !== right) return left - right;
  }
  return a.finalBytes - b.finalBytes;
}

export function applyBudgetElision(
  rendered: ReadonlyArray<RenderedSection>,
  budgetBytes: number | undefined,
  eligibility: BudgetElisionEligibility,
  projectionCandidates: ReadonlyArray<ContextProjectionCandidate> = [],
): BudgetElisionResult {
  // Byte facts that hold regardless of which return path we take. The floor is
  // derived from the shared helper so the success and CONTEXT_OVER_BUDGET paths
  // can never report a different minimum.
  const naturalBytes = computeRenderedBytes(rendered);

  const makeResult = (
    sections: RenderedSection[],
    elidedNames: string[],
    elidedBytes: Map<string, number>,
    minimumAchievableBytes: number,
    deferredBytes: number,
    deferredContext?: DeferredContextMetadata,
    pendingContextManifest?: PendingContextManifestArtifact,
  ): BudgetElisionResult => ({
    sections,
    elidedNames,
    elidedBytes,
    metrics: {
      naturalBytes,
      // Recomputed from the surviving sections with the same join+byteLength
      // the pack body uses, so it equals the caller's `totalBytes`.
      finalBytes: computeRenderedBytes(sections),
      minimumAchievableBytes,
      deferredBytes,
      elidedSections: elidedNames.map((name) => ({
        name,
        bytes: elidedBytes.get(name) ?? 0,
      })),
    },
    ...(deferredContext ? { deferredContext } : {}),
    ...(pendingContextManifest ? { pendingContextManifest } : {}),
  });

  if (budgetBytes === undefined) {
    return makeResult(
      [...rendered],
      [],
      new Map(),
      computeMinimumAchievableBytesWithDeferral(rendered, eligibility),
      0,
    );
  }

  if (naturalBytes <= budgetBytes) {
    return makeResult(
      [...rendered],
      [],
      new Map(),
      computeMinimumAchievableBytesWithDeferral(rendered, eligibility),
      0,
    );
  }

  const viableProjectionCandidates = projectionCandidates.filter(
    candidate => candidate.projectedBytes < candidate.originalBytes,
  );
  const evaluated = candidateProjectionSubsets(viableProjectionCandidates)
    .map(subset =>
      evaluateProjectionSubset(
        rendered,
        subset,
        eligibility,
        budgetBytes,
      ),
    )
    .filter((plan): plan is { success?: CandidatePlan; floor: CandidatePlan } => !!plan);

  const noProjectionFloorPlan = evaluated.find(
    plan => plan.floor.projectedNames.length === 0,
  )?.floor;
  const minimumAchievableBytes =
    computeMinimumAchievableBytesWithDeferral(rendered, eligibility);

  const successPlan = evaluated
    .flatMap(plan => (plan.success ? [plan.success] : []))
    .sort(compareCandidatePlans)[0];

  if (successPlan) {
    const manifest = successPlan.pendingContextManifest;
    const deferredBytes = manifest
      ? manifest.manifest.sections.reduce((sum, section) => sum + section.bytes, 0)
      : 0;
    return makeResult(
      successPlan.sections,
      successPlan.elidedNames,
      successPlan.elidedBytes,
      minimumAchievableBytes,
      deferredBytes,
      successPlan.deferredContext,
      successPlan.pendingContextManifest,
    );
  }

  // Maximal deferral performed; still over budget. The reported floor comes
  // from the shared helper (not a second computation), matching the explain floor.
  throw new ContextOverBudgetError(
    budgetBytes,
    minimumAchievableBytes,
    (noProjectionFloorPlan?.sections ?? rendered)
      .map(section => section.name)
      .filter(name => name !== "deferred_context"),
  );
}
