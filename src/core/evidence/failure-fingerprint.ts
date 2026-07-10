import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { CommandExecutionResult } from "../../commands/verify.ts";
import { canonicalJson } from "./canonical-json.ts";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeFailureText(text: string, cwd: string): string {
  let out = text;
  const repo = resolve(cwd);
  out = out.replace(new RegExp(escapeRegExp(repo), "g"), "<repo>");
  out = out.replace(new RegExp(escapeRegExp(tmpdir()), "g"), "<tmp>");
  out = out.replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, "<timestamp>");
  out = out.replace(/\b\d+(?:\.\d+)?\s?(?:ms|s|sec|seconds)\b/gi, "<duration>");
  out = out.replace(/\bpid(?:=|:)?\s*\d+\b/gi, "pid=<pid>");
  return out.replace(/\\/g, "/");
}

export function fingerprintFailure(
  result: Pick<
    CommandExecutionResult,
    "command" | "exitCode" | "timedOut" | "aborted" | "stdout" | "stderr"
  >,
  cwd: string,
): string {
  const normalized = {
    command: result.command,
    exit_code: result.exitCode,
    timed_out: result.timedOut,
    aborted: result.aborted,
    stdout: normalizeFailureText(result.stdout, cwd),
    stderr: normalizeFailureText(result.stderr, cwd),
  };
  const digest = createHash("sha256")
    .update(canonicalJson(normalized))
    .digest("hex");
  return `sha256:${digest}`;
}
