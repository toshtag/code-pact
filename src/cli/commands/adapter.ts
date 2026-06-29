// The CLI wrapper layer for the `adapter` subcommand cluster. Routes
// `adapter <subcommand>` to the per-subcommand handlers defined below.
// JSON envelopes, exit codes, error codes, and flag surfaces are part
// of the stable CLI contract.
//
// `cmdAdapter` is the cluster-entry dispatch and is the only export.
// The per-subcommand handlers (cmdAdapterList, cmdAdapterInstall,
// etc.) plus the `runAdapterInstallAndEmit` helper (shared between
// `cmdAdapterInstall` and `cmdAdapterBareForm`) are private to this
// module.

import { parseArgs } from "node:util";
import { messages, type Locale } from "../../i18n/index.ts";
import {
  clusterUsage,
  emitUsage,
  hasHelpFlag,
  isHelpToken,
  subcommandUsage,
} from "../usage.ts";
import { emitOk, emitError } from "../util.ts";
import { isSupportedAgent } from "../../core/agents.ts";
import {
  runAdapterInstall,
  runAdapterList,
  runAdapterDoctor,
  runAdapterUpgrade,
  detectAgentModelMapDrift,
} from "../../commands/adapter.ts";
import { runAdapterConformance } from "../../commands/adapter-conformance.ts";

// ---------------------------------------------------------------------------
// Command: adapter
// ---------------------------------------------------------------------------

export async function cmdAdapter(
  argv: string[],
  locale: Locale,
  globalJson: boolean,
): Promise<number> {
  const sub = argv[0];
  const rest = argv.slice(1);

  // Effective --json honors both the global flag (before the command) and
  // a --json embedded in the subcommand args (after the command).
  const effectiveJson = globalJson || argv.includes("--json");

  // `adapter --help` / `-h` / `help` → cluster usage (exit 0). Note: bare
  // `adapter` (no subcommand) is deliberately NOT treated as help — it is a
  // CONFIG_ERROR below, since the old implicit-install bare form is removed.
  if (isHelpToken(sub)) {
    return emitUsage(clusterUsage("adapter"));
  }

  const KNOWN_SUBCOMMANDS = new Set([
    "list",
    "install",
    "upgrade",
    "doctor",
    "conformance",
  ]);
  // `adapter <sub> --help` → per-subcommand usage (exit 0).
  if (sub !== undefined && KNOWN_SUBCOMMANDS.has(sub) && hasHelpFlag(rest)) {
    return emitUsage(subcommandUsage("adapter", sub));
  }

  if (sub === "list") return cmdAdapterList(rest, globalJson);
  if (sub === "install") return cmdAdapterInstall(rest, locale, globalJson);
  if (sub === "doctor") return cmdAdapterDoctor(rest, locale, globalJson);
  if (sub === "upgrade") return cmdAdapterUpgrade(rest, locale, globalJson);
  if (sub === "conformance") return cmdAdapterConformance(rest, globalJson);

  // Reject unknown sub-words (anything that doesn't start with `-`).
  if (sub !== undefined && !sub.startsWith("-")) {
    const msg = `adapter: unknown subcommand "${sub}". Use: list | install | upgrade | doctor | conformance`;
    emitError(effectiveJson, "CONFIG_ERROR", msg);
    return 2;
  }

  // Bare `code-pact adapter` (no subcommand, or flag-only like `--agent X`).
  // The deprecated implicit-install bare form is removed: a warning that also
  // mutates the project is exactly the "warning + side effect" hazard this
  // hardening pass is closing. Require the explicit subcommand. No side effects.
  const msg =
    'adapter requires a subcommand — the bare form is removed. Use: code-pact adapter install <agent> (or list | upgrade | doctor | conformance). Run "code-pact adapter --help".';
  emitError(effectiveJson, "CONFIG_ERROR", msg);
  return 2;
}

async function cmdAdapterList(
  argv: string[],
  globalJson: boolean,
): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { json: { type: "boolean" } },
    strict: false,
    allowPositionals: false,
  });
  const json = globalJson || values.json === true;
  const result = await runAdapterList({ cwd: process.cwd() });

  if (json) {
    emitOk(result);
    return 0;
  }

  for (const a of result.agents) {
    const flags = [
      a.enabled ? "enabled" : "disabled",
      a.experimental ? "experimental" : null,
      a.manifestPresent
        ? `manifest (${a.fileCount ?? 0} files)`
        : "no manifest",
      a.manifestInvalid ? "INVALID" : null,
    ]
      .filter((s): s is string => s !== null)
      .join(", ");
    process.stderr.write(`  ${a.name.padEnd(12)} ${flags}\n`);
  }
  return 0;
}

