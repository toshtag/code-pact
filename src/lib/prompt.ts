import * as readline from "node:readline/promises";

export type PromptIO = {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
};

export interface LineReader {
  question(prompt: string): Promise<string>;
  close(): void;
}

class ReadlineLineReader implements LineReader {
  private readonly rl: readline.Interface;
  constructor(io: PromptIO) {
    this.rl = readline.createInterface({ input: io.input, output: io.output });
  }
  question(prompt: string): Promise<string> {
    return this.rl.question(prompt);
  }
  close(): void {
    this.rl.close();
  }
}

export class Prompter {
  private readonly reader: LineReader;
  private readonly output: NodeJS.WritableStream;

  constructor(reader: LineReader, output: NodeJS.WritableStream) {
    this.reader = reader;
    this.output = output;
  }

  // Production constructor — wires up node:readline against the given streams.
  // Wizard prompts go to stderr by default so stdout stays reserved for the
  // command's structured result (matching docs/cli-contract.md).
  static fromIO(io?: PromptIO): Prompter {
    const effective: PromptIO = io ?? { input: process.stdin, output: process.stderr };
    return new Prompter(new ReadlineLineReader(effective), effective.output);
  }

  async ask(question: string): Promise<string> {
    const answer = await this.reader.question(`${question} `);
    return answer.trim();
  }

  async askChoice(question: string, choices: readonly string[]): Promise<number> {
    if (choices.length === 0) {
      throw new Error("askChoice: choices must not be empty");
    }
    const lines = choices.map((c, i) => `  ${i + 1}. ${c}`).join("\n");
    const fullPrompt = `${question}\n${lines}\n> `;
    for (;;) {
      const raw = (await this.reader.question(fullPrompt)).trim();
      const n = Number(raw);
      if (Number.isInteger(n) && n >= 1 && n <= choices.length) {
        return n - 1;
      }
      this.output.write("Invalid choice. Please try again.\n");
    }
  }

  async askMulti(
    question: string,
    choices: readonly string[],
    min: number = 1,
  ): Promise<number[]> {
    if (choices.length === 0) {
      throw new Error("askMulti: choices must not be empty");
    }
    const lines = choices.map((c, i) => `  ${i + 1}. ${c}`).join("\n");
    const fullPrompt = `${question} (comma separated)\n${lines}\n> `;
    for (;;) {
      const raw = (await this.reader.question(fullPrompt)).trim();
      if (raw.length === 0) {
        this.output.write(`At least ${min} selection(s) required.\n`);
        continue;
      }
      const tokens = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
      const nums: number[] = [];
      let invalid = false;
      for (const t of tokens) {
        const n = Number(t);
        if (!Number.isInteger(n) || n < 1 || n > choices.length) {
          invalid = true;
          break;
        }
        const idx = n - 1;
        if (!nums.includes(idx)) nums.push(idx);
      }
      if (invalid || nums.length < min) {
        this.output.write("Invalid selection. Please try again.\n");
        continue;
      }
      return nums;
    }
  }

  write(msg: string): void {
    this.output.write(msg);
  }

  async askYesNo(question: string, defaultYes: boolean): Promise<boolean> {
    const suffix = defaultYes ? "[Y/n]" : "[y/N]";
    for (;;) {
      const raw = (await this.reader.question(`${question} ${suffix} `)).trim().toLowerCase();
      if (raw === "") return defaultYes;
      if (raw === "y" || raw === "yes") return true;
      if (raw === "n" || raw === "no") return false;
      this.output.write("Please answer y or n.\n");
    }
  }

  close(): void {
    this.reader.close();
  }
}
