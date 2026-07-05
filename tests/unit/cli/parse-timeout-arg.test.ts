import { describe, it, expect, vi } from "vitest";
import { parseTimeoutArg } from "../../../src/cli/util.ts";

describe("parseTimeoutArg", () => {
  it("returns undefined when raw is undefined", () => {
    expect(parseTimeoutArg(undefined, false, 2147483647)).toBeUndefined();
  });

  it("returns the number for a valid positive integer", () => {
    expect(parseTimeoutArg("300000", false, 2147483647)).toBe(300000);
  });

  it("returns 1 for the minimum value", () => {
    expect(parseTimeoutArg("1", false, 2147483647)).toBe(1);
  });

  it("returns MAX_TIMEOUT_MS for the maximum value", () => {
    expect(parseTimeoutArg("2147483647", false, 2147483647)).toBe(2147483647);
  });

  it("returns 2 and emits CONFIG_ERROR for 0", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = parseTimeoutArg("0", false, 2147483647);
    expect(result).toBe(2);
    spy.mockRestore();
  });

  it("returns 2 and emits CONFIG_ERROR for negative", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = parseTimeoutArg("-1", false, 2147483647);
    expect(result).toBe(2);
    spy.mockRestore();
  });

  it("returns 2 and emits CONFIG_ERROR for NaN", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = parseTimeoutArg("abc", false, 2147483647);
    expect(result).toBe(2);
    spy.mockRestore();
  });

  it("returns 2 and emits CONFIG_ERROR for Infinity", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = parseTimeoutArg("Infinity", false, 2147483647);
    expect(result).toBe(2);
    spy.mockRestore();
  });

  it("returns 2 and emits CONFIG_ERROR for non-integer (0.5)", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = parseTimeoutArg("0.5", false, 2147483647);
    expect(result).toBe(2);
    spy.mockRestore();
  });

  it("returns 2 and emits CONFIG_ERROR for value exceeding max", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = parseTimeoutArg("2147483648", false, 2147483647);
    expect(result).toBe(2);
    spy.mockRestore();
  });

  it("emits JSON envelope in JSON mode", () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const result = parseTimeoutArg("0", true, 2147483647);
    expect(result).toBe(2);
    const output = stdoutSpy.mock.calls[0]?.[0] as string;
    expect(output).toContain('"ok":false');
    expect(output).toContain('"CONFIG_ERROR"');
    stdoutSpy.mockRestore();
  });
});
