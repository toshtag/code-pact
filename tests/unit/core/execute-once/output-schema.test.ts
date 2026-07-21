import { describe, expect, it } from "vitest";
import { parseOneShotExecutorOutput } from "../../../../src/core/execute-once/output-schema.ts";

const sha = "0".repeat(64);

function validReplace(newText = "world"): unknown {
  return {
    kind: "replace_exact",
    expected_file_sha256: sha,
    old_text: "hello",
    new_text: newText,
  };
}

describe("parseOneShotExecutorOutput", () => {
  it("accepts a valid replace_exact payload", () => {
    const out = parseOneShotExecutorOutput(validReplace());
    expect(out).toEqual({
      kind: "replace_exact",
      expected_file_sha256: sha,
      old_text: "hello",
      new_text: "world",
    });
  });

  it("accepts an empty new_text", () => {
    const out = parseOneShotExecutorOutput(validReplace(""));
    expect(out.kind).toBe("replace_exact");
    if (out.kind === "replace_exact") {
      expect(out.new_text).toBe("");
    }
  });

  it("accepts a valid blocked reason", () => {
    const out = parseOneShotExecutorOutput({
      kind: "blocked",
      reason: "needs human review",
    });
    expect(out).toEqual({ kind: "blocked", reason: "needs human review" });
  });

  it("rejects a non-object", () => {
    expect(() => parseOneShotExecutorOutput("not an object")).toThrow(
      /JSON object/,
    );
  });

  it("rejects an array", () => {
    expect(() => parseOneShotExecutorOutput([{ kind: "blocked" }])).toThrow(
      /JSON object/,
    );
  });

  it("rejects an unknown kind", () => {
    expect(() =>
      parseOneShotExecutorOutput({ kind: "repair", reason: "x" }),
    ).toThrow(/kind.*repair.*not allowed/);
  });

  it("rejects replace_exact with missing fields", () => {
    expect(() =>
      parseOneShotExecutorOutput({ kind: "replace_exact", old_text: "x" }),
    ).toThrow(/requires expected_file_sha256, old_text, and new_text/);
  });

  it("rejects an invalid expected_file_sha256", () => {
    expect(() =>
      parseOneShotExecutorOutput(validReplaceWithSha("bad")),
    ).toThrow(/64 lowercase hex/);
  });

  it("rejects an empty old_text", () => {
    expect(() => parseOneShotExecutorOutput(validReplaceWithOld(""))).toThrow(
      /non-empty old_text/,
    );
  });

  it("rejects an oversized blocked reason", () => {
    expect(() =>
      parseOneShotExecutorOutput({
        kind: "blocked",
        reason: "x".repeat(600),
      }),
    ).toThrow(/exceeds.*bytes/);
  });

  it("rejects an empty blocked reason", () => {
    expect(() =>
      parseOneShotExecutorOutput({ kind: "blocked", reason: "" }),
    ).toThrow(/non-empty string reason/);
  });

  it("rejects unknown keys in replace_exact", () => {
    expect(() =>
      parseOneShotExecutorOutput({
        ...(validReplace() as Record<string, unknown>),
        extra: true,
      } as unknown),
    ).toThrow(/unknown keys.*extra/);
  });

  it("rejects unknown keys in blocked", () => {
    expect(() =>
      parseOneShotExecutorOutput({
        kind: "blocked",
        reason: "x",
        extra: 1,
      } as unknown),
    ).toThrow(/unknown keys.*extra/);
  });

  it("rejects a serialized payload larger than the output budget", () => {
    const huge = "x".repeat(30_000);
    const out = {
      kind: "blocked",
      reason: huge,
    };
    expect(() => parseOneShotExecutorOutput(out)).toThrow(/exceeds.*bytes/);
  });

  it("rejects new_text larger than the source budget", () => {
    const huge = "x".repeat(10_000);
    expect(() => parseOneShotExecutorOutput(validReplace(huge))).toThrow(
      /new_text exceeds/,
    );
  });
});

function validReplaceWithSha(s: string): unknown {
  return {
    ...(validReplace() as Record<string, unknown>),
    expected_file_sha256: s,
  };
}

function validReplaceWithOld(old: string): unknown {
  return { ...(validReplace() as Record<string, unknown>), old_text: old };
}
