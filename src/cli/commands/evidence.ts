import { strictParse, ConfigError } from "../../lib/argv.ts";
import { clusterUsage, emitUsage, hasHelpFlag, isHelpToken, subcommandUsage } from "../usage.ts";
import { toParseOptions } from "../spec/render.ts";
import { EVIDENCE_SPECS, EVIDENCE_SPEC_ORDER } from "../spec/evidence.ts";
import { emitError, emitOk } from "../util.ts";
import type { Locale } from "../../i18n/index.ts";
import {
  renderEvidenceStream,
  runEvidenceShow,
  type EvidenceStream,
} from "../../commands/evidence-show.ts";

const PUBLIC_EVIDENCE_SHOW_CODES = new Set([
  "INVALID_EVIDENCE_REF",
  "EVIDENCE_NOT_FOUND",
  "EVIDENCE_INVALID",
  "EVIDENCE_DIGEST_MISMATCH",
  "CONFIG_ERROR",
]);

export function mapEvidenceShowError(error: unknown): {
  code: string;
  systemCode?: string;
  message: string;
} {
  const systemCode = (error as NodeJS.ErrnoException).code;
  const message = error instanceof Error ? error.message : String(error);
  if (systemCode && PUBLIC_EVIDENCE_SHOW_CODES.has(systemCode)) {
    return { code: systemCode, message };
  }
  if (
    systemCode === "PATH_NOT_OWNED" ||
    systemCode === "PATH_OUTSIDE_PROJECT" ||
    systemCode === "FS_AUTHORITY_FAILURE"
  ) {
    return { code: "EVIDENCE_PATH_UNSAFE", systemCode, message };
  }
  return {
    code: "EVIDENCE_READ_FAILED",
    ...(systemCode ? { systemCode } : {}),
    message,
  };
}

export async function cmdEvidence(
  argv: string[],
  _locale: Locale,
  globalJson: boolean,
): Promise<number> {
  const subcommand = argv[0];
  const rest = argv.slice(1);

  if (subcommand === undefined || isHelpToken(subcommand)) {
    return emitUsage(clusterUsage("evidence"));
  }
  if (hasHelpFlag(rest)) {
    return emitUsage(subcommandUsage("evidence", subcommand));
  }
  if (subcommand === "show") return cmdEvidenceShow(rest, globalJson);

  emitError(
    globalJson,
    "CONFIG_ERROR",
    `evidence: unknown subcommand "${subcommand}". Use: ${EVIDENCE_SPEC_ORDER.join(" | ")}`,
  );
  return 2;
}

async function cmdEvidenceShow(
  argv: string[],
  globalJson: boolean,
): Promise<number> {
  let values: Record<string, unknown>;
  let positionals: string[];
  try {
    ({ values, positionals } = strictParse(
      "evidence show",
      argv,
      toParseOptions(EVIDENCE_SPECS.show),
      { allowPositionals: true },
    ));
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    emitError(globalJson || argv.includes("--json"), "CONFIG_ERROR", error.message);
    return 2;
  }

  const json = globalJson || values.json === true;
  if (positionals.length !== 1) {
    emitError(
      json,
      "CONFIG_ERROR",
      positionals.length === 0
        ? "evidence show requires an evidence ref (e.g. evidence:sha256:<digest>)."
        : "evidence show accepts exactly one evidence ref.",
    );
    return 2;
  }
  const ref = positionals[0]!;

  const streamRaw = (values.stream as string | undefined) ?? "all";
  if (streamRaw !== "all" && streamRaw !== "stdout" && streamRaw !== "stderr") {
    emitError(
      json,
      "CONFIG_ERROR",
      `evidence show: invalid --stream "${streamRaw}" (expected all, stdout, or stderr)`,
    );
    return 2;
  }

  try {
    const result = await runEvidenceShow(process.cwd(), ref);
    if (json) {
      emitOk({
        evidence_ref: result.evidence_ref,
        digest: result.digest,
        stream: streamRaw,
        artifact:
          streamRaw === "all"
            ? result.artifact
            : { [streamRaw]: renderEvidenceStream(result.artifact, streamRaw as EvidenceStream) },
      });
    } else {
      process.stdout.write(renderEvidenceStream(result.artifact, streamRaw as EvidenceStream));
    }
    return 0;
  } catch (error) {
    const mapped = mapEvidenceShowError(error);
    const code = mapped.code;
    const message = mapped.message;
    const exit = code === "INVALID_EVIDENCE_REF" || code === "CONFIG_ERROR" ? 2 : 1;
    emitError(
      json,
      code,
      message,
      mapped.systemCode ? { data: { system_code: mapped.systemCode } } : {},
    );
    return exit;
  }
}
