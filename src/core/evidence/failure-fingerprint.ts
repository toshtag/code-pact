import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { CommandExecutionResult } from "../../commands/verify.ts";
import { canonicalJson } from "./canonical-json.ts";
import {
  excerptText,
  STDERR_EXCERPT_LIMITS,
  STDOUT_EXCERPT_LIMITS,
  type OutputExcerpt,
} from "./excerpt.ts";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pathVariants(path: string): string[] {
  const variants = new Set<string>();
  const forward = path.replace(/\\/g, "/");
  const encodedForward = encodeURI(forward);
  if (forward.startsWith("/")) {
    variants.add(`file://${forward}`);
    variants.add(`file://${encodedForward}`);
  } else if (/^[A-Za-z]:\//.test(forward)) {
    variants.add(`file:///${forward}`);
    variants.add(`file:///${encodedForward}`);
    variants.add(`/${forward}`);
    variants.add(`/${encodedForward}`);
  }
  variants.add(path);
  variants.add(forward);
  variants.add(path.replace(/\//g, "\\"));
  return [...variants].filter(value => value.length > 0);
}

function replaceRootVariants(text: string, roots: string[], token: string): string {
  let out = text;
  const leftBoundary = `(^|[\\s"'\\x60\\(\\[\\{=:;,])`;
  for (const root of roots) {
    for (const variant of pathVariants(root)) {
      const flags = /^(?:file:\/\/\/|\/)?[A-Za-z]:/i.test(variant) ? "gi" : "g";
      out = out.replace(
        new RegExp(`${leftBoundary}${escapeRegExp(variant)}([\\\\/])`, flags),
        (_match, prefix: string) => `${prefix}${token}/`,
      );
      out = out.replace(
        new RegExp(
          `${leftBoundary}${escapeRegExp(variant)}(?=$|[\\s"'\\x60\\)\\]\\}:;,])`,
          flags,
        ),
        (_match, prefix: string) => `${prefix}${token}`,
      );
    }
  }
  return out;
}

function normalizeTokenPathSeparators(text: string): string {
  return text.replace(/(<repo>|<tmp>)([\\/][^\s"'`]*)/g, (_match, token: string, path: string) => {
    return `${token}${path.replace(/\\/g, "/")}`;
  });
}

export function normalizeFailureText(text: string, cwd: string): string {
  let out = stripVTControlCharacters(text);
  out = replaceRootVariants(out, [cwd, resolve(cwd)], "<repo>");
  out = replaceRootVariants(out, [tmpdir(), resolve(tmpdir())], "<tmp>");
  out = normalizeTokenPathSeparators(out);
  out = out.replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, "<timestamp>");
  out = out.replace(/\bpid(?:=|:)?\s*\d+\b/gi, "pid=<pid>");
  return out;
}

function excerptFingerprintText(excerpt: OutputExcerpt): string {
  return excerpt.truncated
    ? `${excerpt.head}\n<truncated>\n${excerpt.tail}`
    : excerpt.head;
}

export function fingerprintFailure(
  result: Pick<
    CommandExecutionResult,
    "command" | "exitCode" | "timedOut" | "aborted" | "stdout" | "stderr"
  >,
  cwd: string,
  excerpts?: { stdout: OutputExcerpt; stderr: OutputExcerpt },
): string {
  const stdoutExcerpt =
    excerpts?.stdout ?? excerptText(result.stdout, STDOUT_EXCERPT_LIMITS);
  const stderrExcerpt =
    excerpts?.stderr ?? excerptText(result.stderr, STDERR_EXCERPT_LIMITS);
  const normalized = {
    command: normalizeFailureText(result.command, cwd),
    exit_code: result.exitCode,
    timed_out: result.timedOut,
    aborted: result.aborted,
    stdout: normalizeFailureText(excerptFingerprintText(stdoutExcerpt), cwd),
    stderr: normalizeFailureText(excerptFingerprintText(stderrExcerpt), cwd),
  };
  const digest = createHash("sha256")
    .update(canonicalJson(normalized))
    .digest("hex");
  return `sha256:${digest}`;
}
