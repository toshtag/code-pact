import { spawn } from "node:child_process";
import { globToRegex, validateGlobSyntax } from "../glob.ts";

// ---------------------------------------------------------------------------
// Declared-writes audit — v1.6 P15-T1
//
// Compares a task's declared `writes` globs against the actual filesystem
// changes reported by git, producing a read-only advisory envelope. This
// module is the deterministic oracle that `task finalize --json` surfaces
// as `data.write_audit`. It never mutates state and never spawns git when
// `auditWrites` is not called.
//
// Two execution modes:
//   - Default (no `baseRef`): "working-tree" mode. Files touched =
//     staged ∪ unstaged ∪ untracked, all relative to the repo root. This
//     matches an agent's mental model of "what have I changed in this
//     in-flight task" without bleeding in earlier same-branch work.
//   - `baseRef` provided: "merge-base" mode. Additionally includes files
//     differing between `git merge-base HEAD <ref>` and HEAD, giving a
//     branch-level view. On merge-base failure, falls back to working-
//     tree mode and surfaces `base_error`; never throws.
//
// The result envelope is field-presence-fixed — every key is always
// present so consumers do not need defensive parsing. The `reason` /
// `base_error` keys appear only when applicable; everything else is
// always populated (with empty arrays when there is nothing to report).
// ---------------------------------------------------------------------------

export type GitUnavailableReason = "not_a_git_repo" | "git_not_on_path";
export type BaseKind = "working-tree" | "merge-base" | "unavailable";
export type BaseErrorCode = "MERGE_BASE_NOT_FOUND" | "REF_NOT_FOUND";

export type WriteAuditWarning =
  | "TASK_WRITES_AUDIT_OUTSIDE_DECLARED"
  | "TASK_WRITES_AUDIT_DECLARED_UNUSED";

export type WriteAuditBaseError = {
  code: BaseErrorCode;
  message: string;
  requested_ref: string;
};

export type WriteAuditResult = {
  git_available: boolean;
  /** Present only when `git_available === false`. */
  reason?: GitUnavailableReason;
  base_kind: BaseKind;
  base_ref: string | null;
  /** Present only when `--base-ref` was requested but merge-base failed. */
  base_error?: WriteAuditBaseError;
  files_touched: string[];
  outside_declared: string[];
  declared_unused: string[];
  warnings: WriteAuditWarning[];
};

export type AuditWritesOptions = {
  cwd: string;
  declaredWrites: readonly string[];
  /** Optional branch base ref. When provided, opts into merge-base mode. */
  baseRef?: string;
};

type GitRun = { ok: true; stdout: string } | { ok: false; reason: "spawn" | "exit" };

function runGit(cwd: string, args: readonly string[]): Promise<GitRun> {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn("git", ["-c", "core.quotePath=false", ...args], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      resolve({ ok: false, reason: "spawn" });
      return;
    }
    let stdout = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    proc.stderr?.on("data", () => {
      /* discard — diagnostics travel via exit code */
    });
    proc.on("error", () => {
      resolve({ ok: false, reason: "spawn" });
    });
    proc.on("close", (code) => {
      if (code === 0) resolve({ ok: true, stdout });
      else resolve({ ok: false, reason: "exit" });
    });
  });
}

function toPosix(p: string): string {
  return p.split(/[\\/]/).join("/");
}

