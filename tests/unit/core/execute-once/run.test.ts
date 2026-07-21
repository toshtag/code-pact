import { describe, it, expect } from "vitest";
import { boundedPathSummary } from "../../../../src/core/execute-once/run.ts";

describe("boundedPathSummary", () => {
  it("uses deterministic code-point order regardless of input order", () => {
    const summary = boundedPathSummary([
      "z/a.ts",
      "a/b.ts",
      "m/c.ts",
    ]);
    expect(summary).toEqual({
      changed_path_count: 3,
      changed_paths: ["a/b.ts", "m/c.ts", "z/a.ts"],
      paths_truncated: false,
    });
  });

  it("deduplicates paths", () => {
    const summary = boundedPathSummary(["a.ts", "a.ts", "b.ts"]);
    expect(summary).toEqual({
      changed_path_count: 2,
      changed_paths: ["a.ts", "b.ts"],
      paths_truncated: false,
    });
  });

  it("limits the sample to 20 paths and reports truncation", () => {
    const paths = Array.from({ length: 21 }, (_, i) => `${i}.txt`);
    const summary = boundedPathSummary(paths);
    expect(summary.changed_path_count).toBe(21);
    expect(summary.changed_paths).toHaveLength(20);
    expect(summary.paths_truncated).toBe(true);
  });

  it("keeps combined raw path bytes within the 4096 budget", () => {
    // 21 paths of 200 bytes each → only the first ~20 fit under 4096 bytes.
    const longName = "x".repeat(200);
    const paths = Array.from({ length: 21 }, (_, i) => `${i}-${longName}.txt`);
    const summary = boundedPathSummary(paths);
    expect(summary.changed_path_count).toBe(21);
    let bytes = 0;
    for (const p of summary.changed_paths) {
      bytes += Buffer.byteLength(p, "utf8");
    }
    expect(bytes).toBeLessThanOrEqual(4096);
    expect(summary.paths_truncated).toBe(true);
  });

  it("skips a single path that exceeds the 4096 byte budget", () => {
    const paths = ["x".repeat(5000), "b.ts", "c.ts"];
    const summary = boundedPathSummary(paths);
    expect(summary.changed_path_count).toBe(3);
    expect(summary.changed_paths).toEqual(["b.ts", "c.ts"]);
    expect(summary.paths_truncated).toBe(true);
  });

  it("handles multibyte UTF-8 characters without splitting", () => {
    const paths = [
      "日本語.txt",
      "ascii.txt",
      "😀.txt",
    ];
    const summary = boundedPathSummary(paths);
    expect(summary.changed_path_count).toBe(3);
    expect(summary.changed_paths).toEqual(["ascii.txt", "日本語.txt", "😀.txt"]);
    expect(summary.paths_truncated).toBe(false);
  });
});
