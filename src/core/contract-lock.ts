import { createHash } from "node:crypto";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import type { Task } from "./schemas/task.ts";
import type { Phase } from "./schemas/phase.ts";
import { loadPhase } from "./plan/load-phase.ts";
import { resolveTaskInRoadmap } from "./plan/resolve-task.ts";
import { loadProgressLog } from "./progress/io.ts";
import { deriveTaskState } from "./progress/task-state.ts";
import { canonicalJson } from "./content-addressed-store/canonical-json.ts";
import {
  taskRegistrationDigest,
  canonicalTaskRegistration,
  postLockRegistrationChangedFields,
  parseTaskRegistrationSpec,
} from "./task-registration-spec.ts";
import {
  readOwnedText,
  readExplicitUserText,
  mkdirOwned,
  writeOwnedText,
  resolveContractLockDirWritePath,
  resolveContractLockReadPath,
  resolveContractLockWritePath,
  resolveExplicitUserReadPath,
} from "./project-fs/index.ts";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Contract lock schema
//
// A contract lock is an immutable, committed record of the task declaration
// at planning/start time. It stores a canonical digest of the contract so
// every later mutating verb can detect drift with a deterministic comparison.
// ---------------------------------------------------------------------------

const Contract = z.object({
  description: z.string().nullable(),
  reads: z.array(z.string()),
  writes: z.array(z.string()),
  depends_on: z.array(z.string()),
  decision_refs: z.array(z.string()),
  acceptance_refs: z.array(z.string()),
  definition_of_done: z.array(z.string()),
  verification_commands: z.array(z.string()),
  base_sha: z.string(),
  phase_blob_sha: z.string(),
});

type Contract = z.infer<typeof Contract>;

export const ContractLockRegistration = z.object({
  mode: z.literal("spec_file"),
  spec_digest: z.string(),
  /** Project-relative spec file path stored at lock time for spec-file drift checks. */
  spec_path: z.string().optional(),
  /** Canonical registration JSON stored at lock time for field-level drift. */
  spec_canonical: z.string().optional(),
});

export type ContractLockRegistration = z.infer<typeof ContractLockRegistration>;

export const ContractLock = z.object({
  schema_version: z.literal(1),
  task_id: z.string(),
  phase_id: z.string(),
  phase_path: z.string(),
  base_ref: z.string(),
  base_sha: z.string(),
  phase_blob_sha: z.string(),
  contract_digest: z.string(),
  contract: Contract,
  registration: ContractLockRegistration.optional(),
  at: z.string().datetime(),
  actor: z.enum(["agent", "user"]),
  agent: z.string().optional(),
  author: z.string().optional(),
});

export type ContractLock = z.infer<typeof ContractLock>;

function getContractLockFileName(taskId: string): string {
  // APFS/HFS+ and most filesystems limit a single filename component to 255
  // bytes. Fall back to a deterministic hash for very long task ids so the
  // lock can still be written and read; the lock body still contains the
  // original task_id.
  const file = `${taskId}.yaml`;
  if (Buffer.byteLength(file, "utf8") <= 240) {
    return file;
  }
  return `${createHash("sha256").update(taskId).digest("hex")}.yaml`;
}

export function getContractLockPath(cwd: string, taskId: string): string {
  return join(
    cwd,
    ".code-pact",
    "state",
    "locks",
    getContractLockFileName(taskId),
  );
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

export async function resolveGitRef(cwd: string, ref: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["rev-parse", "--verify", ref],
    { cwd, encoding: "utf8" },
  );
  return stdout.trim();
}

export async function resolvePhaseBlobSha(
  cwd: string,
  phasePath: string,
  ref = "HEAD",
): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["rev-parse", "--verify", `${ref}:${phasePath}`],
    { cwd, encoding: "utf8" },
  );
  return stdout.trim();
}

async function resolveMergeBase(cwd: string, baseRef: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["merge-base", "HEAD", baseRef],
    { cwd, encoding: "utf8" },
  );
  return stdout.trim();
}

