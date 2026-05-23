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
import { isSupportedAgent } from "../../core/agents.ts";
import {
  runAdapterInstall,
  runAdapterList,
  runAdapterDoctor,
  runAdapterUpgrade,
} from "../../commands/adapter.ts";
import { runAdapterConformance } from "../../commands/adapter-conformance.ts";

// ---------------------------------------------------------------------------
// Command: adapter
// ---------------------------------------------------------------------------

export async function cmdAdapter(argv: string[], locale: Locale, globalJson: boolean): Promise<number> {
  const sub = argv[0];

  if (sub === "list") return cmdAdapterList(argv.slice(1), globalJson);
  if (sub === "install") return cmdAdapterInstall(argv.slice(1), locale, globalJson);
  if (sub === "doctor") return cmdAdapterDoctor(argv.slice(1), locale, globalJson);
  if (sub === "upgrade") return cmdAdapterUpgrade(argv.slice(1), locale, globalJson);
  if (sub === "conformance") return cmdAdapterConformance(argv.slice(1), globalJson);

  // Effective --json honors both the global flag (before the command) and
  // a --json embedded in the subcommand args (after the command).
  const effectiveJson = globalJson || argv.includes("--json");

  // Reject other unknown sub-words (anything that doesn't start with `-`).
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

  // Bare-form back-compat: `code-pact adapter [--agent X] ...` routes to
  // install with a deprecation notice on stderr (suppressed under --json
  // so agents consuming the JSON envelope are not surprised by an extra
  // stderr line). Removal is scheduled for v0.10.
  return cmdAdapterBareForm(argv, locale, globalJson);
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
    deprecated: false,
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
      const status = c.status === "pass" ? "PASS" : "FAIL";
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
    }
    throw err;
  }
}

async function cmdAdapterBareForm(
  argv: string[],
  locale: Locale,
  globalJson: boolean,
): Promise<number> {
  const m = messages[locale];
  const { values } = parseArgs({
    args: argv,
    options: {
      agent: { type: "string" },
      force: { type: "boolean" },
      json: { type: "boolean" },
      model: { type: "string" },
      "regen-skills": { type: "boolean" },
    },
    strict: false,
    allowPositionals: false,
  });

  const json = globalJson || values.json === true;
  const agentName = (values.agent as string | undefined) ?? "claude-code";
  const force = values.force === true;
  const modelVersion = values.model as string | undefined;
  const regenSkills = values["regen-skills"] === true;

  if (!json) {
    process.stderr.write(
      `[deprecated] bare 'code-pact adapter' is deprecated; use 'code-pact adapter install ${agentName}'. The bare form will be removed in v1.1.\n`,
    );
  }

  return runAdapterInstallAndEmit({
    agentName,
    force,
    locale,
    modelVersion,
    regenSkills,
    json,
    m,
    deprecated: true,
  });
}

async function runAdapterInstallAndEmit(args: {
  agentName: string;
  force: boolean;
  locale: Locale;
  modelVersion: string | undefined;
  regenSkills: boolean;
  json: boolean;
  m: (typeof messages)[Locale];
  deprecated: boolean;
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
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === "AGENT_NOT_FOUND") {
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
    throw err;
  }
}