async function cmdAdapterInstall(
  argv: string[],
  locale: Locale,
  globalJson: boolean,
): Promise<number> {
  const m = messages[locale];
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      force: { type: "boolean" },
      json: { type: "boolean" },
      model: { type: "string" },
      "regen-skills": { type: "boolean" },
    },
    strict: false,
    allowPositionals: true,
  });

  const json = globalJson || values.json === true;
  const agentName = positionals[0];
  const force = values.force === true;
  const modelVersion = values.model as string | undefined;
  const regenSkills = values["regen-skills"] === true;

  if (!agentName) {
    const msg =
      "adapter install requires an <agent> argument (e.g. claude-code).";
    emitError(json, "CONFIG_ERROR", msg);
    return 2;
  }

  return runAdapterInstallAndEmit({
    agentName,
    force,
    locale,
    modelVersion,
    regenSkills,
    json,
    m,
  });
}

async function cmdAdapterDoctor(
  argv: string[],
  locale: Locale,
  globalJson: boolean,
): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      agent: { type: "string" },
      json: { type: "boolean" },
    },
    strict: false,
    allowPositionals: false,
  });

  const json = globalJson || values.json === true;
  const agentName = values.agent as string | undefined;
  const cwd = process.cwd();

  try {
    const result = await runAdapterDoctor({ cwd, agentName, locale });

    if (json) {
      emitOk(result);
    } else {
      if (result.issues.length === 0) {
        process.stderr.write("No adapter issues found.\n");
      } else {
        for (const issue of result.issues) {
          const sev = issue.severity === "error" ? "ERROR " : "WARN  ";
          const where = issue.path ? ` (${issue.path})` : "";
          process.stderr.write(
            `  ${sev} ${issue.code.padEnd(28)} [${issue.agent}] ${issue.message}${where}\n`,
          );
        }
      }
    }
    return result.ok ? 0 : 1;
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      (err as NodeJS.ErrnoException).code === "AGENT_NOT_FOUND"
    ) {
      const msg = messages[locale].adapter.agentNotFound(agentName ?? "");
      emitError(json, "AGENT_NOT_FOUND", msg);
      return 2;
    }
    throw err;
  }
}

async function cmdAdapterConformance(
  argv: string[],
  globalJson: boolean,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean" },
    },
    strict: false,
    allowPositionals: true,
  });

  const json = globalJson || values.json === true;
  const agentName = positionals[0];

  if (!agentName) {
    const msg =
      "adapter conformance requires an <agent> argument (e.g. claude-code).";
    emitError(json, "CONFIG_ERROR", msg);
    return 2;
  }

  if (!isSupportedAgent(agentName)) {
    const msg = `Agent "${agentName}" is not a supported adapter.`;
    emitError(json, "AGENT_NOT_FOUND", msg);
    return 2;
  }

  const cwd = process.cwd();
  const result = await runAdapterConformance({ cwd, agentName });

  if (json) {
    emitOk(result);
  } else {
    process.stdout.write(`Agent:     ${result.agent}\n`);
    process.stdout.write(`Compliant: ${result.compliant ? "yes" : "NO"}\n`);
    process.stdout.write(`Checks:\n`);
    for (const c of result.checks) {
      // A failing advisory check is a non-blocking warning (it keeps
      // compliance); mark it distinctly from a hard (required) failure.
      const status =
        c.status === "pass"
          ? "PASS"
          : c.severity === "advisory"
            ? "WARN"
            : "FAIL";
      const file = c.file ? ` (${c.file})` : "";
      process.stdout.write(`  ${status}  ${c.id}${file}\n`);
      if (c.status === "fail" && c.details) {
        for (const [k, v] of Object.entries(c.details)) {
          const v_str = Array.isArray(v) ? v.join(", ") : String(v);
          process.stdout.write(`         ${k}: ${v_str}\n`);
        }
      }
    }
  }
  return result.compliant ? 0 : 1;
}

