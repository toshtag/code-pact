import * as readline from "node:readline/promises";
import { emitKeypressEvents } from "node:readline";

export type PromptIO = {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
};

export interface LineReader {
  question(prompt: string): Promise<string>;
  close(): void;
}

/**
 * Input stream that may support raw-mode keypress navigation. process.stdin
 * (a tty.ReadStream) satisfies this; a plain Readable does not expose
 * `setRawMode`/`isTTY` and falls back to the line-based prompts.
 */
type RawInput = NodeJS.ReadableStream & {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => void;
};

/** Decoded keypress, as emitted by node:readline's `emitKeypressEvents`. */
type KeypressKey = {
  name?: string;
  ctrl?: boolean;
  sequence?: string;
};

export type PrompterOptions = {
  /** Raw input stream used for arrow-key navigation. Defaults to none. */
  input?: RawInput;
  /**
   * When true (and `input` is a raw-capable TTY), `askChoice`, `askMulti`,
   * and `askYesNo` render arrow-key selectors instead of reading typed
   * numbers. Defaults to false so injected test readers keep the line-based
   * behaviour they script against.
   */
  interactive?: boolean;
};

// ANSI control sequences. Selectors render to `output` (stderr in production)
// so stdout stays reserved for structured command results.
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CLEAR_LINE = "\x1b[2K";
const POINTER = "❯"; // ❯
const C_ACTIVE = "\x1b[36m"; // cyan
const C_DIM = "\x1b[2m";
const C_WARN = "\x1b[33m"; // yellow
const C_RESET = "\x1b[0m";

const HINT_SINGLE = `${C_DIM}(↑/↓ move · Enter select)${C_RESET}`;
const HINT_MULTI = `${C_DIM}(↑/↓ move · Space toggle · Enter confirm)${C_RESET}`;

class ReadlineLineReader implements LineReader {
  // A fresh interface per question keeps the shared stdin free between
  // prompts so the raw-mode selectors can take it over without contending
  // with a long-lived readline interface.
  constructor(private readonly io: PromptIO) {}
  async question(prompt: string): Promise<string> {
    const rl = readline.createInterface({ input: this.io.input, output: this.io.output });
    try {
      return await rl.question(prompt);
    } finally {
      rl.close();
    }
  }
  close(): void {
    // no persistent resource to release.
  }
}

export class Prompter {
  private readonly reader: LineReader;
  private readonly output: NodeJS.WritableStream;
  private readonly opts: PrompterOptions;

  constructor(reader: LineReader, output: NodeJS.WritableStream, opts: PrompterOptions = {}) {
    this.reader = reader;
    this.output = output;
    this.opts = opts;
  }

  // Production constructor — wires up node:readline against the given streams.
  // Wizard prompts go to stderr by default so stdout stays reserved for the
  // command's structured result (matching docs/cli-contract.md). Arrow-key
  // navigation is enabled only when both ends are interactive TTYs.
  static fromIO(io?: PromptIO): Prompter {
    const input = (io?.input ?? process.stdin) as RawInput;
    const output = io?.output ?? process.stderr;
    const interactive =
      Boolean(input.isTTY) &&
      typeof input.setRawMode === "function" &&
      Boolean((output as { isTTY?: boolean }).isTTY);
    return new Prompter(new ReadlineLineReader({ input, output }), output, { input, interactive });
  }

  private get useRaw(): boolean {
    return Boolean(this.opts.interactive && this.opts.input);
  }

  async ask(question: string): Promise<string> {
    const answer = await this.reader.question(`${question} `);
    return answer.trim();
  }

