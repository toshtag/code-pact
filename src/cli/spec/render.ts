// Derive the three CLI surfaces from a CommandSpec:
//   toParseOptions  → the strictParse options object   (parse)
//   renderLeafHelp  → the LEAF_USAGE text              (help)
//   renderReference → one generated-reference section  (docs)
//
// One source, three outputs. A flag added to a spec flows to all three.

import type { CommandSpec, FlagSpec, ParseArgsOptions } from "./types.ts";

/**
 * FlagSpec[] → the node:util parseArgs options object strictParse expects.
 * A flag with a `value` is a string; without one it is a boolean. `repeatable`
 * maps to `multiple: true`. `required` is intentionally NOT expressed — Node's
 * parseArgs has no required concept, and enforcement lives in command bodies.
 */
export function toParseOptions(spec: CommandSpec): ParseArgsOptions {
  const out: ParseArgsOptions = {};
  for (const f of spec.flags) {
    out[f.name] = {
      type: f.value ? "string" : "boolean",
      ...(f.repeatable ? { multiple: true } : {}),
    };
  }
  return out;
}

/** The Usage synopsis line, e.g. "Usage: code-pact task prepare <task-id> [options]". */
function usageLine(spec: CommandSpec): string {
  const parts =
    spec.cluster === "root"
      ? ["Usage: code-pact", spec.command]
      : ["Usage: code-pact", spec.cluster, spec.command];
  if (spec.positional) parts.push(spec.positional);
  parts.push("[options]");
  return parts.join(" ");
}

/** "--name <value>" or "--name" — the left column of an Options line. */
function flagSyntax(f: FlagSpec): string {
  return f.value ? `--${f.name} ${f.value}` : `--${f.name}`;
}

const READONLY_NOTE = "Read-only — never records a progress event.";

/**
 * Render the rich leaf-help text for a command, matching the established
 * LEAF_USAGE format: Usage line, summary, an aligned Options block, and an
 * Examples block. The readOnly note is appended to the summary so the
 * "Read-only" token the help-terms tests pin is present.
 */
export function renderLeafHelp(spec: CommandSpec): string {
  const lines: string[] = [usageLine(spec), ""];

  const summary = spec.readOnly
    ? `${spec.summary} ${READONLY_NOTE}`
    : spec.summary;
  lines.push(summary, "");

  if (spec.flags.length > 0) {
    lines.push("Options:");
    // Align descriptions: pad the flag syntax to the widest entry (+2 spaces).
    const width = Math.max(...spec.flags.map((f) => flagSyntax(f).length));
    for (const f of spec.flags) {
      const syntax = flagSyntax(f).padEnd(width);
      const req = f.required ? " (required)" : "";
      lines.push(`  ${syntax}  ${f.description}${req}`);
    }
    lines.push("");
  }

  lines.push("Examples:");
  for (const ex of spec.examples) lines.push(`  ${ex}`);

  return lines.join("\n");
}

/**
 * Render one section of docs/cli-reference.generated.md for a command:
 * an H2 heading, the summary, a flag table, and a fenced examples block.
 */
export function renderReference(spec: CommandSpec): string {
  const out: string[] = [];
  const commandLabel =
    spec.cluster === "root" ? spec.command : `${spec.cluster} ${spec.command}`;
  out.push(`## \`${commandLabel}\``, "");

  const synopsis = spec.positional
    ? `\`code-pact ${commandLabel} ${spec.positional} [options]\``
    : `\`code-pact ${commandLabel} [options]\``;
  out.push(synopsis, "");

  const summary = spec.readOnly
    ? `${spec.summary} ${READONLY_NOTE}`
    : spec.summary;
  out.push(summary, "");

  if (spec.flags.length > 0) {
    out.push("| Flag | Value | Description |", "| --- | --- | --- |");
    for (const f of spec.flags) {
      const flagCell = f.required ? `\`--${f.name}\` (required)` : `\`--${f.name}\``;
      const valueCell = f.value
        ? `\`${f.value}\``
        : "—";
      const repeat = f.repeatable ? " (repeatable)" : "";
      out.push(`| ${flagCell} | ${valueCell} | ${f.description}${repeat} |`);
    }
    out.push("");
  }

  if (spec.examples.length > 0) {
    out.push("```sh");
    for (const ex of spec.examples) out.push(ex);
    out.push("```", "");
  }

  return out.join("\n").trimEnd();
}
