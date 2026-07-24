// Bounded child-process execution with process-tree termination and
// stdout/stderr size limits.

import { spawn } from "node:child_process";
import { platform } from "node:process";

/**
 * @typedef {Object} RunBoundedProcessOptions
 * @property {string} command
 * @property {string[]} [args=[]]
 * @property {string} [cwd]
 * @property {NodeJS.ProcessEnv} [env]
 * @property {number} [timeoutMs=120_000]
 * @property {number} [termGraceMs=5_000]
 * @property {number} [maxOutputBytes=1_048_576]
 * @property {number} [heartbeatIntervalMs=0] 0 disables periodic progress ticks
 * @property {(snapshot: RunBoundedProcessResult & {elapsedMs: number}) => void} [onProgress] called on output chunks and heartbeat ticks
 */

/**
 * @typedef {Object} RunBoundedProcessResult
 * @property {boolean} ok
 * @property {number|null} exitCode
 * @property {boolean} timedOut
 * @property {string|null} signal
 * @property {number|null} pid
 * @property {string} stdout
 * @property {string} stderr
 * @property {number} elapsedMs
 */

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_TERM_GRACE_MS = 5_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1 * 1024 * 1024;

function trimOutput(text, maxBytes) {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return text;
  return buffer.subarray(0, maxBytes).toString("utf8");
}

function isTimeoutError(err) {
  if (!err) return false;
  if (err.name === "TimeoutError") return true;
  if (err.code === "ABORT_ERR") return true;
  if (err.message && /timeout/i.test(err.message)) return true;
  return false;
}

/**
 * Run `command` with `args` in a bounded way.
 *
 * - `shell: false` / argv-based
 * - `timeoutMs` hard cap on total runtime
 * - On timeout: SIGTERM the process group, then SIGKILL after `termGraceMs`
 * - `maxOutputBytes` cap on each of stdout and stderr
 * - Always clears timers and kills the process group on abnormal exit
 *
 * @param {RunBoundedProcessOptions} opts
 * @returns {Promise<RunBoundedProcessResult>}
 */
export async function runBoundedProcess(opts) {
  const command = opts.command;
  const args = opts.args ?? [];
  const cwd = opts.cwd;
  const env = opts.env ? { ...process.env, ...opts.env } : process.env;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const termGraceMs = opts.termGraceMs ?? DEFAULT_TERM_GRACE_MS;
  const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const heartbeatIntervalMs = opts.heartbeatIntervalMs ?? 0;
  const onProgress = opts.onProgress;

  const start = Date.now();
  /** @type {RunBoundedProcessResult} */
  const result = {
    ok: false,
    exitCode: null,
    timedOut: false,
    signal: null,
    pid: null,
    stdout: "",
    stderr: "",
    elapsedMs: 0,
  };

  return new Promise(resolve => {
    /** @type {import("node:child_process").ChildProcess | null} */
    let child = null;
    let timeoutId = null;
    let graceId = null;
    let heartbeatId = null;
    let resolved = false;
    let outputExceeded = false;

    function emitProgress() {
      if (onProgress) {
        result.elapsedMs = Date.now() - start;
        onProgress(result);
      }
    }

    function finish() {
      if (resolved) return;
      resolved = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (graceId) {
        clearTimeout(graceId);
        graceId = null;
      }
      if (heartbeatId) {
        clearInterval(heartbeatId);
        heartbeatId = null;
      }
      result.elapsedMs = Date.now() - start;
      if (outputExceeded) {
        result.stderr += "\n[runBoundedProcess: max output exceeded]";
        result.ok = false;
      } else if (result.timedOut) {
        result.ok = false;
      } else if (result.exitCode === 0 && result.signal === null) {
        result.ok = true;
      } else {
        result.ok = false;
      }
      resolve(result);
    }

    function killTree(signal = "SIGTERM") {
      if (!child || child.pid === undefined) return;
      try {
        if (platform === "win32") {
          const force = signal === "SIGKILL" ? ["/F"] : [];
          spawn("taskkill", ["/PID", String(child.pid), "/T", ...force], {
            windowsHide: true,
            detached: true,
          });
        } else {
          process.kill(-child.pid, signal);
        }
      } catch (err) {
        // Process may have already exited (ESRCH) or the signal may have
        // already been delivered. Either is acceptable; surface only unexpected
        // failures.
        if (
          err.code !== "ESRCH" &&
          err.code !== "EPERM" &&
          !isTimeoutError(err)
        ) {
          // eslint-disable-next-line no-console
          console.error("runBoundedProcess killTree failed:", err);
        }
      }
    }

    function onTimeout() {
      timeoutId = null;
      result.timedOut = true;
      killTree("SIGTERM");
      if (termGraceMs > 0) {
        graceId = setTimeout(() => {
          graceId = null;
          killTree("SIGKILL");
        }, termGraceMs);
      }
    }

    function appendChunk(target, chunk) {
      const current = target + chunk;
      const currentBytes = Buffer.byteLength(current, "utf8");
      if (currentBytes > maxOutputBytes) {
        outputExceeded = true;
        return (
          target +
          trimOutput(chunk, maxOutputBytes - Buffer.byteLength(target, "utf8"))
        );
      }
      return current;
    }

    child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    result.pid = child.pid ?? null;

    if (child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", chunk => {
        result.stdout = appendChunk(result.stdout, chunk);
        emitProgress();
        if (outputExceeded) killTree("SIGKILL");
      });
    }

    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", chunk => {
        result.stderr = appendChunk(result.stderr, chunk);
        emitProgress();
        if (outputExceeded) killTree("SIGKILL");
      });
    }

    child.on("error", err => {
      result.stderr = String(err.message ?? err);
      finish();
    });

    child.on("exit", (code, signal) => {
      result.exitCode = code ?? null;
      result.signal = signal ?? null;
      if (result.timedOut && result.signal === null) {
        result.signal = termGraceMs > 0 ? "SIGTERM" : "SIGKILL";
      }
      killTree("SIGKILL");
      finish();
    });

    timeoutId = setTimeout(onTimeout, timeoutMs);
    if (heartbeatIntervalMs > 0) {
      heartbeatId = setInterval(emitProgress, heartbeatIntervalMs);
    }
  });
}