async function assertWorktreeClean(cwd: string): Promise<void> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      "git",
      ["status", "--porcelain", "--untracked-files=all"],
      { cwd, encoding: "utf8" },
    ));
  } catch {
    const err = new Error(
      `Cannot lock task contract: working tree is not clean (git unavailable or not a repository).`,
    );
    (err as NodeJS.ErrnoException).code = "WORKTREE_NOT_CLEAN";
    throw err;
  }
  if (stdout.trim().length > 0) {
    const err = new Error(
      `Cannot lock task contract: working tree is not clean.`,
    );
    (err as NodeJS.ErrnoException).code = "WORKTREE_NOT_CLEAN";
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Canonical contract digest
// ---------------------------------------------------------------------------

function sortedCopy<T>(arr: readonly T[] | undefined): T[] {
  return [...(arr ?? [])].sort();
}

export function buildContract(
  task: Task,
  phase: Phase,
  baseSha: string,
  phaseBlobSha: string,
): Contract {
  return {
    description: task.description ?? null,
    reads: sortedCopy(task.reads),
    writes: sortedCopy(task.writes),
    depends_on: sortedCopy(task.depends_on),
    decision_refs: sortedCopy(task.decision_refs),
    acceptance_refs: sortedCopy(task.acceptance_refs),
    definition_of_done: sortedCopy(phase.definition_of_done),
    verification_commands: sortedCopy(phase.verification.commands),
    base_sha: baseSha,
    phase_blob_sha: phaseBlobSha,
  };
}

export function canonicalContract(contract: Contract): string {
  return canonicalJson(contract);
}

export function contractDigest(contract: Contract): string {
  return createHash("sha256")
    .update(Buffer.from(canonicalContract(contract), "utf8"))
    .digest("hex");
}

// ---------------------------------------------------------------------------
// Lock I/O
// ---------------------------------------------------------------------------

export async function readContractLock(
  cwd: string,
  taskId: string,
): Promise<ContractLock | null> {
  try {
    const path = await resolveContractLockReadPath(
      cwd,
      getContractLockFileName(taskId),
    );
    const raw = await readOwnedText(path);
    return ContractLock.parse(parseYaml(raw) as unknown);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function writeContractLock(
  cwd: string,
  lock: ContractLock,
): Promise<void> {
  const dir = await resolveContractLockDirWritePath(cwd);
  await mkdirOwned(dir, { recursive: true });
  const path = await resolveContractLockWritePath(
    cwd,
    getContractLockFileName(lock.task_id),
  );
  await writeOwnedText(path, stringifyYaml(lock));
}

// ---------------------------------------------------------------------------
// Lock creation and drift gate
// ---------------------------------------------------------------------------

export type CreateContractLockOptions = {
  cwd: string;
  taskId: string;
  baseRef?: string;
  agent?: string;
  author?: string;
  actor?: "agent" | "user";
  /** Optional registration proof for spec-file locks. */
  registration?: ContractLockRegistration;
};

export type ContractLockResult = {
  kind: "locked";
  task_id: string;
  phase_id: string;
  phase_path: string;
  base_ref: string;
  base_sha: string;
  phase_blob_sha: string;
  contract_digest: string;
  path: string;
};

export async function createTaskContractLock(
  opts: CreateContractLockOptions,
): Promise<ContractLockResult> {
  const { cwd, taskId } = opts;
  const { phaseId, phasePath } = await resolveTaskInRoadmap(cwd, taskId);
  const phase = await loadPhase(cwd, phasePath);
  const task = phase.tasks?.find(t => t.id === taskId);
  if (!task) {
    const err = new Error(`Task "${taskId}" not found in phase "${phaseId}".`);
    (err as NodeJS.ErrnoException).code = "TASK_NOT_FOUND";
    throw err;
  }

  const { log } = await loadProgressLog(cwd);
  const state = deriveTaskState(log.events, taskId);
  if (state.current === "done") {
    const err = new Error(
      `Task "${taskId}" is already done; cannot lock its contract.`,
    );
    (err as NodeJS.ErrnoException).code = "INVALID_TASK_TRANSITION";
    (err as NodeJS.ErrnoException & { current?: string }).current = "done";
    throw err;
  }

  const existing = await readContractLock(cwd, taskId);
  if (existing !== null) {
    const err = new Error(
      `Task contract lock already exists for "${taskId}" at ${getContractLockPath(cwd, taskId)}. Use a new task id or remove the lock manually.`,
    );
    (err as NodeJS.ErrnoException).code = "TASK_CONTRACT_LOCK_EXISTS";
    throw err;
  }

  await assertWorktreeClean(cwd);

  const baseRef = opts.baseRef ?? "HEAD";
  let baseSha: string;
  try {
    baseSha = await resolveGitRef(cwd, baseRef);
  } catch {
    const err = new Error(
      `Cannot lock task contract: base ref "${baseRef}" could not be resolved.`,
    );
    (err as NodeJS.ErrnoException).code = "CONFIG_ERROR";
    throw err;
  }

  let phaseBlobSha: string;
  try {
    phaseBlobSha = await resolvePhaseBlobSha(cwd, phasePath, baseSha);
  } catch {
    const err = new Error(
      `Cannot lock task contract: phase file "${phasePath}" is not committed at base ref "${baseRef}".`,
    );
    (err as NodeJS.ErrnoException).code = "CONFIG_ERROR";
    throw err;
  }

  const contract = buildContract(task, phase, baseSha, phaseBlobSha);
  const digest = contractDigest(contract);

  const registration = opts.registration
    ? {
        ...opts.registration,
        spec_canonical: canonicalTaskRegistration(phaseId, task),
      }
    : undefined;

  const lock: ContractLock = {
    schema_version: 1,
    task_id: taskId,
    phase_id: phaseId,
    phase_path: phasePath,
    base_ref: baseRef,
    base_sha: baseSha,
    phase_blob_sha: phaseBlobSha,
    contract_digest: digest,
    contract,
    ...(registration ? { registration } : {}),
    at: new Date().toISOString(),
    actor: opts.actor ?? "agent",
    agent: opts.agent,
    author: opts.author,
  };

  await writeContractLock(cwd, lock);

  return {
    kind: "locked",
    task_id: taskId,
    phase_id: phaseId,
    phase_path: phasePath,
    base_ref: baseRef,
    base_sha: baseSha,
    phase_blob_sha: phaseBlobSha,
    contract_digest: digest,
    path: getContractLockPath(cwd, taskId),
  };
}

export type AssertContractResult =
  | { ok: true; lock: ContractLock; changed_fields?: never }
  | { ok: false; lock: null; reason: "missing" }
  | { ok: true; lock: null; reason: "done_without_lock" };

export type AssertTaskContractOptions = {
  cwd: string;
  taskId: string;
  /**
   * When true, a missing lock is always a failure. When false, a missing lock
   * for an already-finalized task is treated as no drift (backward
   * compatibility for tasks completed before the lock mechanism existed).
   */
  requireLock?: boolean;
};

function arraysEqual(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function changedContractFields(locked: Contract, current: Contract): string[] {
  const fields: string[] = [];
  if (locked.description !== current.description) fields.push("description");
  if (!arraysEqual(locked.reads, current.reads)) fields.push("reads");
  if (!arraysEqual(locked.writes, current.writes)) fields.push("writes");
  if (!arraysEqual(locked.depends_on, current.depends_on))
    fields.push("depends_on");
  if (!arraysEqual(locked.decision_refs, current.decision_refs))
    fields.push("decision_refs");
  if (!arraysEqual(locked.acceptance_refs, current.acceptance_refs))
    fields.push("acceptance_refs");
  if (!arraysEqual(locked.definition_of_done, current.definition_of_done))
    fields.push("definition_of_done");
  if (!arraysEqual(locked.verification_commands, current.verification_commands))
    fields.push("verification_commands");
  if (locked.base_sha !== current.base_sha) fields.push("base_sha");
  if (locked.phase_blob_sha !== current.phase_blob_sha)
    fields.push("phase_blob_sha");
  return fields;
}

export async function assertTaskContractCurrent(
  opts: AssertTaskContractOptions,
): Promise<AssertContractResult> {
  const { cwd, taskId } = opts;
  const lock = await readContractLock(cwd, taskId);

  const { phaseId, phasePath } = await resolveTaskInRoadmap(cwd, taskId);
  const phase = await loadPhase(cwd, phasePath);
  const task = phase.tasks?.find(t => t.id === taskId);
  if (!task) {
    const err = new Error(`Task "${taskId}" not found in phase "${phaseId}".`);
    (err as NodeJS.ErrnoException).code = "TASK_NOT_FOUND";
    throw err;
  }

  if (lock === null) {
    if (task.status === "done") {
      return { ok: true, lock: null, reason: "done_without_lock" };
    }
    if (opts.requireLock !== false) {
      const err = new Error(
        `Task contract lock is required for "${taskId}". Run \`code-pact task lock ${taskId}\` or \`code-pact task start ${taskId}\` first.`,
      );
      (err as NodeJS.ErrnoException).code = "TASK_CONTRACT_LOCK_REQUIRED";
      (err as NodeJS.ErrnoException & { task_id?: string }).task_id = taskId;
      (err as NodeJS.ErrnoException & { phase_id?: string }).phase_id = phaseId;
      throw err;
    }
    return { ok: false, lock: null, reason: "missing" };
  }

  let currentBaseSha: string;
  try {
    currentBaseSha = await resolveMergeBase(cwd, lock.base_sha);
  } catch {
    const err = new Error(
      `TASK_CONTRACT_DRIFT: locked base "${lock.base_sha}" is no longer an ancestor of HEAD.`,
    );
    (err as NodeJS.ErrnoException).code = "TASK_CONTRACT_DRIFT";
    (err as NodeJS.ErrnoException & { task_id?: string }).task_id = taskId;
    (err as NodeJS.ErrnoException & { phase_id?: string }).phase_id = phaseId;
    (err as NodeJS.ErrnoException & { locked_digest?: string }).locked_digest =
      lock.contract_digest;
    (
      err as NodeJS.ErrnoException & { current_digest?: string }
    ).current_digest = "";
    (
      err as NodeJS.ErrnoException & { changed_fields?: string[] }
    ).changed_fields = ["base_sha"];
    (
      err as NodeJS.ErrnoException & {
        drift?: { kind: string; message: string }[];
      }
    ).drift = [
      {
        kind: "base_sha",
        message: "locked base is no longer an ancestor of HEAD",
      },
    ];
    throw err;
  }

  if (currentBaseSha !== lock.base_sha) {
    const err = new Error(
      `TASK_CONTRACT_DRIFT: locked base "${lock.base_sha}" is no longer an ancestor of HEAD.`,
    );
    (err as NodeJS.ErrnoException).code = "TASK_CONTRACT_DRIFT";
    (err as NodeJS.ErrnoException & { task_id?: string }).task_id = taskId;
    (err as NodeJS.ErrnoException & { phase_id?: string }).phase_id = phaseId;
    (err as NodeJS.ErrnoException & { locked_digest?: string }).locked_digest =
      lock.contract_digest;
    (
      err as NodeJS.ErrnoException & { current_digest?: string }
    ).current_digest = "";
    (
      err as NodeJS.ErrnoException & { changed_fields?: string[] }
    ).changed_fields = ["base_sha"];
    (
      err as NodeJS.ErrnoException & {
        drift?: { kind: string; message: string }[];
      }
    ).drift = [
      {
        kind: "base_sha",
        message: "locked base is no longer an ancestor of HEAD",
      },
    ];
    throw err;
  }

  let currentPhaseBlobSha: string;
  try {
    currentPhaseBlobSha = await resolvePhaseBlobSha(
      cwd,
      lock.phase_path,
      currentBaseSha,
    );
  } catch {
    const err = new Error(
      `TASK_CONTRACT_DRIFT: locked phase file "${lock.phase_path}" is no longer reachable at base ref "${currentBaseSha}".`,
    );
    (err as NodeJS.ErrnoException).code = "TASK_CONTRACT_DRIFT";
    (err as NodeJS.ErrnoException & { task_id?: string }).task_id = taskId;
    (err as NodeJS.ErrnoException & { phase_id?: string }).phase_id = phaseId;
    (err as NodeJS.ErrnoException & { locked_digest?: string }).locked_digest =
      lock.contract_digest;
    (
      err as NodeJS.ErrnoException & { current_digest?: string }
    ).current_digest = "";
    (
      err as NodeJS.ErrnoException & { changed_fields?: string[] }
    ).changed_fields = ["phase_blob_sha"];
    (
      err as NodeJS.ErrnoException & {
        drift?: { kind: string; message: string }[];
      }
    ).drift = [
      {
        kind: "phase_blob_sha",
        message: "locked phase file is no longer reachable at HEAD",
      },
    ];
    throw err;
  }

  const currentContract = buildContract(
    task,
    phase,
    currentBaseSha,
    currentPhaseBlobSha,
  );
  const currentDigest = contractDigest(currentContract);

  if (lock.contract_digest !== currentDigest) {
    const fields = changedContractFields(lock.contract, currentContract);
    const err = new Error(
      `TASK_CONTRACT_DRIFT: contract digest mismatch (${fields.join(", ")}).`,
    );
    (err as NodeJS.ErrnoException).code = "TASK_CONTRACT_DRIFT";
    (err as NodeJS.ErrnoException & { task_id?: string }).task_id = taskId;
    (err as NodeJS.ErrnoException & { phase_id?: string }).phase_id = phaseId;
    (err as NodeJS.ErrnoException & { locked_digest?: string }).locked_digest =
      lock.contract_digest;
    (
      err as NodeJS.ErrnoException & { current_digest?: string }
    ).current_digest = currentDigest;
    (
      err as NodeJS.ErrnoException & { changed_fields?: string[] }
    ).changed_fields = fields;
    (
      err as NodeJS.ErrnoException & {
        drift?: { kind: string; message: string }[];
      }
    ).drift = fields.map(f => ({
      kind: f,
      message: `contract field "${f}" drifted from lock`,
    }));
    throw err;
  }

  // For spec-file locks, also verify the original registration digest so that
  // any edit to readiness fields that the contract digest might tolerate
  // (e.g. `depends_on` order, because the contract sorts it) still fails.
  if (lock.registration) {
    const currentRegistrationDigest = taskRegistrationDigest(phaseId, task);
    if (currentRegistrationDigest !== lock.registration.spec_digest) {
      let changedFields: string[];
      if (lock.registration.spec_canonical) {
        try {
          const parsed = JSON.parse(lock.registration.spec_canonical) as {
            task: Task;
          };
          changedFields = postLockRegistrationChangedFields(parsed.task, task);
        } catch {
          changedFields = ["registration_spec"];
        }
      } else {
        changedFields = ["registration_spec"];
      }
      if (changedFields.length === 0) {
        // The digests differ only because of a canonical-form or lifecycle
        // field change that is intentionally excluded from post-lock drift
        // (e.g. status). Treat this as no drift.
        return { ok: true, lock };
      }
      const err = new Error(
        `TASK_CONTRACT_DRIFT: task registration digest mismatch (${changedFields.join(", ")}).`,
      );
      (err as NodeJS.ErrnoException).code = "TASK_CONTRACT_DRIFT";
      (err as NodeJS.ErrnoException & { task_id?: string }).task_id = taskId;
      (err as NodeJS.ErrnoException & { phase_id?: string }).phase_id = phaseId;
      (
        err as NodeJS.ErrnoException & { locked_digest?: string }
      ).locked_digest = lock.contract_digest;
      (
        err as NodeJS.ErrnoException & { current_digest?: string }
      ).current_digest = currentDigest;
      (
        err as NodeJS.ErrnoException & { changed_fields?: string[] }
      ).changed_fields = changedFields;
      (
        err as NodeJS.ErrnoException & {
          drift?: { kind: string; message: string }[];
        }
      ).drift = changedFields.map(f => ({
        kind: f,
        message: `registration field "${f}" drifted from lock`,
      }));
      throw err;
    }
  }

  // For spec-file locks with a stored spec path, verify the original spec file
  // itself has not drifted from the locked registration. This catches edits to
  // the spec file that the phase-task digest check might miss when the phase
  // file itself was not updated (e.g. the spec file was amended after lock).
  if (lock.registration?.spec_path && lock.registration.spec_digest) {
    let specRaw: string;
    try {
      const specReadPath = await resolveExplicitUserReadPath(
        cwd,
        lock.registration.spec_path,
      );
      specRaw = await readExplicitUserText(specReadPath);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "PATH_OUTSIDE_PROJECT" || code === "PATH_NOT_OWNED") {
        const err = new Error(
          `TASK_CONTRACT_DRIFT: locked spec file path is outside the project or not owned.`,
        );
        (err as NodeJS.ErrnoException).code = "TASK_CONTRACT_DRIFT";
        (err as NodeJS.ErrnoException & { task_id?: string }).task_id = taskId;
        (err as NodeJS.ErrnoException & { phase_id?: string }).phase_id =
          phaseId;
        (
          err as NodeJS.ErrnoException & { locked_digest?: string }
        ).locked_digest = lock.contract_digest;
        (
          err as NodeJS.ErrnoException & { current_digest?: string }
        ).current_digest = currentDigest;
        (
          err as NodeJS.ErrnoException & { changed_fields?: string[] }
        ).changed_fields = ["registration_spec_file"];
        (
          err as NodeJS.ErrnoException & {
            drift?: { kind: string; message: string }[];
          }
        ).drift = [
          {
            kind: "registration_spec_file",
            message:
              "locked spec file path is outside the project or not owned",
          },
        ];
        throw err;
      }
      const err = new Error(
        `TASK_CONTRACT_DRIFT: locked spec file cannot be read.`,
      );
      (err as NodeJS.ErrnoException).code = "TASK_CONTRACT_DRIFT";
      (err as NodeJS.ErrnoException & { task_id?: string }).task_id = taskId;
      (err as NodeJS.ErrnoException & { phase_id?: string }).phase_id = phaseId;
      (
        err as NodeJS.ErrnoException & { locked_digest?: string }
      ).locked_digest = lock.contract_digest;
      (
        err as NodeJS.ErrnoException & { current_digest?: string }
      ).current_digest = currentDigest;
      (
        err as NodeJS.ErrnoException & { changed_fields?: string[] }
      ).changed_fields = ["registration_spec_file"];
      (
        err as NodeJS.ErrnoException & {
          drift?: { kind: string; message: string }[];
        }
      ).drift = [
        {
          kind: "registration_spec_file",
          message: "locked spec file is missing or cannot be read",
        },
      ];
      throw err;
    }

    let spec: { phase_id: string; task: Task };
    try {
      spec = parseTaskRegistrationSpec(specRaw);
    } catch {
      const err = new Error(
        `TASK_CONTRACT_DRIFT: locked spec file is not valid YAML or schema.`,
      );
      (err as NodeJS.ErrnoException).code = "TASK_CONTRACT_DRIFT";
      (err as NodeJS.ErrnoException & { task_id?: string }).task_id = taskId;
      (err as NodeJS.ErrnoException & { phase_id?: string }).phase_id = phaseId;
      (
        err as NodeJS.ErrnoException & { locked_digest?: string }
      ).locked_digest = lock.contract_digest;
      (
        err as NodeJS.ErrnoException & { current_digest?: string }
      ).current_digest = currentDigest;
      (
        err as NodeJS.ErrnoException & { changed_fields?: string[] }
      ).changed_fields = ["registration_spec_file"];
      (
        err as NodeJS.ErrnoException & {
          drift?: { kind: string; message: string }[];
        }
      ).drift = [
        {
          kind: "registration_spec_file",
          message: "locked spec file is not valid YAML or schema",
        },
      ];
      throw err;
    }

    if (spec.phase_id !== phaseId || spec.task.id !== taskId) {
      const err = new Error(
        `TASK_CONTRACT_DRIFT: locked spec file identity does not match.`,
      );
      (err as NodeJS.ErrnoException).code = "TASK_CONTRACT_DRIFT";
      (err as NodeJS.ErrnoException & { task_id?: string }).task_id = taskId;
      (err as NodeJS.ErrnoException & { phase_id?: string }).phase_id = phaseId;
      (
        err as NodeJS.ErrnoException & { locked_digest?: string }
      ).locked_digest = lock.contract_digest;
      (
        err as NodeJS.ErrnoException & { current_digest?: string }
      ).current_digest = currentDigest;
      (
        err as NodeJS.ErrnoException & { changed_fields?: string[] }
      ).changed_fields = ["registration_spec_file"];
      (
        err as NodeJS.ErrnoException & {
          drift?: { kind: string; message: string }[];
        }
      ).drift = [
        {
          kind: "registration_spec_file",
          message: "locked spec file identity does not match",
        },
      ];
      throw err;
    }

    const currentSpecDigest = taskRegistrationDigest(spec.phase_id, spec.task);
    if (currentSpecDigest !== lock.registration.spec_digest) {
      const err = new Error(
        `TASK_CONTRACT_DRIFT: task registration spec file drifted from lock.`,
      );
      (err as NodeJS.ErrnoException).code = "TASK_CONTRACT_DRIFT";
      (err as NodeJS.ErrnoException & { task_id?: string }).task_id = taskId;
      (err as NodeJS.ErrnoException & { phase_id?: string }).phase_id = phaseId;
      (
        err as NodeJS.ErrnoException & { locked_digest?: string }
      ).locked_digest = lock.contract_digest;
      (
        err as NodeJS.ErrnoException & { current_digest?: string }
      ).current_digest = currentDigest;
      (
        err as NodeJS.ErrnoException & { changed_fields?: string[] }
      ).changed_fields = ["registration_spec_file"];
      (
        err as NodeJS.ErrnoException & {
          drift?: { kind: string; message: string }[];
        }
      ).drift = [
        {
          kind: "registration_spec_file",
          message: "task registration spec file drifted from lock",
        },
      ];
      throw err;
    }
  }

  return { ok: true, lock };
}