async function cmdAdapterUpgrade(
  argv: string[],
  locale: Locale,
  globalJson: boolean,
): Promise<number> {
  const m = messages[locale];
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      check: { type: "boolean" },
      write: { type: "boolean" },
      force: { type: "boolean" },
      "accept-modified": { type: "boolean" },
      "regen-skills": { type: "boolean" },
      model: { type: "string" },
      json: { type: "boolean" },
    },
    strict: false,
    allowPositionals: true,
  });

  const json = globalJson || values.json === true;
  const agentName = positionals[0];
  const check = values.check === true;
  const write = values.write === true;
  const force = values.force === true;
  const acceptModified = values["accept-modified"] === true;
  const regenSkills = values["regen-skills"] === true;
  const modelVersion = values.model as string | undefined;

  if (!agentName) {
    const msg =
      "adapter upgrade requires an <agent> argument (e.g. claude-code).";
    emitError(json, "CONFIG_ERROR", msg);
    return 2;
  }

  if (check === write) {
    // Both true or both false → require explicit choice.
    const msg = check
      ? "adapter upgrade: --check and --write are mutually exclusive."
      : "adapter upgrade requires either --check or --write.";
    emitError(json, "CONFIG_ERROR", msg);
    return 2;
  }

  // `--model` persists the pin to the agent profile — a write. `--check` is
  // contractually read-only, so the combination is incoherent: reject it
  // rather than silently ignore or silently mutate.
  if (check && modelVersion !== undefined) {
    const msg =
      "adapter upgrade: --model cannot be combined with --check (--model pins the profile, which --check must not do). Use --write to pin a model.";
    emitError(json, "CONFIG_ERROR", msg);
    return 2;
  }

  const mode = check ? "check" : "write";

  try {
    const result = await runAdapterUpgrade({
      cwd: process.cwd(),
      agentName,
      mode,
      force,
      acceptModified,
      locale,
      modelVersion,
      regenSkills,
    });

    if (json) {
      emitOk(result);
    } else {
      for (const entry of result.plan) {
        // `warn` (unowned orphan) gets its own explained block below, so it is
        // not surfaced as a bare action line here (it would read as a cryptic
        // "warn <path>" with no reason or next step).
        if (entry.action === "skip" || entry.action === "warn") continue;
        process.stderr.write(
          `  ${entry.action.padEnd(18)} ${entry.relPath} [${entry.local} × ${entry.desired}]\n`,
        );
      }

      // Dynamic file warnings: existing files in the shared create namespace
      // (e.g. `.claude/skills/*.md`) that were preserved without read/hash.
      // These are NOT refused — the upgrade continues with other mutations.
      const dynamicWarnings = result.plan.filter(
        p => p.action === "warn" && p.reason === "dynamic_file_unverifiable",
      );
      if (dynamicWarnings.length > 0) {
        const verb =
          mode === "check" ? "are on disk" : "were preserved on disk";
        process.stderr.write(
          `${dynamicWarnings.length} existing dynamic file(s) ${verb} — not read, hashed, or overwritten ` +
            `(shared namespace cannot prove ownership of existing bytes):\n`,
        );
        for (const w of dynamicWarnings)
          process.stderr.write(`  ${w.relPath}\n`);
        process.stderr.write(
          `Review them by hand. To regenerate any of them, move or delete the file, then re-run\n` +
            `  code-pact adapter upgrade ${agentName} --write\n`,
        );
      }

      // Unowned orphans: files the manifest tracked but the generator no longer
      // emits, whose path is NOT in this adapter's owned set. code-pact will not
      // delete a file based on a project-supplied (unauthenticated) manifest
      // alone, so it keeps them and tells the user exactly what to inspect.
      const orphanWarnings = result.plan.filter(
        p => p.action === "warn" && p.reason === "unowned_orphan_not_pruned",
      );
      if (orphanWarnings.length > 0) {
        const verb =
          mode === "check" ? "are still on disk" : "were kept on disk";
        process.stderr.write(
          `${orphanWarnings.length} orphaned file(s) ${verb} — no longer generated, but not auto-removed ` +
            `(not in this adapter's owned path set, so deleting on a project-supplied manifest alone is unsafe):\n`,
        );
        for (const w of orphanWarnings)
          process.stderr.write(`  ${w.relPath}\n`);
        process.stderr.write(
          `Review and delete them by hand if they are stale (e.g. \`rm <path>\`).\n`,
        );
      }

      if (mode === "check") {
        if (result.clean) {
          process.stderr.write("Clean — no upgrade actions needed.\n");
        } else if (
          result.plan.some(p => p.action !== "skip" && p.action !== "warn")
        ) {
          process.stderr.write(
            `Drift detected — run "code-pact adapter upgrade ${agentName} --write" to apply.\n`,
          );
        } else {
          // warn-only: --write would not change anything (dynamic files are
          // preserved, unowned orphans are never auto-removed), so the manual
          // steps above are the only actions.
          process.stderr.write(
            `No automatic upgrade actions — review the file(s) listed above.\n`,
          );
        }
      } else {
        const refusedEntries = result.plan.filter(p => p.action === "refuse");
        if (refusedEntries.length > 0) {
          const reasons = new Set(refusedEntries.map(p => p.reason));
          process.stderr.write(
            `${refusedEntries.length} file(s) refused — review them.\n`,
          );
          if (reasons.has("managed_modified")) {
            process.stderr.write(
              `  - local edits: re-run with --accept-modified to overwrite them.\n`,
            );
          }
          if (reasons.has("unowned_generated_path")) {
            process.stderr.write(
              `  - generated path outside this adapter's owned set — NOT auto-written;\n` +
                `    --accept-modified will NOT override it. Inspect/remove it by hand.\n`,
            );
          }
          if (reasons.has("symlink_traversal")) {
            process.stderr.write(
              `  - path reaches its real target through a symlink — refused so a write/delete\n` +
                `    cannot escape the owned namespace; --accept-modified will NOT override it.\n` +
                `    Replace the symlink with a real directory/file.\n`,
            );
          }
        } else {
          process.stderr.write(
            `${m.adapter.done(agentName)} Manifest: ${result.manifestPath}\n`,
          );
          // Human-only hint for the one advisory adapter upgrade intentionally
          // cannot fix: model_map pins may be deliberate, so upgrade never
          // rewrites them and a MODEL_MAP_STALE advisory survives a --write.
          // Emitted on a successful --write with no refused files (the rationale
          // and contract live in docs/cli-contract.md and the tests). Withheld
          // when files were refused — there --accept-modified is the next step,
          // which the hint's "re-run --write" would contradict. Best-effort: a
          // profile read failure must not fail the already-successful write.
          //
          // Gated on claude-code (the only catalog-backed agent) so non-claude
          // upgrades never touch the profile at all — no read, no failure path.
          if (agentName === "claude-code") {
            try {
              const { profileRel, drift } = await detectAgentModelMapDrift(
                process.cwd(),
                agentName,
              );
              if (drift.length > 0) {
                process.stderr.write(
                  `Remaining manual advisory: MODEL_MAP_STALE (${drift.length})\n`,
                );
                for (const d of drift) {
                  process.stderr.write(
                    `  model_map.${d.tier} is pinned to "${d.current}"; current catalog default is "${d.expected}".\n`,
                  );
                }
                process.stderr.write(
                  `adapter upgrade does not change model_map pins.\n` +
                    `To follow the default:\n` +
                    `  1. Edit .code-pact/${profileRel}\n` +
                    `  2. Re-run: code-pact adapter upgrade ${agentName} --write\n` +
                    `Keep the pin if intentional, or silence in .code-pact/doctor.yaml:\n` +
                    `  disabled_checks: [MODEL_MAP_STALE]\n`,
                );
              }
            } catch {
              // Ignore — the write succeeded; the hint is a best-effort nicety.
            }
          }
        }
      }
    }

    // Exit codes:
    //   --check: 0 clean / 1 drift
    //   --write: 0 ok / 1 if anything was refused
    if (mode === "check") {
      return result.clean ? 0 : 1;
    }
    const hasRefused = result.plan.some(p => p.action === "refuse");
    return hasRefused ? 1 : 0;
  } catch (err: unknown) {
    if (err instanceof Error) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "AGENT_NOT_FOUND") {
        const msg = m.adapter.agentNotFound(agentName);
        emitError(json, "AGENT_NOT_FOUND", msg);
        return 2;
      }
      if (code === "MANIFEST_NOT_FOUND") {
        emitError(json, "MANIFEST_NOT_FOUND", err.message);
        return 2;
      }
      if (code === "ADAPTER_MANIFEST_INVALID") {
        // A `.code-pact/adapters` symlink escape OR a malformed/schema-invalid
        // manifest (both fail-closed in manifest I/O).
        emitError(json, "ADAPTER_MANIFEST_INVALID", err.message);
        return 2;
      }
      if (code === "PATH_OUTSIDE_PROJECT") {
        // A symlinked placeholder dir (.context / .claude) or generated-file
        // ancestor escaping the project — fail-closed in resolveWithinProject.
        emitError(json, "CONFIG_ERROR", err.message);
        return 2;
      }
      if (code === "CONFIG_ERROR") {
        emitError(json, "CONFIG_ERROR", err.message);
        return 2;
      }
    }
    throw err;
  }
}

