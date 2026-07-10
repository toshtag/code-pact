// CommandSpec — the single source for a CLI subcommand's flag surface.
//
// Before this, a command's flags were declared three times with nothing to
// keep them in sync: the strictParse options literal (parse), the LEAF_USAGE
// entry (help), and the flag table in cli-contract.md (reference). A
// CommandSpec is declared once; toParseOptions/renderLeafHelp/renderReference
// derive the three surfaces from it.
//
// Scope note (P46): this type describes the *flag surface* plus the single
// `readOnly` semantic flag — nothing more. Write/lifecycle/recovery semantics
// are deliberately out (they would bloat the type and belong to later phases).
// See design/decisions/cli-command-spec-rfc.md.

import type { ParseArgsConfig } from "node:util";

/** A single long-form flag. */
export type FlagSpec = {
  /** Long flag name without dashes, e.g. "budget-bytes". */
  name: string;
  /**
   * Value placeholder shown in help, e.g. "<N>". Presence means the flag takes
   * a string value; absence means it is a boolean. (Maps to parseArgs `type`.)
   */
  value?: string;
  /**
   * Presentation-only. Marks the flag as required in help/reference. This is
   * NOT runtime enforcement — Node's parseArgs has no required concept, and the
   * actual required-flag checks live in the command bodies. Guarded by parse
   * regression tests, not by the spec.
   */
  required?: boolean;
  /** Repeatable flag — accumulates values. Maps to parseArgs `multiple: true`. */
  repeatable?: boolean;
  /** One-line description, used in both help and the generated reference. */
  description: string;
};

/** The single source for one subcommand. */
export type CommandSpec = {
  /** Cluster the command belongs to, or "root" for a top-level command. */
  cluster: "task" | "plan" | "phase" | "adapter" | "decision" | "state" | "spec" | "evidence" | "root";
  /** Subcommand name, e.g. "prepare". */
  command: string;
  /** Positional placeholder for the synopsis, e.g. "<task-id>". Omit if none. */
  positional?: string;
  /** The paragraph(s) shown under the Usage line. Carried verbatim into help. */
  summary: string;
  /** The flag surface. */
  flags: FlagSpec[];
  /** Full example command lines. */
  examples: string[];
  /** Surfaces the standard "Read-only — never records a progress event" note. */
  readOnly?: boolean;
};

/** The options object node:util parseArgs (and strictParse) expects. */
export type ParseArgsOptions = NonNullable<ParseArgsConfig["options"]>;
