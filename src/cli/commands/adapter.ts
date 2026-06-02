// P27-T2: extracted from src/cli.ts. The CLI wrapper layer for the
// `adapter` subcommand cluster. Routes `adapter <subcommand>` to the
// per-subcommand handlers defined below. JSON envelopes, exit codes,
// error codes, and flag surfaces are byte-identical to v1.13.
//
// `cmdAdapter` is the cluster-entry dispatch and is the only export.
// The per-subcommand handlers (cmdAdapterList, cmdAdapterInstall,
// etc.) plus the `runAdapterInstallAndEmit` helper (shared between
// `cmdAdapterInstall` and `cmdAdapterBareForm`) are private to this
// module.

import { parseArgs } from "node:util";
import { messages, type Locale } from "../../i18n/index.ts";
import { clusterUsage, emitUsage, hasHelpFlag, isHelpToken, subcommandUsage } from "../usage.ts";
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

export async function cmdAdapter(argv: string[], locale: Locale, globalJson: boolean): Promise<number> {
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

  const KNOWN_SUBCOMMANDS = new Set(["list", "install", "upgrade", "doctor", "conformance"]);
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
    if (effectiveJson) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: { code: "CONFIG_ERROR", message: msg } })}\n`,
      );
    } else {
      process.stderr.write(`${msg}\n`);
    }
    return 2;
  }

  // Bare `code-pact adapter` (no subcommand, or flag-only like `--agent X`).
  // The deprecated implicit-install bare form is removed: a warning that also
  // mutates the project is exactly the "warning + side effect" hazard this
  // hardening pass is closing. Require the explicit subcommand. No side effects.
  const msg =
    "adapter requires a subcommand — the bare form is removed. Use: code-pact adapter install <agent> (or list | upgrade | doctor | conformance). Run \"code-pact adapter --help\".";
  if (effectiveJson) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: { code: "CONFIG_ERROR", message: msg } })}\n`,
    );
  } else {
    process.stderr.write(`${msg}\n`);
  }
  return 2;
}