async function runAdapterInstallAndEmit(args: {
  agentName: string;
  force: boolean;
  locale: Locale;
  modelVersion: string | undefined;
  regenSkills: boolean;
  json: boolean;
  m: (typeof messages)[Locale];
}): Promise<number> {
  const { agentName, force, locale, modelVersion, regenSkills, json, m } = args;
  const cwd = process.cwd();

  try {
    const result = await runAdapterInstall({
      cwd,
      agentName,
      force,
      locale,
      modelVersion,
      regenSkills,
    });

    if (json) {
      emitOk(result);
    } else {
      for (const f of result.created)
        process.stderr.write(`  created   ${f}\n`);
      for (const f of result.adopted)
        process.stderr.write(`  adopted   ${f}\n`);
      for (const f of result.skipped)
        process.stderr.write(`  skipped   ${f} (already exists)\n`);
      for (const f of result.preserved)
        process.stderr.write(
          `  preserved ${f} (existing dynamic file — not read or hashed)\n`,
        );
      for (const f of result.refused)
        process.stderr.write(`  refused   ${f}\n`);
      process.stderr.write(`  manifest  ${result.manifestPath}\n`);
      process.stderr.write(`${m.adapter.done(agentName)}\n`);
      if (result.refused.length > 0) {
        // Remediation depends on WHY each file was refused — `--accept-modified`
        // only resolves a genuine local edit (managed_modified); the security
        // refusals (a generated path outside the trusted owned set, or one that
        // reaches its real target through a symlink) are NOT overridable by it.
        const reasons = new Set(
          result.files.filter(f => f.action === "refuse").map(f => f.reason),
        );
        process.stderr.write(
          `${result.refused.length} file(s) were NOT overwritten. Review them.\n`,
        );
        if (reasons.has("managed_modified")) {
          process.stderr.write(
            `  - local edits (differ from BOTH manifest and generator): to regenerate, run\n` +
              `      code-pact adapter upgrade ${agentName} --write --accept-modified\n`,
          );
        }
        if (reasons.has("unowned_generated_path")) {
          process.stderr.write(
            `  - a generated path OUTSIDE this adapter's owned set (e.g. a profile field or\n` +
              `    manifest entry pointing at a non-adapter file). NOT auto-overwritten and\n` +
              `    --accept-modified will NOT override it — inspect/remove it by hand.\n`,
          );
        }
        if (reasons.has("symlink_traversal")) {
          process.stderr.write(
            `  - a path that reaches its real target through a SYMLINK. Refused so a write\n` +
              `    cannot escape the owned namespace; --accept-modified will NOT override it —\n` +
              `    replace the symlink with a real directory/file.\n`,
          );
        }
      }
    }
    // A refused file is a divergence the operator must review, so install does
    // not report unqualified success — exit 1 (mirrors `adapter upgrade`'s
    // refuse → exit 1). Clean installs still exit 0.
    return result.refused.length > 0 ? 1 : 0;
  } catch (err: unknown) {
    if (err instanceof Error) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "AGENT_NOT_FOUND") {
        const msg = m.adapter.agentNotFound(agentName);
        emitError(json, "AGENT_NOT_FOUND", msg);
        return 2;
      }
      if (code === "ADAPTER_MANIFEST_INVALID") {
        // A `.code-pact/adapters` symlink escape OR a malformed/schema-invalid
        // manifest (both fail-closed in manifest I/O). Surface a structured
        // envelope + exit 2, not an internal error.
        emitError(json, "ADAPTER_MANIFEST_INVALID", err.message);
        return 2;
      }
      if (code === "PATH_OUTSIDE_PROJECT") {
        // A symlinked placeholder dir (.context / .claude) or generated-file
        // ancestor escaping the project — fail-closed in resolveWithinProject.
        emitError(json, "CONFIG_ERROR", err.message);
        return 2;
      }
      if (code === "CONFIG_ERROR") {
        emitError(json, "CONFIG_ERROR", err.message);
        return 2;
      }
    }
    throw err;
  }
}