function parseLines(out: string): string[] {
  return out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function unavailableShape(reason: GitUnavailableReason): WriteAuditResult {
  return {
    git_available: false,
    reason,
    base_kind: "unavailable",
    base_ref: null,
    files_touched: [],
    outside_declared: [],
    declared_unused: [],
    warnings: [],
  };
}

/**
 * Audits the task's declared `writes` against the actual filesystem
 * changes reported by git.
 *
 * Always returns a well-formed `WriteAuditResult` — never throws. When
 * git is unavailable (not on PATH, or `cwd` is not a git repo), returns
 * the canonical unavailable shape. When `baseRef` resolution fails,
 * gracefully falls back to working-tree mode and populates `base_error`.
 *
 * Exit code semantics are owned entirely by the caller — this function
 * is advisory only.
 */
export async function auditWrites(
  opts: AuditWritesOptions,
): Promise<WriteAuditResult> {
  const { cwd, declaredWrites, baseRef } = opts;

  const probe = await runGit(cwd, ["rev-parse", "--git-dir"]);
  if (!probe.ok) {
    return unavailableShape(
      probe.reason === "spawn" ? "git_not_on_path" : "not_a_git_repo",
    );
  }

  const baseError = await resolveBaseError(cwd, baseRef);
  const useBaseRef = baseRef !== undefined && baseError === null;

  const stagedRun = await runGit(cwd, ["diff", "--cached", "--name-only"]);
  const unstagedRun = await runGit(cwd, ["diff", "--name-only"]);
  const untrackedRun = await runGit(cwd, [
    "ls-files",
    "--others",
    "--exclude-standard",
  ]);

  const fileSet = new Set<string>();
  for (const run of [stagedRun, unstagedRun, untrackedRun]) {
    if (run.ok) {
      for (const line of parseLines(run.stdout)) fileSet.add(toPosix(line));
    }
  }

  if (useBaseRef) {
    const mergeBase = await runGit(cwd, ["merge-base", "HEAD", baseRef]);
    if (mergeBase.ok) {
      const baseSha = mergeBase.stdout.trim();
      const branchDiff = await runGit(cwd, [
        "diff",
        "--name-only",
        baseSha,
        "HEAD",
      ]);
      if (branchDiff.ok) {
        for (const line of parseLines(branchDiff.stdout)) fileSet.add(toPosix(line));
      }
    }
  }

  const filesTouched = [...fileSet].sort();

  const validGlobs = declaredWrites.filter(
    (glob) => validateGlobSyntax(glob) === null,
  );
  const compiledGlobs = validGlobs.map((glob) => ({
    glob,
    regex: globToRegex(glob),
  }));

  const outsideDeclared: string[] = [];
  const matchedGlobIdx = new Set<number>();
  for (const file of filesTouched) {
    let matched = false;
    for (let i = 0; i < compiledGlobs.length; i += 1) {
      if (compiledGlobs[i]!.regex.test(file)) {
        matched = true;
        matchedGlobIdx.add(i);
      }
    }
    if (!matched) outsideDeclared.push(file);
  }

  const declaredUnused = compiledGlobs
    .filter((_, idx) => !matchedGlobIdx.has(idx))
    .map((entry) => entry.glob);

  const warnings: WriteAuditWarning[] = [];
  if (outsideDeclared.length > 0) {
    warnings.push("TASK_WRITES_AUDIT_OUTSIDE_DECLARED");
  }
  // v1.6 P15-T4: declared_unused gets promoted from data-only to a
  // warning. The signal is: "you said you'd write this glob and the
  // current diff doesn't touch it" — usually means the declaration is
  // stale, the task was partially split, or the planning artifact
  // drifted from reality. Stays advisory (warning, never exit-relevant
  // in P15 — `--audit-strict` in P15-T6 opts into enforcement).
  if (declaredUnused.length > 0) {
    warnings.push("TASK_WRITES_AUDIT_DECLARED_UNUSED");
  }

  const baseKind: BaseKind = useBaseRef ? "merge-base" : "working-tree";
  const result: WriteAuditResult = {
    git_available: true,
    base_kind: baseKind,
    base_ref: useBaseRef ? baseRef! : null,
    files_touched: filesTouched,
    outside_declared: outsideDeclared,
    declared_unused: declaredUnused,
    warnings,
  };
  if (baseError !== null) result.base_error = baseError;
  return result;
}

async function resolveBaseError(
  cwd: string,
  baseRef: string | undefined,
): Promise<WriteAuditBaseError | null> {
  if (baseRef === undefined) return null;

  const refCheck = await runGit(cwd, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${baseRef}^{commit}`,
  ]);
  if (!refCheck.ok) {
    return {
      code: "REF_NOT_FOUND",
      message: `git rev-parse ${baseRef}: ref not found`,
      requested_ref: baseRef,
    };
  }

  const mergeBase = await runGit(cwd, ["merge-base", "HEAD", baseRef]);
  if (!mergeBase.ok) {
    return {
      code: "MERGE_BASE_NOT_FOUND",
      message: `git merge-base HEAD ${baseRef}: no common ancestor`,
      requested_ref: baseRef,
    };
  }
  return null;
}
