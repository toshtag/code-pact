// Shared test-only builder for VALID review contracts (P90).
//
// Once a project sets `review_contract_policy: required`, every fixture task a
// test intends to lock needs a contract that actually holds. Written by hand
// that is a ~40-line YAML block per fixture, and a copy is exactly the kind of
// thing that gets updated in one file and forgotten in six others — at which
// point the fixtures stop agreeing on what a valid contract even looks like.
//
// So there is ONE builder. It derives the contract from the task it is given:
// the mode from the task's own metadata, and every ref from the task's own
// declared scope. It never edits the task to make the contract fit — if the
// task's scope cannot back a contract, that is a defect in the FIXTURE and this
// module throws rather than papering over it.
//
// Not for production. `src/` must never import this: the shape of a valid
// contract is the semantic validator's business, and a test helper that leaked
// into the product would let a fixture convention masquerade as a rule. A unit
// test asserts the absence of that import.
//
// Tests that need a MISSING, malformed, or historical contract still write raw
// fixtures — that is the point of those tests, and routing them through a
// builder of valid contracts would prove nothing.

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import type { ReviewContract } from "../../src/core/schemas/review-contract.ts";

/**
 * The parts of a task this builder reads. Structural on purpose: fixtures build
 * tasks as plain objects and as YAML text, and neither is a parsed `Task`.
 */
export type ReviewContractFixtureTask = {
  id: string;
  type: string;
  ambiguity?: string;
  risk?: string;
  write_surface?: string;
  reads?: readonly string[];
  writes?: readonly string[];
  acceptance_refs?: readonly string[];
};

/** Mirrors `MINIMAL_MODE_TASK_TYPES` in src/core/review-contract.ts. */
const MINIMAL_MODE_TASK_TYPES: ReadonlySet<string> = new Set([
  "docs",
  "mechanical_refactor",
]);

/**
 * True when the task genuinely qualifies for the restricted form.
 *
 * The eligibility rule is duplicated from the validator rather than imported,
 * ON PURPOSE: if the two ever disagree, the helper's own unit test fails and
 * someone looks at the rule. Importing it would make the builder track a change
 * in the rule silently, which is how a fixture starts asserting the product's
 * current behavior instead of the intended one.
 */
function qualifiesForMinimalMode(task: ReviewContractFixtureTask): boolean {
  return (
    MINIMAL_MODE_TASK_TYPES.has(task.type) &&
    task.ambiguity === "low" &&
    task.risk === "low" &&
    task.write_surface === "low"
  );
}

/**
 * A ref the semantic validator can match against `scope`.
 *
 * Only literal paths qualify. A declared glob (`src/**`) covers files, but the
 * glob string itself is not one of them, so using it as a ref would produce a
 * contract that fails `ref_outside_task_scope` — the exact failure this builder
 * exists to prevent.
 */
function firstLiteralPath(scope: readonly string[]): string | null {
  return scope.find(entry => !/[*?]/.test(entry)) ?? null;
}

function requireRef(
  task: ReviewContractFixtureTask,
  scope: readonly string[],
  fields: string,
): string {
  const ref = firstLiteralPath(scope);
  if (ref !== null) return ref;
  throw new Error(
    `Cannot build a valid review contract for task "${task.id}": its ${fields} declare no literal path to point a ref at. Give the fixture a concrete path, or write the contract by hand if the test is about a task with no usable scope.`,
  );
}

/**
 * A valid review contract for `task`, derived entirely from the task itself.
 *
 * `minimal` only when the task actually qualifies; everything else gets a full
 * boundary contract. The metadata is read, never rewritten — a fixture does not
 * get its risk or write_surface quietly lowered so a smaller contract will fit.
 *
 * Throws when the task's declared scope cannot back the refs the contract needs.
 */
