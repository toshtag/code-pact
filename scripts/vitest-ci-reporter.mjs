// Minimal CI reporter for Vitest: prints per-test-file progress, failed test
// cases with bounded assertion diagnostics, and a final slowest-files summary.
// Designed to be consumed by scripts that parse `[vitest:*]` lines for
// heartbeat/state reporting, so every failure line keeps the file path as the
// first token after its prefix.

import { relative } from "node:path";
import { inspect } from "node:util";
import process from "node:process";

// Diagnostics must stay small enough that a broken suite cannot flood the CI
// log. Every emitted line is bounded by these limits.
const MAX_ERRORS_PER_CASE = 3;
const MAX_CONTEXT_BYTES = 512;
const MAX_MESSAGE_BYTES = 2048;
const MAX_VALUE_BYTES = 1024;

// Vitest 4 reports the canonical `failed` state; `fail` is the legacy spelling
// kept for older result shapes.
const FAILED_STATES = new Set(["failed", "fail"]);

// ANSI/VT control sequences, including CSI, single-shift, and 8-bit CSI forms.
const CONTROL_SEQUENCE =
  /\u001B\[[0-9;?]*[ -\/]*[@-~]|\u001B[@-Z\\-_]|\u009B[0-9;?]*[ -\/]*[@-~]/g;
const REMAINING_CONTROL = /[\u0000-\u001F\u007F-\u009F]/g;

const INSPECT_OPTIONS = {
  depth: 4,
  maxArrayLength: 20,
  maxStringLength: 1000,
  compact: true,
  breakLength: Infinity,
  sorted: true,
  getters: false,
};

function relPath(moduleId) {
  if (typeof moduleId !== "string" || moduleId.length === 0)
    return String(moduleId);
  const cwd = process.cwd();
  if (moduleId.startsWith(cwd)) {
    const tail = moduleId.slice(cwd.length);
    return tail.startsWith("/") ? tail.slice(1) : tail;
  }
  try {
    return relative(cwd, moduleId);
  } catch {
    return moduleId;
  }
}

function isFailedState(state) {
  return typeof state === "string" && FAILED_STATES.has(state);
}

// Collapse a value onto a single log line: no control sequences, no raw
// newlines, no bare control characters.
function singleLine(text) {
  return String(text)
    .replace(CONTROL_SEQUENCE, "")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(REMAINING_CONTROL, char => {
      if (char === "\t") return "\\t";
      const code = char.codePointAt(0).toString(16).padStart(4, "0");
      return `\\u${code}`;
    });
}

// Truncate on a UTF-8 byte budget without splitting a multibyte character.
function truncateBytes(text, maxBytes) {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const marker = "...";
  const budget = Math.max(0, maxBytes - marker.length);
  let used = 0;
  let out = "";
  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8");
    if (used + size > budget) break;
    out += char;
    used += size;
  }
  return `${out}${marker}`;
}

function bounded(text, maxBytes) {
  return truncateBytes(singleLine(text), maxBytes);
}

// A failing test can carry any object, including one whose accessors throw.
// Diagnostics must never take the reporter down with them.
function safeRead(source, key) {
  try {
    return source?.[key];
  } catch {
    return undefined;
  }
}

function errorMessage(error) {
  const message = safeRead(error, "message");
  if (typeof message === "string") return message;
  try {
    return String(error);
  } catch {
    return "<unprintable error>";
  }
}

function formatValue(value) {
  if (typeof value === "string") return value;
  try {
    return inspect(value, INSPECT_OPTIONS);
  } catch {
    return "<unprintable value>";
  }
}

function hasComparisonValue(error, key) {
  if (typeof error !== "object" || error === null) return false;
  try {
    if (!(key in error)) return false;
  } catch {
    return false;
  }
  return safeRead(error, key) !== undefined;
}

function errorList(errors) {
  return Array.isArray(errors) ? errors : [];
}

function emitOmitted(context, total, shown) {
  const omitted = total - shown;
  if (omitted > 0) {
    console.error(
      `[vitest:truncated] ${context}: ${omitted} additional errors omitted`,
    );
  }
}

