import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { Prompter, type LineReader } from "../../../src/lib/prompt.ts";

class ScriptedReader implements LineReader {
  private idx = 0;
  constructor(private readonly lines: readonly string[]) {}
  async question(_prompt: string): Promise<string> {
    if (this.idx >= this.lines.length) {
      throw new Error("ScriptedReader exhausted");
    }
    return this.lines[this.idx++]!;
  }
  close(): void {
    // no-op
  }
}

function setup(scriptedLines: readonly string[]): {
  prompter: Prompter;
  outputText: () => string;
} {
  const reader = new ScriptedReader(scriptedLines);
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
  return {
    prompter: new Prompter(reader, output),
    outputText: () => Buffer.concat(chunks).toString("utf8"),
  };
}

describe("Prompter.ask", () => {
  it("returns trimmed input", async () => {
    const { prompter } = setup(["  hello world  "]);
    expect(await prompter.ask("name?")).toBe("hello world");
  });

  it("returns empty string when input is just whitespace", async () => {
    const { prompter } = setup(["   "]);
    expect(await prompter.ask("x?")).toBe("");
  });
});

describe("Prompter.askChoice", () => {
  it("returns 0-based index for valid numeric input", async () => {
    const { prompter } = setup(["2"]);
    expect(await prompter.askChoice("pick?", ["a", "b", "c"])).toBe(1);
  });

  it("retries on out-of-range input", async () => {
    const { prompter, outputText } = setup(["5", "0", "1"]);
    expect(await prompter.askChoice("pick?", ["a", "b", "c"])).toBe(0);
    expect(outputText()).toContain("Invalid choice");
  });

  it("retries on non-numeric input", async () => {
    const { prompter } = setup(["abc", "2"]);
    expect(await prompter.askChoice("pick?", ["a", "b"])).toBe(1);
  });

  it("throws when choices is empty", async () => {
    const { prompter } = setup([]);
    await expect(prompter.askChoice("pick?", [])).rejects.toThrow();
  });
});

describe("Prompter.askMulti", () => {
  it("returns 0-based indexes for comma-separated input", async () => {
    const { prompter } = setup(["1,3"]);
    expect(await prompter.askMulti("pick?", ["a", "b", "c"], 1)).toEqual([0, 2]);
  });

  it("trims whitespace around tokens", async () => {
    const { prompter } = setup(["1 ,  2 "]);
    expect(await prompter.askMulti("pick?", ["a", "b", "c"], 1)).toEqual([0, 1]);
  });

  it("deduplicates repeated indexes", async () => {
    const { prompter } = setup(["1,1,2"]);
    expect(await prompter.askMulti("pick?", ["a", "b"], 1)).toEqual([0, 1]);
  });

  it("retries when fewer than min are selected", async () => {
    const { prompter, outputText } = setup(["", "1,2"]);
    expect(await prompter.askMulti("pick?", ["a", "b", "c"], 2)).toEqual([0, 1]);
    expect(outputText()).toContain("At least 2");
  });

  it("retries on out-of-range token", async () => {
    const { prompter } = setup(["9", "1"]);
    expect(await prompter.askMulti("pick?", ["a", "b"], 1)).toEqual([0]);
  });
});

describe("Prompter.askYesNo", () => {
  it("returns true on y", async () => {
    const { prompter } = setup(["y"]);
    expect(await prompter.askYesNo("?", false)).toBe(true);
  });

  it("returns true on yes (case-insensitive)", async () => {
    const { prompter } = setup(["YES"]);
    expect(await prompter.askYesNo("?", false)).toBe(true);
  });

  it("returns false on n", async () => {
    const { prompter } = setup(["n"]);
    expect(await prompter.askYesNo("?", true)).toBe(false);
  });

  it("returns default true on empty input", async () => {
    const { prompter } = setup([""]);
    expect(await prompter.askYesNo("?", true)).toBe(true);
  });

  it("returns default false on empty input", async () => {
    const { prompter } = setup([""]);
    expect(await prompter.askYesNo("?", false)).toBe(false);
  });

  it("retries on invalid input", async () => {
    const { prompter, outputText } = setup(["maybe", "y"]);
    expect(await prompter.askYesNo("?", false)).toBe(true);
    expect(outputText()).toContain("Please answer y or n");
  });
});

describe("Prompter session", () => {
  it("supports multiple sequential prompts on the same session", async () => {
    const { prompter } = setup(["first", "2", "y"]);
    const name = await prompter.ask("name?");
    const choice = await prompter.askChoice("pick?", ["a", "b", "c"]);
    const ok = await prompter.askYesNo("confirm?", false);
    expect({ name, choice, ok }).toEqual({ name: "first", choice: 1, ok: true });
  });
});
