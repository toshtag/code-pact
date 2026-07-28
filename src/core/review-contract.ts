import type { Task } from "./schemas/task.ts";
import type {
  ReviewContract,
  ReviewContractEvidence,
  ReviewContractPlatform,
  ReviewContractStage,
  BoundaryStage,
  ReviewPlatform,
} from "./schemas/review-contract.ts";
import { assertSafeRelativePath } from "./path-safety.ts";
import { matchGlob } from "./glob.ts";

// ---------------------------------------------------------------------------
// Review contract semantics (P90)
//
// The single authority for "does this task's SUPPLIED review contract hold?".
// Plan lint, `task add`, `task lock`, and `task start` all call in here, so a
// contract one of them accepts can never be refused by another.
//
// Scope note: this module says nothing about a task that supplies NO contract.
// Absence is an advisory today (`TASK_REVIEW_CONTRACT_MISSING`) and becomes a
// refusal in P90-T0B, gated on a project-level policy so the upgrade does not
// make every existing `planned` task unlockable at once.
//
// Everything below is pure: no filesystem, no git, no clock. Ref COVERAGE is
// checked against the task's own declared scope, never against files on disk —
// a boundary contract routinely names test files the task is about to CREATE,
// which do not exist at lock time. Existence is plan lint's job for `reads` and
// `acceptance_refs`; coherence with the declared scope is this module's.
// ---------------------------------------------------------------------------

/** The five layers a boundary contract must dispose of, in review order. */
export const BOUNDARY_STAGES: readonly BoundaryStage[] = [
  "producer",
  "consumer",
  "runner",
  "os",
  "security",
];

/** The platform matrix every boundary contract must decide, in a fixed order. */
export const REVIEW_PLATFORMS: readonly ReviewPlatform[] = [
  "linux",
  "macos",
  "windows",
];

/**
 * Task types eligible for `minimal` mode. Everything else — feature, bugfix,
 * refactor, architecture, test, other — has to state its boundary explicitly,
 * because "small" is exactly the judgement that keeps being wrong.
 */
const MINIMAL_MODE_TASK_TYPES: ReadonlySet<string> = new Set([
  "docs",
  "mechanical_refactor",
]);

/** Machine-readable cause, so callers can assert on the rule, not the prose. */
export type ReviewContractIssueReason =
  | "minimal_mode_not_allowed"
  | "minimal_rationale_missing"
  | "minimal_boundary_fields_present"
  | "boundary_stage_missing"
  | "boundary_stage_duplicate"
  | "boundary_stage_claim_missing"
  | "boundary_stage_refs_missing"
  | "boundary_stage_rationale_missing"
  | "boundary_stage_refs_not_allowed"
  | "os_stage_requires_actual_platform"
  | "platform_missing"
  | "platform_duplicate"
  | "platform_level_missing"
  | "platform_level_too_weak"
  | "platform_refs_missing"
  | "platform_rationale_missing"
  | "platform_refs_not_allowed"
  | "evidence_missing"
  | "evidence_id_duplicate"
  | "evidence_claim_missing"
  | "evidence_refs_missing"
  | "evidence_platform_missing"
  | "evidence_platform_not_required"
  | "evidence_platform_level_mismatch"
  | "ref_unsafe_path"
  | "ref_outside_task_scope";

export type ReviewContractIssue = {
  code: "TASK_REVIEW_CONTRACT_INVALID";
  message: string;
  /** Dotted path inside the task, e.g. `review_contract.stages[2].refs[0]`. */
  path: string;
  details: {
    reason: ReviewContractIssueReason;
    [key: string]: unknown;
  };
};

function issue(
  reason: ReviewContractIssueReason,
  path: string,
  message: string,
  details: Record<string, unknown> = {},
): ReviewContractIssue {
  return {
    code: "TASK_REVIEW_CONTRACT_INVALID",
    message,
    path,
    details: { reason, ...details },
  };
}

function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim().length === 0;
}