// Failed test case: the file stays the first token so failed-file parsers keep
// working, and the full test name follows it.
function emitFailedCase(path, fullName, errors) {
  const context = bounded(`${path} > ${fullName}`, MAX_CONTEXT_BYTES);
  console.error(`[vitest:failed] ${context}`);

  const list = errorList(errors);
  const shown = list.slice(0, MAX_ERRORS_PER_CASE);
  for (const error of shown) {
    console.error(
      `[vitest:assertion] ${context}: ${bounded(errorMessage(error), MAX_MESSAGE_BYTES)}`,
    );
    if (hasComparisonValue(error, "expected")) {
      const expected = formatValue(safeRead(error, "expected"));
      console.error(
        `[vitest:expected] ${context}: ${bounded(expected, MAX_VALUE_BYTES)}`,
      );
    }
    if (hasComparisonValue(error, "actual")) {
      const actual = formatValue(safeRead(error, "actual"));
      console.error(
        `[vitest:actual] ${context}: ${bounded(actual, MAX_VALUE_BYTES)}`,
      );
    }
  }
  emitOmitted(context, list.length, shown.length);
}

// Module-level failure (collection or import): there is no test case to name,
// so the message follows the file directly.
function emitModuleErrors(path, errors) {
  const context = bounded(path, MAX_CONTEXT_BYTES);
  const list = errorList(errors);
  const shown = list.slice(0, MAX_ERRORS_PER_CASE);
  for (const error of shown) {
    console.error(
      `[vitest:failed] ${context}: ${bounded(errorMessage(error), MAX_MESSAGE_BYTES)}`,
    );
  }
  emitOmitted(context, list.length, shown.length);
}

export default class VitestCiReporter {
  constructor() {
    this.files = [];
    this.failedCaseModules = new Set();
  }

  onTestRunStart(specifications) {
    const total = Array.isArray(specifications) ? specifications.length : 0;
    console.log(`[vitest:total] ${total}`);
  }

  onTestModuleStart(testModule) {
    const path = relPath(testModule?.moduleId ?? testModule?.id ?? "");
    console.log(`[vitest:start] ${path}`);
  }

  onTestCaseResult(testCase) {
    const result =
      typeof testCase?.result === "function"
        ? testCase.result()
        : testCase?.result;
    if (!isFailedState(result?.state)) return;

    const path = relPath(
      testCase?.module?.moduleId ?? testCase?.module?.id ?? "",
    );
    const fullName = testCase?.fullName ?? testCase?.name ?? "<unknown test>";
    this.failedCaseModules.add(path);
    emitFailedCase(path, fullName, result?.errors);
  }

  onTestModuleEnd(testModule) {
    const path = relPath(testModule?.moduleId ?? testModule?.id ?? "");
    const state =
      typeof testModule?.state === "function"
        ? testModule.state()
        : (testModule?.result?.state ?? "unknown");
    let duration = 0;
    if (typeof testModule?.diagnostic === "function") {
      const diag = testModule.diagnostic();
      duration = diag?.duration ?? 0;
    } else if (typeof testModule?.result?.duration === "number") {
      duration = testModule.result.duration;
    }
    console.log(`[vitest:done] ${path} ${duration}ms ${state}`);
    this.files.push({ path, duration, state });

    if (!isFailedState(state)) return;

    const moduleErrors =
      typeof testModule?.errors === "function"
        ? testModule.errors()
        : testModule?.result?.errors;
    const errors = errorList(moduleErrors);
    if (errors.length > 0) {
      emitModuleErrors(path, errors);
      return;
    }
    // Only a failed module that reported neither a failed case nor a module
    // error needs the bare fallback.
    if (!this.failedCaseModules.has(path)) {
      console.error(`[vitest:failed] ${path}`);
    }
  }

  onTestRunEnd(testModules, unhandledErrors, reason) {
    if (Array.isArray(testModules)) {
      for (const m of testModules) {
        const path = relPath(m?.moduleId ?? m?.id ?? "");
        const state =
          typeof m?.state === "function"
            ? m.state()
            : (m?.result?.state ?? "unknown");
        let duration = 0;
        if (typeof m?.diagnostic === "function") {
          duration = m.diagnostic().duration ?? 0;
        } else if (typeof m?.result?.duration === "number") {
          duration = m.result.duration;
        }
        if (!this.files.some(f => f.path === path)) {
          this.files.push({ path, duration, state });
        }
      }
    }

    if (Array.isArray(unhandledErrors) && unhandledErrors.length > 0) {
      console.log("[vitest:unhandled] unhandled errors during run");
    }
    if (reason && reason !== "passed") {
      console.log(`[vitest:reason] ${reason}`);
    }

    const slowest = [...this.files]
      .filter(f => f.duration >= 0)
      .sort((a, b) => b.duration - a.duration)
      .slice(0, 10);

    console.log("\nSlowest test files:");
    for (let i = 0; i < slowest.length; i++) {
      const f = slowest[i];
      const sec = (f.duration / 1000).toFixed(1);
      console.log(`${i + 1}. ${f.path} ${sec}s`);
    }
  }
}
