// Budget enforcement for the context pack. Given the structured
// intermediate form from `renderSections` and an optional byte budget,
// `applyBudgetElision` returns the surviving sections, the names of any elided
// sections (in elision order), a name → byte-size map for them, and the
// byte metrics. Throws `ContextOverBudgetError` when maximal elision still
// leaves the pack above the requested bound.

import {
  ELISION_ORDER,
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
): RenderedSection[] {
  const result = [...sections];
  const taskDefinitionIndex = result.findIndex(
    section => section.name === "task_definition",
  );
  const insertAt =
    taskDefinitionIndex === -1 ? Math.min(1, result.length) : taskDefinitionIndex + 1;
  result.splice(insertAt, 0, makeDeferredContextRenderedSection(metadata));
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

export function applyBudgetElision(
  rendered: ReadonlyArray<RenderedSection>,
  budgetBytes: number | undefined,
  eligibility: BudgetElisionEligibility,
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

  let surviving = [...rendered];
  const deferredSections: RenderedSection[] = [];
  const elidedNames: string[] = [];
  const elidedBytes = new Map<string, number>();

  if (computeRenderedBytes(surviving) <= budgetBytes) {
    return makeResult(
      surviving,
      elidedNames,
      elidedBytes,
      computeMinimumAchievableBytesWithDeferral(rendered, eligibility),
      0,
    );
  }

  const minimumAchievableBytes = computeMinimumAchievableBytesWithDeferral(
    rendered,
    eligibility,
  );

  for (const name of eligibleElisionOrder(eligibility)) {
    const idx = surviving.findIndex((s) => s.name === name);
    if (idx === -1) continue;
    const deferred = surviving[idx]!;
    deferredSections.push(deferred);
    elidedBytes.set(name, sectionBytes(deferred));
    surviving = surviving.filter((_, i) => i !== idx);
    elidedNames.push(name);
    const manifest = buildContextManifest(deferredSections);
    const candidate = insertDeferredContextSection(surviving, manifest.metadata);
    if (computeRenderedBytes(candidate) <= budgetBytes) {
      return makeResult(
        candidate,
        elidedNames,
        elidedBytes,
        minimumAchievableBytes,
        manifest.deferredBytes,
        manifest.metadata,
        manifest.artifact,
      );
    }
  }

  // Maximal deferral performed; still over budget. The reported floor comes
  // from the shared helper (not a second computation), matching the explain floor.
  throw new ContextOverBudgetError(
    budgetBytes,
    minimumAchievableBytes,
    surviving.map((s) => s.name),
  );
}