  async askChoice(question: string, choices: readonly string[]): Promise<number> {
    if (choices.length === 0) {
      throw new Error("askChoice: choices must not be empty");
    }
    if (this.useRaw) {
      return this.rawSelectSingle(question, choices, 0);
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
    if (this.useRaw) {
      return this.rawSelectMulti(question, choices, min);
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
    if (this.useRaw) {
      const idx = await this.rawSelectSingle(question, ["Yes", "No"], defaultYes ? 0 : 1);
      return idx === 0;
    }
    const suffix = defaultYes ? "[Y/n]" : "[y/N]";
    for (;;) {
      const raw = (await this.reader.question(`${question} ${suffix} `)).trim().toLowerCase();
      if (raw === "") return defaultYes;
      if (raw === "y" || raw === "yes") return true;
      if (raw === "n" || raw === "no") return false;
      this.output.write("Please answer y or n.\n");
    }
  }

  // --- raw-mode (arrow-key) selectors -------------------------------------

  private beginRaw(): RawInput {
    const input = this.opts.input as RawInput;
    emitKeypressEvents(input);
    if (input.isTTY && input.setRawMode) input.setRawMode(true);
    (input as NodeJS.ReadableStream).resume?.();
    this.output.write(HIDE_CURSOR);
    return input;
  }

  private endRaw(input: RawInput, onKey: (...args: unknown[]) => void): void {
    input.removeListener("keypress", onKey);
    if (input.isTTY && input.setRawMode) input.setRawMode(false);
    this.output.write(SHOW_CURSOR);
  }

  private rawSelectSingle(
    question: string,
    choices: readonly string[],
    initial: number,
  ): Promise<number> {
    const total = choices.length + 1; // choices + hint line
    let active = Math.min(Math.max(initial, 0), choices.length - 1);

    const render = (first: boolean): void => {
      if (!first) this.output.write(`\x1b[${total}A`);
      let block = "";
      for (let i = 0; i < choices.length; i++) {
        const isActive = i === active;
        const label = `${isActive ? `${POINTER} ` : "  "}${choices[i]}`;
        block += `${CLEAR_LINE}${isActive ? `${C_ACTIVE}${label}${C_RESET}` : label}\n`;
      }
      block += `${CLEAR_LINE}${HINT_SINGLE}\n`;
      this.output.write(block);
    };

    return new Promise<number>((resolve) => {
      const input = this.beginRaw();
      this.output.write(`${question}\n`);
      render(true);
      const onKey = (_str: unknown, key: KeypressKey | undefined): void => {
        if (!key) return;
        if (key.ctrl && key.name === "c") {
          this.endRaw(input, onKey as (...args: unknown[]) => void);
          this.output.write("\n");
          process.exit(130);
        }
        switch (key.name) {
          case "up":
          case "k":
            active = (active - 1 + choices.length) % choices.length;
            render(false);
            break;
          case "down":
          case "j":
            active = (active + 1) % choices.length;
            render(false);
            break;
          case "return":
          case "enter":
            this.endRaw(input, onKey as (...args: unknown[]) => void);
            this.output.write("\n");
            resolve(active);
            break;
          default:
            break;
        }
      };
      input.on("keypress", onKey);
    });
  }

  private rawSelectMulti(
    question: string,
    choices: readonly string[],
    min: number,
  ): Promise<number[]> {
    const total = choices.length + 1; // choices + hint/warning line
    let active = 0;
    let warn = "";
    const checked = new Set<number>();

    const render = (first: boolean): void => {
      if (!first) this.output.write(`\x1b[${total}A`);
      let block = "";
      for (let i = 0; i < choices.length; i++) {
        const isActive = i === active;
        const box = checked.has(i) ? "[x]" : "[ ]";
        const label = `${isActive ? `${POINTER} ` : "  "}${box} ${choices[i]}`;
        block += `${CLEAR_LINE}${isActive ? `${C_ACTIVE}${label}${C_RESET}` : label}\n`;
      }
      const footer = warn ? `${C_WARN}${warn}${C_RESET}` : HINT_MULTI;
      block += `${CLEAR_LINE}${footer}\n`;
      this.output.write(block);
    };

    return new Promise<number[]>((resolve) => {
      const input = this.beginRaw();
      this.output.write(`${question}\n`);
      render(true);
      const onKey = (_str: unknown, key: KeypressKey | undefined): void => {
        if (!key) return;
        if (key.ctrl && key.name === "c") {
          this.endRaw(input, onKey as (...args: unknown[]) => void);
          this.output.write("\n");
          process.exit(130);
        }
        switch (key.name) {
          case "up":
          case "k":
            active = (active - 1 + choices.length) % choices.length;
            render(false);
            break;
          case "down":
          case "j":
            active = (active + 1) % choices.length;
            render(false);
            break;
          case "space":
            if (checked.has(active)) checked.delete(active);
            else checked.add(active);
            warn = "";
            render(false);
            break;
          case "return":
          case "enter":
            if (checked.size < min) {
              warn = `At least ${min} selection(s) required.`;
              render(false);
              break;
            }
            this.endRaw(input, onKey as (...args: unknown[]) => void);
            this.output.write("\n");
            resolve([...checked].sort((a, b) => a - b));
            break;
          default:
            break;
        }
      };
      input.on("keypress", onKey);
    });
  }

  close(): void {
    this.reader.close();
  }
}
