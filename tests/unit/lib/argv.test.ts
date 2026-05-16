import { describe, it, expect } from "vitest";
import { splitArgv } from "../../../src/lib/argv.ts";

describe("splitArgv — global flags before command", () => {
  it("--version with no command sets version, command is undefined", () => {
    const { globalValues, command, rest } = splitArgv(["--version"]);
    expect(globalValues.version).toBe(true);
    expect(command).toBeUndefined();
    expect(rest).toEqual([]);
  });

  it("--version --json with no command captures both flags", () => {
    const { globalValues, command } = splitArgv(["--version", "--json"]);
    expect(globalValues.version).toBe(true);
    expect(globalValues.json).toBe(true);
    expect(command).toBeUndefined();
  });

  it("--json before command routes subcommand args correctly", () => {
    const { globalValues, command, rest } = splitArgv(["--json", "phase", "ls"]);
    expect(globalValues.json).toBe(true);
    expect(command).toBe("phase");
    expect(rest).toEqual(["ls"]);
  });

  it("command with no global flags gives empty globalValues", () => {
    const { globalValues, command, rest } = splitArgv(["phase", "add", "--id", "P1"]);
    expect(globalValues.version).toBeUndefined();
    expect(command).toBe("phase");
    expect(rest).toEqual(["add", "--id", "P1"]);
  });
});

describe("splitArgv — BUG-002: --version inside subcommand args is not treated as global", () => {
  it("phase add --verify-command node --version does not set globalValues.version", () => {
    const { globalValues, command, rest } = splitArgv([
      "phase",
      "add",
      "--verify-command",
      "node",
      "--version",
    ]);
    expect(globalValues.version).toBeUndefined();
    expect(command).toBe("phase");
    expect(rest).toEqual(["add", "--verify-command", "node", "--version"]);
  });

  it("verify --phase P1 --task T1 --version does not set globalValues.version", () => {
    const { globalValues, command, rest } = splitArgv([
      "verify",
      "--phase",
      "P1",
      "--task",
      "T1",
      "--version",
    ]);
    expect(globalValues.version).toBeUndefined();
    expect(command).toBe("verify");
    expect(rest).toContain("--version");
  });
});