export function validReviewContractFor(
  task: ReviewContractFixtureTask,
): ReviewContract {
  if (qualifiesForMinimalMode(task)) {
    return {
      version: 1,
      mode: "minimal",
      rationale: `Fixture task "${task.id}" is low-risk ${task.type} work with no executable, platform, or security boundary.`,
    };
  }

  // Stage refs describe the code under review (reads or writes); platform and
  // evidence refs describe proof (writes or acceptance_refs). Same split the
  // validator applies, so a contract built here is checked the same way.
  const stageRef = requireRef(
    task,
    [...(task.reads ?? []), ...(task.writes ?? [])],
    "reads or writes",
  );
  const proofRef = requireRef(
    task,
    [...(task.writes ?? []), ...(task.acceptance_refs ?? [])],
    "writes or acceptance_refs",
  );

  return {
    version: 1,
    mode: "boundary",
    stages: [
      {
        stage: "producer",
        disposition: "in_scope",
        claim: `Fixture task "${task.id}" produces its declared output.`,
        refs: [stageRef],
      },
      {
        stage: "consumer",
        disposition: "in_scope",
        claim: `Fixture task "${task.id}" is consumed through its declared scope.`,
        refs: [stageRef],
      },
      {
        stage: "runner",
        disposition: "not_applicable",
        rationale: "The fixture launches no process.",
      },
      {
        stage: "os",
        disposition: "not_applicable",
        rationale: "The fixture has no operating-system-specific behavior.",
      },
      {
        stage: "security",
        disposition: "not_applicable",
        rationale: "The fixture crosses no authority boundary.",
      },
    ],
    platforms: [
      {
        platform: "linux",
        disposition: "required",
        level: "integration",
        refs: [proofRef],
      },
      {
        platform: "macos",
        disposition: "not_required",
        rationale: "The fixture has no macOS-specific behavior.",
      },
      {
        platform: "windows",
        disposition: "not_required",
        rationale: "The fixture has no Windows-specific behavior.",
      },
    ],
    evidence: [
      {
        id: "fixture-scope",
        claim: `Fixture task "${task.id}" is exercised through its declared scope.`,
        level: "integration",
        refs: [proofRef],
      },
    ],
  };
}

/**
 * `task` with a valid contract attached, as a NEW object.
 *
 * The input — including its arrays — is left untouched, so a shared fixture
 * constant stays usable by the next test in the file.
 */
export function withValidReviewContract<T extends ReviewContractFixtureTask>(
  task: T,
): T & { review_contract: ReviewContract } {
  return { ...task, review_contract: validReviewContractFor(task) };
}

/**
 * Set `review_contract_policy` on an already-scaffolded fixture project.
 *
 * `init` writes `required`, which is right for a real new project. A fixture
 * whose task carries no declared scope cannot express a boundary contract
 * honestly — every ref has to be covered by the task's own reads/writes — and
 * inventing a scope just to satisfy the gate would make the fixture claim
 * something the test does not mean. Such a project declares `advisory`
 * instead: a real, supported configuration that says "this project has not
 * opted in", which is exactly true of it.
 *
 * Use it deliberately, with a reason at the call site. Fixtures that DO declare
 * a scope should carry a real contract from `validReviewContractFor` instead.
 */
export async function setReviewContractPolicy(
  cwd: string,
  policy: "advisory" | "required",
): Promise<void> {
  const path = join(cwd, ".code-pact", "project.yaml");
  const current = await readFile(path, "utf8");
  const next = /^review_contract_policy:.*$/m.test(current)
    ? current.replace(
        /^review_contract_policy:.*$/m,
        `review_contract_policy: ${policy}`,
      )
    : `${current.replace(/\n*$/, "\n")}review_contract_policy: ${policy}\n`;
  await writeFile(path, next, "utf8");
}

/**
 * The contract as a standalone YAML fragment — the body only, with no
 * `review_contract:` key — which is the shape `task add --review-contract-file`
 * expects.
 *
 * For the fixtures that create their task through the CLI rather than by
 * writing phase YAML. Pair it with `writeReviewContractFile` below.
 */
export function renderValidReviewContractFragment(
  task: ReviewContractFixtureTask,
): string {
  return stringifyYaml(validReviewContractFor(task));
}

/**
 * Write the fragment into `cwd` and return the project-relative path to pass to
 * `task add --review-contract-file`.
 *
 * The path stays inside the project because the CLI refuses to read a contract
 * fragment from outside it.
 */
export async function writeReviewContractFile(
  cwd: string,
  task: ReviewContractFixtureTask,
  fileName = "review-contract.yaml",
): Promise<string> {
  await writeFile(
    join(cwd, fileName),
    renderValidReviewContractFragment(task),
    "utf8",
  );
  return fileName;
}

/**
 * The contract as phase-YAML text, indented to sit under a task in a `tasks:`
 * list. Returns the `review_contract:` key and its body, newline-terminated.
 *
 * For the many fixtures that build phase YAML as a string rather than as an
 * object; `indent` defaults to the 4 spaces a task's own fields use.
 */
export function renderValidReviewContractYaml(
  task: ReviewContractFixtureTask,
  indent = 4,
): string {
  const pad = " ".repeat(indent);
  const body = stringifyYaml({
    review_contract: validReviewContractFor(task),
  });
  return body
    .split("\n")
    .map(line => (line.length > 0 ? `${pad}${line}` : line))
    .join("\n");
}