async function cmdAdapterList(argv: string[], globalJson: boolean): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { json: { type: "boolean" } },
    strict: false,
    allowPositionals: false,
  });
  const json = globalJson || values.json === true;
  const result = await runAdapterList({ cwd: process.cwd() });

  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: true, data: result })}\n`);
    return 0;
  }

  for (const a of result.agents) {
    const flags = [
      a.enabled ? "enabled" : "disabled",
      a.experimental ? "experimental" : null,
      a.manifestPresent ? `manifest (${a.fileCount ?? 0} files)` : "no manifest",
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
    const msg = "adapter install requires an <agent> argument (e.g. claude-code).";
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: { code: "CONFIG_ERROR", message: msg } })}\n`,
      );
    } else {
      process.stderr.write(`${msg}\n`);
    }
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
      process.stdout.write(`${JSON.stringify({ ok: true, data: result })}\n`);
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
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === "AGENT_NOT_FOUND") {
      const msg = messages[locale].adapter.agentNotFound(agentName ?? "");
      if (json) {
        process.stdout.write(
          `${JSON.stringify({ ok: false, error: { code: "AGENT_NOT_FOUND", message: msg } })}\n`,
        );
      } else {
        process.stderr.write(`${msg}\n`);
      }
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
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: { code: "CONFIG_ERROR", message: msg } })}\n`,
      );
    } else {
      process.stderr.write(`${msg}\n`);
    }
    return 2;
  }

  if (!isSupportedAgent(agentName)) {
    const msg = `Agent "${agentName}" is not a supported adapter.`;
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: { code: "AGENT_NOT_FOUND", message: msg } })}\n`,
      );
    } else {
      process.stderr.write(`${msg}\n`);
    }
    return 2;
  }

  const cwd = process.cwd();
  const result = await runAdapterConformance({ cwd, agentName });

  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: true, data: result })}\n`);
  } else {
    process.stdout.write(`Agent:     ${result.agent}\n`);
    process.stdout.write(
      `Compliant: ${result.compliant ? "yes" : "NO"}\n`,
    );
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
    const msg = "adapter upgrade requires an <agent> argument (e.g. claude-code).";
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: { code: "CONFIG_ERROR", message: msg } })}\n`,
      );
    } else {
      process.stderr.write(`${msg}\n`);
    }
    return 2;
  }

  if (check === write) {
    // Both true or both false → require explicit choice.
    const msg = check
      ? "adapter upgrade: --check and --write are mutually exclusive."
      : "adapter upgrade requires either --check or --write.";
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: { code: "CONFIG_ERROR", message: msg } })}\n`,
      );
    } else {
      process.stderr.write(`${msg}\n`);
    }
    return 2;
  }

  // `--model` persists the pin to the agent profile — a write. `--check` is
  // contractually read-only, so the combination is incoherent: reject it
  // rather than silently ignore or silently mutate.
  if (check && modelVersion !== undefined) {
    const msg =
      "adapter upgrade: --model cannot be combined with --check (--model pins the profile, which --check must not do). Use --write to pin a model.";
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: { code: "CONFIG_ERROR", message: msg } })}\n`,
      );
    } else {
      process.stderr.write(`${msg}\n`);
    }
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
      process.stdout.write(`${JSON.stringify({ ok: true, data: result })}\n`);
    } else {
      for (const entry of result.plan) {
        if (entry.action === "skip") continue;
        process.stderr.write(
          `  ${entry.action.padEnd(18)} ${entry.relPath} [${entry.local} × ${entry.desired}]\n`,
        );
      }
      if (mode === "check") {
        if (result.clean) {
          process.stderr.write("Clean — no upgrade actions needed.\n");
        } else {
          process.stderr.write(`Drift detected — run "code-pact adapter upgrade ${agentName} --write" to apply.\n`);
        }
      } else {
        const refused = result.plan.filter((p) => p.action === "refuse").length;
        if (refused > 0) {
          process.stderr.write(
            `${refused} file(s) refused — re-run with --accept-modified to overwrite local changes.\n`,
          );
        } else {
          process.stderr.write(`${m.adapter.done(agentName)} Manifest: ${result.manifestPath}\n`);
        }
        // Remaining-advisory hint (human-only). `adapter upgrade` repairs
        // generator/desired drift but deliberately never rewrites model_map (a
        // pin may be intentional), so a MODEL_MAP_STALE advisory survives a
        // --write. Surfacing it here closes the "I upgraded — why is one
        // advisory still there?" gap without turning upgrade into a doctor
        // runner: it is scoped to claude-code's model_map and never advises
        // --model (which re-pins model_version, not model_map). Best-effort —
        // a profile read failure must not fail an already-successful write.
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
              `adapter upgrade does not change model_map pins. To follow the default, edit .code-pact/${profileRel} and re-run "code-pact adapter upgrade ${agentName} --write". Keep it if the pin is intentional, or silence via .code-pact/doctor.yaml (disabled_checks: [MODEL_MAP_STALE]).\n`,
            );
          }
        } catch {
          // Ignore — the write succeeded; the hint is a best-effort nicety.
        }
      }
    }

    // Exit codes:
    //   --check: 0 clean / 1 drift
    //   --write: 0 ok / 1 if anything was refused
    if (mode === "check") {
      return result.clean ? 0 : 1;
    }
    const hasRefused = result.plan.some((p) => p.action === "refuse");
    return hasRefused ? 1 : 0;
  } catch (err: unknown) {
    if (err instanceof Error) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "AGENT_NOT_FOUND") {
        const msg = m.adapter.agentNotFound(agentName);
        if (json) {
          process.stdout.write(
            `${JSON.stringify({ ok: false, error: { code: "AGENT_NOT_FOUND", message: msg } })}\n`,
          );
        } else {
          process.stderr.write(`${msg}\n`);
        }
        return 2;
      }
      if (code === "MANIFEST_NOT_FOUND") {
        if (json) {
          process.stdout.write(
            `${JSON.stringify({ ok: false, error: { code: "MANIFEST_NOT_FOUND", message: err.message } })}\n`,
          );
        } else {
          process.stderr.write(`${err.message}\n`);
        }
        return 2;
      }
      if (code === "CONFIG_ERROR") {
        if (json) {
          process.stdout.write(
            `${JSON.stringify({ ok: false, error: { code: "CONFIG_ERROR", message: err.message } })}\n`,
          );
        } else {
          process.stderr.write(`${err.message}\n`);
        }
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
      process.stdout.write(`${JSON.stringify({ ok: true, data: result })}\n`);
    } else {
      for (const f of result.created) process.stderr.write(`  created   ${f}\n`);
      for (const f of result.adopted) process.stderr.write(`  adopted   ${f}\n`);
      for (const f of result.skipped)
        process.stderr.write(`  skipped   ${f} (already exists)\n`);
      process.stderr.write(`  manifest  ${result.manifestPath}\n`);
      process.stderr.write(`${m.adapter.done(agentName)}\n`);
    }
    return 0;
  } catch (err: unknown) {
    if (err instanceof Error) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "AGENT_NOT_FOUND") {
        const msg = m.adapter.agentNotFound(agentName);
        if (json) {
          process.stdout.write(
            `${JSON.stringify({ ok: false, error: { code: "AGENT_NOT_FOUND", message: msg } })}\n`,
          );
        } else {
          process.stderr.write(`${msg}\n`);
        }
        return 2;
      }
      if (code === "CONFIG_ERROR") {
        if (json) {
          process.stdout.write(
            `${JSON.stringify({ ok: false, error: { code: "CONFIG_ERROR", message: err.message } })}\n`,
          );
        } else {
          process.stderr.write(`${err.message}\n`);
        }
        return 2;
      }
    }
    throw err;
  }
}
