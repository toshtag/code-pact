import { describe, it, expect } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type { Task } from "../../../src/core/schemas/task.ts";
import { ReviewContract } from "../../../src/core/schemas/review-contract.ts";
import { validateReviewContractForTask } from "../../../src/core/review-contract.ts";
import {
  validReviewContractFor,
  withValidReviewContract,
  renderValidReviewContractYaml,
} from "../../helpers/review-contract.ts";

// The fixture builder is only worth having if what it produces actually passes
// the product's own validator. These tests run every contract it can build
// through `validateReviewContractForTask`, so a fixture convention can never
// drift into "valid according to the helper" — the only definition that counts
// is the one `task lock` uses.

const repoRoot = resolve(fileURLToPath(import.meta.url), "../../../..");

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "P1-T1",
    type: "feature",
    ambiguity: "medium",
    risk: "medium",
    context_size: "medium",
    write_surface: "medium",
    verification_strength: "strong",
    expected_duration: "medium",
    status: "planned",
    reads: ["src/example.ts"],
    writes: ["src/example.ts"],
    acceptance_refs: ["tests/unit/example.test.ts"],
    ...overrides,
  };
}

describe("validReviewContractFor", () => {
  it("builds a boundary contract the product validator accepts", () => {
    const subject = task();
    const contract = validReviewContractFor(subject);

    expect(contract.mode).toBe("boundary");
    expect(ReviewContract.parse(contract)).toBeDefined();
    expect(
      validateReviewContractForTask({ ...subject, review_contract: contract }),
    ).toEqual([]);
  });

  it("builds a minimal contract only for work that qualifies", () => {
    const subject = task({
      type: "docs",
      ambiguity: "low",
      risk: "low",
      write_surface: "low",
    });
    const contract = validReviewContractFor(subject);

    expect(contract.mode).toBe("minimal");
    expect(contract.stages).toBeUndefined();
    expect(
      validateReviewContractForTask({ ...subject, review_contract: contract }),
    ).toEqual([]);
  });

  it("does not downgrade a docs task that is not low-risk", () => {
    // The tempting shortcut is to hand every docs task the short form. That
    // would make the fixture assert less than the task actually claims, and the
    // validator would refuse it.
    const subject = task({ type: "docs", risk: "high" });
    const contract = validReviewContractFor(subject);

    expect(contract.mode).toBe("boundary");
    expect(
      validateReviewContractForTask({ ...subject, review_contract: contract }),
    ).toEqual([]);
  });

  it("covers stage refs from reads when the task writes nothing literal", () => {
    const subject = task({ reads: ["src/reader.ts"], writes: ["src/out/**"] });
    const contract = validReviewContractFor(subject);

    expect(
      validateReviewContractForTask({ ...subject, review_contract: contract }),
    ).toEqual([]);
    // A declared glob is not itself a path the validator can match, so it is
    // never used as a ref.
    const refs = [
      ...(contract.stages ?? []).flatMap(s => s.refs ?? []),
      ...(contract.platforms ?? []).flatMap(p => p.refs ?? []),
      ...(contract.evidence ?? []).flatMap(e => e.refs ?? []),
    ];
    expect(refs).not.toContain("src/out/**");
  });

  it("throws when the task's scope cannot back a ref", () => {
    expect(() =>
      validReviewContractFor(
        task({ reads: [], writes: [], acceptance_refs: [] }),
      ),
    ).toThrow(/declare no literal path/);
  });

  it("throws when only globs are declared", () => {
    expect(() =>
      validReviewContractFor(
        task({ reads: ["src/**"], writes: ["src/**"], acceptance_refs: [] }),
      ),
    ).toThrow(/declare no literal path/);
  });

  it("does not mutate the task it is given", () => {
    const subject = task();
    const snapshot = structuredClone(subject);

    validReviewContractFor(subject);
    withValidReviewContract(subject);

    expect(subject).toEqual(snapshot);
    expect(subject.review_contract).toBeUndefined();
  });
});

describe("withValidReviewContract", () => {
  it("returns a new task carrying a contract that holds", () => {
    const withContract = withValidReviewContract(task());

    expect(withContract.review_contract.mode).toBe("boundary");
    expect(validateReviewContractForTask(withContract as Task)).toEqual([]);
  });
});

describe("renderValidReviewContractYaml", () => {
  it("renders a block that parses back to the same contract", () => {
    const subject = task();
    const yaml = renderValidReviewContractYaml(subject, 4);

    expect(yaml.startsWith("    review_contract:")).toBe(true);
    const parsed = parseYaml(
      yaml
        .split("\n")
        .map(line => line.slice(4))
        .join("\n"),
    ) as { review_contract: unknown };
    expect(ReviewContract.parse(parsed.review_contract)).toEqual(
      validReviewContractFor(subject),
    );
  });

  it("indents to the requested depth", () => {
    const yaml = renderValidReviewContractYaml(task(), 6);
    expect(yaml.startsWith("      review_contract:")).toBe(true);
  });
});

describe("test-only boundary", () => {
  it("is not imported by production code", async () => {
    // A helper that decides what a valid contract looks like must not become
    // reachable from the product, or a fixture convention turns into a rule.
    const offenders: string[] = [];

    async function walk(dir: string): Promise<void> {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
          continue;
        }
        if (!entry.name.endsWith(".ts")) continue;
        const source = await readFile(full, "utf8");
        if (/tests\/helpers\/review-contract/.test(source)) offenders.push(full);
      }
    }

    await walk(join(repoRoot, "src"));
    expect(offenders).toEqual([]);
  });
});