function isEmpty(refs: readonly string[] | undefined): boolean {
  return refs === undefined || refs.length === 0;
}

/** True when one of the declared globs covers `ref` (literal paths match too). */
function coveredBy(declared: readonly string[], ref: string): boolean {
  return declared.some(glob => matchGlob(glob, ref));
}

function unsafeRefReason(ref: string): string | null {
  try {
    assertSafeRelativePath(ref);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Validate a ref list against the declared scope that owns it.
 *
 * `scopeLabel` names the fields in the message so the fix is obvious: stage refs
 * must be inside what the task READS or WRITES, while platform and evidence refs
 * must be inside what the task WRITES or already accepts as evidence.
 */
function checkRefs(
  refs: readonly string[] | undefined,
  scope: readonly string[],
  scopeLabel: string,
  pathPrefix: string,
): ReviewContractIssue[] {
  const issues: ReviewContractIssue[] = [];
  (refs ?? []).forEach((ref, index) => {
    const path = `${pathPrefix}.refs[${index}]`;
    const unsafe = unsafeRefReason(ref);
    if (unsafe !== null) {
      issues.push(
        issue(
          "ref_unsafe_path",
          path,
          `review_contract ref "${ref}" is not a safe repository-relative POSIX path: ${unsafe}`,
          { value: ref, detail: unsafe },
        ),
      );
      return;
    }
    if (!coveredBy(scope, ref)) {
      issues.push(
        issue(
          "ref_outside_task_scope",
          path,
          `review_contract ref "${ref}" is not covered by the task's ${scopeLabel} — declare the path there first, or point the ref at something the task actually touches.`,
          { value: ref, scope: scopeLabel },
        ),
      );
    }
  });
  return issues;
}

function validateMinimal(
  task: Task,
  contract: ReviewContract,
): ReviewContractIssue[] {
  const issues: ReviewContractIssue[] = [];

  const eligible =
    MINIMAL_MODE_TASK_TYPES.has(task.type) &&
    task.ambiguity === "low" &&
    task.risk === "low" &&
    task.write_surface === "low";
  if (!eligible) {
    issues.push(
      issue(
        "minimal_mode_not_allowed",
        "review_contract.mode",
        `Task "${task.id}" cannot use a minimal review contract: minimal mode is restricted to docs or mechanical_refactor work with ambiguity, risk, and write_surface all low (this task is type=${task.type}, ambiguity=${task.ambiguity}, risk=${task.risk}, write_surface=${task.write_surface}). Declare a boundary contract instead.`,
        {
          type: task.type,
          ambiguity: task.ambiguity,
          risk: task.risk,
          write_surface: task.write_surface,
        },
      ),
    );
  }

  if (isBlank(contract.rationale)) {
    issues.push(
      issue(
        "minimal_rationale_missing",
        "review_contract.rationale",
        `Task "${task.id}" declares a minimal review contract with no rationale — state why the change has no executable, platform, or security boundary.`,
      ),
    );
  }

  const carried = (
    ["stages", "platforms", "evidence"] as const
  ).filter(key => contract[key] !== undefined);
  if (carried.length > 0) {
    issues.push(
      issue(
        "minimal_boundary_fields_present",
        "review_contract.mode",
        `Task "${task.id}" declares a minimal review contract but also carries boundary fields (${carried.join(", ")}). Minimal mode ignores them, so switch the mode to boundary or drop the fields — a silently ignored declaration is worse than none.`,
        { fields: carried },
      ),
    );
  }

  return issues;
}

function validateStages(
  task: Task,
  stages: readonly ReviewContractStage[],
  stageScope: readonly string[],
): ReviewContractIssue[] {
  const issues: ReviewContractIssue[] = [];
  const seen = new Set<string>();

  stages.forEach((entry, index) => {
    const path = `review_contract.stages[${index}]`;
    if (seen.has(entry.stage)) {
      issues.push(
        issue(
          "boundary_stage_duplicate",
          path,
          `Task "${task.id}" declares the "${entry.stage}" review stage more than once — each of ${BOUNDARY_STAGES.join(", ")} must appear exactly once.`,
          { stage: entry.stage },
        ),
      );
      return;
    }
    seen.add(entry.stage);

    if (entry.disposition === "in_scope") {
      if (isBlank(entry.claim)) {
        issues.push(
          issue(
            "boundary_stage_claim_missing",
            `${path}.claim`,
            `Task "${task.id}" marks the "${entry.stage}" stage in_scope with no claim — state what this layer is asserted to do.`,
            { stage: entry.stage },
          ),
        );
      }
      if (isEmpty(entry.refs)) {
        issues.push(
          issue(
            "boundary_stage_refs_missing",
            `${path}.refs`,
            `Task "${task.id}" marks the "${entry.stage}" stage in_scope with no refs — point at the files that carry the claim.`,
            { stage: entry.stage },
          ),
        );
      }
    } else {
      if (isBlank(entry.rationale)) {
        issues.push(
          issue(
            "boundary_stage_rationale_missing",
            `${path}.rationale`,
            `Task "${task.id}" marks the "${entry.stage}" stage not_applicable with no rationale — state why this layer cannot be affected.`,
            { stage: entry.stage },
          ),
        );
      }
      if (!isEmpty(entry.refs)) {
        issues.push(
          issue(
            "boundary_stage_refs_not_allowed",
            `${path}.refs`,
            `Task "${task.id}" marks the "${entry.stage}" stage not_applicable but still declares refs — a layer that cannot be affected has nothing to point at.`,
            { stage: entry.stage },
          ),
        );
      }
    }

    issues.push(...checkRefs(entry.refs, stageScope, "reads or writes", path));
  });

  for (const stage of BOUNDARY_STAGES) {
    if (seen.has(stage)) continue;
    issues.push(
      issue(
        "boundary_stage_missing",
        "review_contract.stages",
        `Task "${task.id}" does not dispose of the "${stage}" review stage — a boundary contract must decide all of ${BOUNDARY_STAGES.join(", ")}.`,
        { stage },
      ),
    );
  }

  return issues;
}

function validatePlatforms(
  task: Task,
  platforms: readonly ReviewContractPlatform[],
  proofScope: readonly string[],
): ReviewContractIssue[] {
  const issues: ReviewContractIssue[] = [];
  const seen = new Set<string>();

  platforms.forEach((entry, index) => {
    const path = `review_contract.platforms[${index}]`;
    if (seen.has(entry.platform)) {
      issues.push(
        issue(
          "platform_duplicate",
          path,
          `Task "${task.id}" declares the "${entry.platform}" platform more than once — each of ${REVIEW_PLATFORMS.join(", ")} must appear exactly once.`,
          { platform: entry.platform },
        ),
      );
      return;
    }
    seen.add(entry.platform);

    if (entry.disposition === "required") {
      if (entry.level === undefined) {
        issues.push(
          issue(
            "platform_level_missing",
            `${path}.level`,
            `Task "${task.id}" requires the "${entry.platform}" platform with no evidence level — declare integration or actual_platform.`,
            { platform: entry.platform },
          ),
        );
      } else if (entry.level === "unit") {
        issues.push(
          issue(
            "platform_level_too_weak",
            `${path}.level`,
            `Task "${task.id}" requires the "${entry.platform}" platform but only plans unit-level evidence — a required platform needs integration or actual_platform proof.`,
            { platform: entry.platform, level: entry.level },
          ),
        );
      }
      if (isEmpty(entry.refs)) {
        issues.push(
          issue(
            "platform_refs_missing",
            `${path}.refs`,
            `Task "${task.id}" requires the "${entry.platform}" platform with no refs — point at the artifact that will carry the proof.`,
            { platform: entry.platform },
          ),
        );
      }
    } else {
      if (isBlank(entry.rationale)) {
        issues.push(
          issue(
            "platform_rationale_missing",
            `${path}.rationale`,
            `Task "${task.id}" marks the "${entry.platform}" platform not_required with no rationale — state why the change cannot behave differently there.`,
            { platform: entry.platform },
          ),
        );
      }
      if (!isEmpty(entry.refs)) {
        issues.push(
          issue(
            "platform_refs_not_allowed",
            `${path}.refs`,
            `Task "${task.id}" marks the "${entry.platform}" platform not_required but still declares refs — drop the refs or mark the platform required.`,
            { platform: entry.platform },
          ),
        );
      }
    }

    issues.push(
      ...checkRefs(
        entry.refs,
        proofScope,
        "writes or acceptance_refs",
        path,
      ),
    );
  });

  for (const platform of REVIEW_PLATFORMS) {
    if (seen.has(platform)) continue;
    issues.push(
      issue(
        "platform_missing",
        "review_contract.platforms",
        `Task "${task.id}" does not decide the "${platform}" platform — the matrix must cover all of ${REVIEW_PLATFORMS.join(", ")}.`,
        { platform },
      ),
    );
  }

  return issues;
}

function validateEvidence(
  task: Task,
  evidence: readonly ReviewContractEvidence[],
  platforms: readonly ReviewContractPlatform[],
  proofScope: readonly string[],
): ReviewContractIssue[] {
  const issues: ReviewContractIssue[] = [];

  if (evidence.length === 0) {
    issues.push(
      issue(
        "evidence_missing",
        "review_contract.evidence",
        `Task "${task.id}" declares a boundary review contract with no evidence — name at least one proof the review will look for.`,
      ),
    );
  }

  const seen = new Set<string>();
  evidence.forEach((entry, index) => {
    const path = `review_contract.evidence[${index}]`;
    if (seen.has(entry.id)) {
      issues.push(
        issue(
          "evidence_id_duplicate",
          `${path}.id`,
          `Task "${task.id}" declares the evidence id "${entry.id}" more than once — ids must be unique within a task.`,
          { evidence_id: entry.id },
        ),
      );
    }
    seen.add(entry.id);

    if (isBlank(entry.claim)) {
      issues.push(
        issue(
          "evidence_claim_missing",
          `${path}.claim`,
          `Task "${task.id}" evidence "${entry.id}" has no claim — state what the proof establishes.`,
          { evidence_id: entry.id },
        ),
      );
    }
    if (isEmpty(entry.refs)) {
      issues.push(
        issue(
          "evidence_refs_missing",
          `${path}.refs`,
          `Task "${task.id}" evidence "${entry.id}" has no refs — point at the artifact that produces it.`,
          { evidence_id: entry.id },
        ),
      );
    }

    if (entry.level === "actual_platform") {
      if (entry.platform === undefined) {
        issues.push(
          issue(
            "evidence_platform_missing",
            `${path}.platform`,
            `Task "${task.id}" evidence "${entry.id}" claims actual_platform level with no platform — actual-platform proof is always proof on a named operating system.`,
            { evidence_id: entry.id },
          ),
        );
      } else {
        const declared = platforms.find(p => p.platform === entry.platform);
        if (declared === undefined || declared.disposition !== "required") {
          issues.push(
            issue(
              "evidence_platform_not_required",
              `${path}.platform`,
              `Task "${task.id}" evidence "${entry.id}" claims actual_platform proof on "${entry.platform}", but the matrix does not require that platform — mark it required or drop the evidence.`,
              { evidence_id: entry.id, platform: entry.platform },
            ),
          );
        } else if (declared.level !== "actual_platform") {
          issues.push(
            issue(
              "evidence_platform_level_mismatch",
              `${path}.level`,
              `Task "${task.id}" evidence "${entry.id}" claims actual_platform proof on "${entry.platform}", but that platform only requires ${declared.level ?? "no"} level evidence — raise the platform level to actual_platform.`,
              {
                evidence_id: entry.id,
                platform: entry.platform,
                platform_level: declared.level,
              },
            ),
          );
        }
      }
    }

    issues.push(
      ...checkRefs(entry.refs, proofScope, "writes or acceptance_refs", path),
    );
  });

  return issues;
}

/**
 * An in_scope `os` stage is a claim that operating-system behavior changes.
 * A claim like that can only be settled by running on the real system, so the
 * matrix must require at least one platform at `actual_platform` level.
 */
function validateOsStageProof(
  task: Task,
  stages: readonly ReviewContractStage[],
  platforms: readonly ReviewContractPlatform[],
): ReviewContractIssue[] {
  const osStage = stages.find(entry => entry.stage === "os");
  if (osStage === undefined || osStage.disposition !== "in_scope") return [];

  const proven = platforms.some(
    entry =>
      entry.disposition === "required" && entry.level === "actual_platform",
  );
  if (proven) return [];

  return [
    issue(
      "os_stage_requires_actual_platform",
      "review_contract.platforms",
      `Task "${task.id}" marks the "os" stage in_scope but requires no platform at actual_platform level — OS behavior claims are only settled by running on the real system.`,
    ),
  ];
}

function validateBoundary(
  task: Task,
  contract: ReviewContract,
): ReviewContractIssue[] {
  const stages = contract.stages ?? [];
  const platforms = contract.platforms ?? [];
  const evidence = contract.evidence ?? [];

  // Stage refs describe the code under review, so the task must already read or
  // write it. Platform and evidence refs describe PROOF, so they must be
  // something the task produces (writes) or already accepts as evidence.
  const stageScope = [...(task.reads ?? []), ...(task.writes ?? [])];
  const proofScope = [
    ...(task.writes ?? []),
    ...(task.acceptance_refs ?? []),
  ];

  return [
    ...validateStages(task, stages, stageScope),
    ...validatePlatforms(task, platforms, proofScope),
    ...validateEvidence(task, evidence, platforms, proofScope),
    ...validateOsStageProof(task, stages, platforms),
  ];
}

/**
 * Semantic validation of a task's review contract against the task itself.
 *
 * Returns an empty list when the task declares NO contract. Absence is not a
 * semantic failure: today it is reported by plan lint's
 * `TASK_REVIEW_CONTRACT_MISSING` advisory, and P90-T0B turns it into a refusal
 * gated on a project-level policy. Keeping it out of here is what lets
 * historical tasks that predate the contract stay clean.
 */
export function validateReviewContractForTask(
  task: Task,
): ReviewContractIssue[] {
  const contract = task.review_contract;
  if (contract === undefined) return [];
  return contract.mode === "minimal"
    ? validateMinimal(task, contract)
    : validateBoundary(task, contract);
}

export type ReviewContractInvalidError = NodeJS.ErrnoException & {
  task_id: string;
  issues: ReviewContractIssue[];
};

/**
 * Refuse a review contract that was SUPPLIED but does not hold.
 *
 * A task that declares no contract passes: the missing-contract refusal is
 * deliberately NOT part of this stage. Activating it needs a rollout policy that
 * does not make every existing `planned` task unlockable the moment the field
 * ships, plus the fixture migration that goes with it. Both land in P90-T0B,
 * which is also what introduces the missing-contract error code. Until then a
 * missing contract is surfaced by plan lint's advisory, never by a refusal.
 * (The other prerequisite — authoring a contract without hand-editing phase
 * YAML — shipped here as `task add --review-contract-file`.)
 *
 * What IS refused here is a contract someone actually wrote that contradicts
 * its task — that can only come from post-field authoring, so it is a defect,
 * not a migration artifact. Refusing it early keeps incoherent contracts out of
 * the immutable lock and out of task registration digests.
 */
export function assertSuppliedReviewContractValid(task: Task): void {
  const issues = validateReviewContractForTask(task);
  if (issues.length === 0) return;

  const err = new Error(
    `Task "${task.id}" declares an invalid review_contract (${issues
      .map(i => i.details.reason)
      .join(", ")}).`,
  ) as ReviewContractInvalidError;
  err.code = "TASK_REVIEW_CONTRACT_INVALID";
  err.task_id = task.id;
  err.issues = issues;
  throw err;
}
