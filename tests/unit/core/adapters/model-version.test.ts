import { describe, it, expect } from "vitest";
import {
  normalizeModelVersion,
  ACCEPTED_MODEL_VERSION_INPUTS,
} from "../../../../src/core/schemas/agent-profile.ts";
import { validateModelVersionInput } from "../../../../src/core/adapters/model-version.ts";

describe("normalizeModelVersion", () => {
  it("passes canonical versions through unchanged", () => {
    expect(normalizeModelVersion("opus-4.7")).toBe("opus-4.7");
    expect(normalizeModelVersion("opus-4.6")).toBe("opus-4.6");
    expect(normalizeModelVersion("sonnet-4.6")).toBe("sonnet-4.6");
  });

  it("normalizes vendor-id aliases", () => {
    expect(normalizeModelVersion("claude-opus-4-7")).toBe("opus-4.7");
    expect(normalizeModelVersion("claude-opus-4-6")).toBe("opus-4.6");
    expect(normalizeModelVersion("claude-sonnet-4-6")).toBe("sonnet-4.6");
  });

  it("is case-insensitive on aliases and trims whitespace", () => {
    expect(normalizeModelVersion("  CLAUDE-OPUS-4-7  ")).toBe("opus-4.7");
  });

  it("returns null for unrecognized input (no silent fallback)", () => {
    expect(normalizeModelVersion("gpt-4")).toBeNull();
    expect(normalizeModelVersion("opus")).toBeNull();
    expect(normalizeModelVersion("")).toBeNull();
  });

  it("ACCEPTED_MODEL_VERSION_INPUTS lists every accepted form", () => {
    for (const input of ACCEPTED_MODEL_VERSION_INPUTS) {
      expect(normalizeModelVersion(input)).not.toBeNull();
    }
  });
});

describe("validateModelVersionInput", () => {
  it("returns undefined when no --model was given", () => {
    expect(validateModelVersionInput(undefined)).toBeUndefined();
  });

  it("returns the canonical form for a valid input", () => {
    expect(validateModelVersionInput("claude-opus-4-7")).toBe("opus-4.7");
  });

  it("throws CONFIG_ERROR for an unknown input", () => {
    expect(() => validateModelVersionInput("future-model")).toThrow(
      expect.objectContaining({ code: "CONFIG_ERROR" }),
    );
  });
});
