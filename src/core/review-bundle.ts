import { createHash } from "node:crypto";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import {
  readOwnedText,
  writeOwnedText,
  mkdirOwned,
  resolveReviewCacheDirWritePath,
  resolveReviewManifestReadPath,
  resolveReviewManifestWritePath,
  resolveContractLockReadPath,
} from "./project-fs/index.ts";
import { resolveProgressEventReadPath } from "./project-fs/authorities/project-config-authority.ts";
import { readOwnedPhaseRawByPath } from "./project-fs/control-plane.ts";
import { readEventFiles } from "./progress/events-io.ts";
import { deriveTaskState } from "./progress/task-state.ts";
import { loadProgressLog } from "./progress/io.ts";
import { resolveTaskInRoadmap } from "./plan/resolve-task.ts";
import { loadPhase } from "./plan/load-phase.ts";
import { assertTaskContractCurrent } from "./contract-lock.ts";
import {
  auditWrites,
  type WriteAuditResult,
  type WriteAuditWarning,
} from "./audit/write-audit.ts";
import {
  classifyPhaseLifecycle,
  type LifecycleControlPlaneEntry,
} from "./review-bundle-phase-lifecycle.ts";
import {
  classifyVerification,
  runVerificationCommands,
} from "./verify/classify.ts";
import { loadEvidenceArtifact } from "./evidence/evidence-store.ts";
import type { StoredEvidence } from "./evidence/evidence-store.ts";

const execFileAsync = promisify(execFile);

const MAX_EXCERPT_BYTES = 4096;

function excerpt(text: string): string {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= MAX_EXCERPT_BYTES) return text;
  let cut = MAX_EXCERPT_BYTES;
  while (cut > 0 && (text.charCodeAt(cut) & 0xc0) === 0x80) {
    cut -= 1;
  }
  return `${text.slice(0, cut)}\n[code-pact: excerpt truncated]\n`;
}

function verificationEntryFromArtifact(
  artifact: StoredEvidence["artifact"],
  source: "task_verification" | "classifier_verification",
) {
  return {
    source,
    command: artifact.command,
    exit_code: artifact.exit_code ?? -1,
    duration_ms: artifact.elapsed_ms,
    stdout_excerpt: excerpt(artifact.stdout),
    stderr_excerpt: excerpt(artifact.stderr),
  };
}

function derivePhaseStatus(
  tasks: { id: string; status: string }[],
  events: readonly import("./schemas/progress-event.ts").ProgressEvent[],
): "planned" | "in_progress" | "done" {
  if (tasks.length === 0) return "planned";
  const derived = tasks.map(t => deriveTaskState(events, t.id).current);
  if (derived.every(s => s === "done")) return "done";
  if (
    derived.some(
      s =>
        s === "started" || s === "blocked" || s === "resumed" || s === "failed",
    )
  ) {
    return "in_progress";
  }
  if (tasks.some(t => t.status === "in_progress")) return "in_progress";
  if (derived.some(s => s === "done")) return "in_progress";
  return "planned";
}

export const DoneEventRef = z.object({
  at: z.string().datetime(),
  evidence: z.array(z.string()).optional(),
  source: z.enum(["loop", "external"]).optional(),
  verification_ref: z
    .string()
    .regex(/^evidence:sha256:[0-9a-f]{64}$/)
    .optional(),
  path: z.string().optional(),
});

export const LocalVerificationEntry = z.object({
  source: z.enum(["task_verification", "classifier_verification"]),
  command: z.string(),
  exit_code: z.number(),
  duration_ms: z.number(),
  stdout_excerpt: z.string(),
  stderr_excerpt: z.string(),
});

export const RemoteCiStatus = z.enum(["pending", "success", "failure"]);

export const ReviewManifest = z.object({
  schema_version: z.literal(1),
  task_id: z.string(),
  phase_id: z.string(),
  phase_path: z.string(),
  base_sha: z.string(),
  head_sha: z.string(),
  tree_sha: z.string(),
  contract_digest: z.string(),
  phase_sha256: z.string(),
  start_events: z.array(DoneEventRef),
  done_event: DoneEventRef.optional(),
  actual_changed_files: z.array(z.string()),
  write_audit: z.object({
    git_available: z.boolean(),
    base_kind: z.enum(["working-tree", "merge-base", "unavailable"]),
    base_ref: z.string().nullable(),
    base_error: z
      .object({
        code: z.string(),
        message: z.string(),
        requested_ref: z.string(),
      })
      .optional(),
    files_touched: z.array(z.string()),
    outside_declared: z.array(z.string()),
    declared_unused: z.array(z.string()),
    warnings: z.array(z.string()),
    lifecycle_control_plane: z.array(
      z.object({
        file: z.string(),
        changed_fields: z.array(z.string()),
      }),
    ),
  }),
  task_verification: z.array(LocalVerificationEntry).default([]),
  classifier_verification: z.array(LocalVerificationEntry).default([]),
  remote_ci: z.object({
    status: RemoteCiStatus,
    run_url: z.string().optional(),
  }),
  at: z.string().datetime(),
  actor: z.enum(["agent", "user"]),
  agent: z.string().optional(),
  author: z.string().optional(),
});

export type ReviewManifest = z.infer<typeof ReviewManifest>;
export type { WriteAuditResult };

export function getReviewManifestDir(cwd: string, taskId: string): string {
  return join(cwd, ".code-pact", "cache", "reviews", taskId);
}

export function getReviewManifestPath(cwd: string, taskId: string): string {
  return join(getReviewManifestDir(cwd, taskId), "manifest.json");
}

export function getReviewBundlePath(cwd: string, taskId: string): string {
  return join(getReviewManifestDir(cwd, taskId), "bundle.zip");
}

async function execGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
  });
  return stdout.trim();
}

async function currentHeadSha(cwd: string): Promise<string> {
  return execGit(cwd, ["rev-parse", "--verify", "HEAD"]);
}

async function currentTreeSha(cwd: string): Promise<string> {
  return execGit(cwd, ["rev-parse", "--verify", "HEAD^{tree}"]);
}

async function assertWorktreeClean(cwd: string): Promise<void> {
  const out = await execGit(cwd, [
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]);
  if (out.length > 0) {
    const err = new Error(
      "Review bundle requires a clean working tree; stash or commit changes first.",
    );
    (err as NodeJS.ErrnoException).code = "WORKTREE_NOT_CLEAN";
    throw err;
  }
}

async function changedFilesSince(
  cwd: string,
  baseSha: string,
): Promise<string[]> {
  const out = await execGit(cwd, [
    "diff",
    "--no-renames",
    "--name-only",
    `${baseSha}...HEAD`,
  ]);
  return out
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
}

async function diffPatchSince(cwd: string, baseSha: string): Promise<string> {
  try {
    return await execGit(cwd, ["diff", `${baseSha}...HEAD`]);
  } catch {
    return "";
  }
}

function sha256(content: string): string {
  return createHash("sha256")
    .update(Buffer.from(content, "utf8"))
    .digest("hex");
}

export async function readReviewManifest(
  cwd: string,
  taskId: string,
): Promise<ReviewManifest | null> {
  try {
    const path = await resolveReviewManifestReadPath(
      cwd,
      `${taskId}/manifest.json`,
    );
    const raw = await readOwnedText(path);
    return ReviewManifest.parse(JSON.parse(raw) as unknown);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function writeReviewManifest(
  cwd: string,
  manifest: ReviewManifest,
): Promise<void> {
  const dir = await resolveReviewCacheDirWritePath(cwd, manifest.task_id);
  await mkdirOwned(dir, { recursive: true });
  const path = await resolveReviewManifestWritePath(
    cwd,
    `${manifest.task_id}/manifest.json`,
  );
  await writeOwnedText(path, JSON.stringify(manifest, null, 2));
}

export type ReviewBundleResult = {
  task_id: string;
  phase_id: string;
  phase_path: string;
  manifest_path: string;
  bundle_path: string;
  head_sha: string;
  tree_sha: string;
  contract_digest: string;
};

export type ReviewBundleOptions = {
  cwd: string;
  taskId: string;
  outputPath?: string;
  agent?: string;
  author?: string;
  actor?: "agent" | "user";
};

export async function runReviewBundle(
  opts: ReviewBundleOptions,
): Promise<ReviewBundleResult> {
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
  if (state.current !== "done") {
    const err = new Error(
      `Task "${taskId}" has no done event; cannot create review bundle.`,
    );
    (err as NodeJS.ErrnoException).code = "TASK_NOT_DONE";
    throw err;
  }

  const lockCheck = await assertTaskContractCurrent({
    cwd,
    taskId,
    requireLock: true,
  });
  const lock = lockCheck.ok ? lockCheck.lock : null;
  if (!lock) {
    const err = new Error(
      `Task contract lock is required to create review bundle for "${taskId}".`,
    );
    (err as NodeJS.ErrnoException).code = "TASK_CONTRACT_LOCK_REQUIRED";
    throw err;
  }

  await assertWorktreeClean(cwd);

  const headSha = await currentHeadSha(cwd);
  const treeSha = await currentTreeSha(cwd);

  const eventFiles = await readEventFiles(cwd);
  const taskEvents = eventFiles.filter(e => e.event.task_id === taskId);
  const startEvents = taskEvents
    .filter(e => e.event.status === "started")
    .map(e => ({
      at: e.event.at,
      path: e.file,
    }));
  const doneEventFile = [...taskEvents]
    .reverse()
    .find(e => e.event.status === "done");
  if (!doneEventFile) {
    const err = new Error(
      `Task "${taskId}" has no done event; cannot create review bundle.`,
    );
    (err as NodeJS.ErrnoException).code = "TASK_NOT_DONE";
    throw err;
  }

  const phaseContent = await readOwnedPhaseRawByPath(cwd, phasePath);

  // ---- State consistency gate ----
  const derivedPhaseStatus = derivePhaseStatus(phase.tasks ?? [], log.events);
  const phaseStatus = phase.status ?? "planned";
  const taskDesignStatus = task.status ?? "planned";
  if (
    taskDesignStatus !== "done" ||
    state.current !== "done" ||
    phaseStatus !== derivedPhaseStatus
  ) {
    const err = new Error(
      `Review bundle refused: task/phase state mismatch for "${taskId}".`,
    );
    (err as NodeJS.ErrnoException).code = "REVIEW_EVIDENCE_STATE_MISMATCH";
    (err as NodeJS.ErrnoException & { task_id?: string }).task_id = taskId;
    (err as NodeJS.ErrnoException & { phase_id?: string }).phase_id = phaseId;
    (err as NodeJS.ErrnoException & { phase_status?: string }).phase_status =
      phaseStatus;
    (
      err as NodeJS.ErrnoException & { derived_phase_status?: string }
    ).derived_phase_status = derivedPhaseStatus;
    (err as NodeJS.ErrnoException & { task_status?: string }).task_status =
      taskDesignStatus;
    (
      err as NodeJS.ErrnoException & { derived_task_status?: string }
    ).derived_task_status = state.current;
    throw err;
  }

  const actualChangedFiles = await changedFilesSince(cwd, lock.base_sha);

  const writeAudit = await auditWrites({
    cwd,
    declaredWrites: task.writes ?? [],
    baseRef: lock.base_sha,
  });

  // Lifecycle-only phase status mutations (task finalize / phase reconcile /
  // manual closeout) are control-plane changes, not task implementation writes.
  // Reclassify them before enforcing TASK_CONTRACT_DRIFT.
  const lifecycleControlPlane: LifecycleControlPlaneEntry[] = [];
  const reclassifiedOutsideDeclared: string[] = [];
  for (const file of writeAudit.outside_declared) {
    if (file.startsWith("design/phases/") && file.endsWith(".yaml")) {
      const classification = await classifyPhaseLifecycle({
        cwd,
        phasePath: file,
        baseSha: lock.base_sha,
        events: log.events,
        derivedPhaseStatus,
      });
      if (classification.lifecycleOnly) {
        lifecycleControlPlane.push({
          file,
          changed_fields: classification.changedFields,
        });
        continue;
      }
    }
    reclassifiedOutsideDeclared.push(file);
  }

  if (reclassifiedOutsideDeclared.length > 0) {
    const err = new Error(
      `Review bundle refused: files changed outside declared writes: ${reclassifiedOutsideDeclared.join(", ")}`,
    );
    (err as NodeJS.ErrnoException).code = "TASK_CONTRACT_DRIFT";
    (err as NodeJS.ErrnoException & { task_id?: string }).task_id = taskId;
    (err as NodeJS.ErrnoException & { phase_id?: string }).phase_id = phaseId;
    (
      err as NodeJS.ErrnoException & { changed_fields?: string[] }
    ).changed_fields = ["writes"];
    throw err;
  }

  // Recompute warnings from the post-reclassification state. The original
  // audit emitted TASK_WRITES_AUDIT_OUTSIDE_DECLARED because phase YAML was
  // in outside_declared; once reclassified to lifecycle_control_plane that
  // warning is no longer accurate.
  const warnings: WriteAuditWarning[] = [];
  if (reclassifiedOutsideDeclared.length > 0) {
    warnings.push("TASK_WRITES_AUDIT_OUTSIDE_DECLARED");
  }
  if (writeAudit.declared_unused.length > 0) {
    warnings.push("TASK_WRITES_AUDIT_DECLARED_UNUSED");
  }

  if (writeAudit.declared_unused.length > 0) {
    const err = new Error(
      `Review bundle refused: declared writes were not used: ${writeAudit.declared_unused.join(", ")}`,
    );
    (err as NodeJS.ErrnoException).code = "REVIEW_EVIDENCE_SCOPE_IMPRECISE";
    (err as NodeJS.ErrnoException & { task_id?: string }).task_id = taskId;
    (err as NodeJS.ErrnoException & { phase_id?: string }).phase_id = phaseId;
    (
      err as NodeJS.ErrnoException & { declared_unused?: string[] }
    ).declared_unused = writeAudit.declared_unused;
    throw err;
  }

  // ---- Task verification evidence from the done event ----
  const taskVerification: z.infer<typeof LocalVerificationEntry>[] = [];
  if (
    doneEventFile.event.verification_ref === undefined ||
    doneEventFile.event.verification_ref.length === 0
  ) {
    const err = new Error(
      `Review bundle refused: task verification evidence missing for "${taskId}".`,
    );
    (err as NodeJS.ErrnoException).code =
      "REVIEW_EVIDENCE_VERIFICATION_MISSING";
    (err as NodeJS.ErrnoException & { task_id?: string }).task_id = taskId;
    (err as NodeJS.ErrnoException & { phase_id?: string }).phase_id = phaseId;
    throw err;
  }
  const storedEvidence = await loadEvidenceArtifact(
    cwd,
    doneEventFile.event.verification_ref,
  );
  taskVerification.push(
    verificationEntryFromArtifact(storedEvidence.artifact, "task_verification"),
  );

  // ---- Classifier verification ----
  const classification = await classifyVerification(cwd, lock.base_sha);
  const classifierVerification = await runVerificationCommands(
    cwd,
    classification.commands,
  );

  if (!classifierVerification.ok) {
    const failed = classifierVerification.results.find(r => r.exit_code !== 0);
    const err = new Error(
      `Review bundle refused: local verification failed (${failed?.command ?? "unknown"}).`,
    );
    (err as NodeJS.ErrnoException).code = "VERIFICATION_FAILED";
    throw err;
  }

  const classifierVerificationEntries: z.infer<
    typeof LocalVerificationEntry
  >[] = classifierVerification.results.map(r => ({
    source: "classifier_verification",
    command: r.command,
    exit_code: r.exit_code,
    duration_ms: r.duration_ms,
    stdout_excerpt: r.stdout_excerpt,
    stderr_excerpt: r.stderr_excerpt,
  }));

  const manifest: ReviewManifest = {
    schema_version: 1,
    task_id: taskId,
    phase_id: phaseId,
    phase_path: phasePath,
    base_sha: lock.base_sha,
    head_sha: headSha,
    tree_sha: treeSha,
    contract_digest: lock.contract_digest,
    phase_sha256: sha256(phaseContent),
    start_events: startEvents,
    done_event: {
      at: doneEventFile.event.at,
      evidence: doneEventFile.event.evidence,
      source: doneEventFile.event.source,
      verification_ref: doneEventFile.event.verification_ref,
      path: doneEventFile.file,
    },
    actual_changed_files: actualChangedFiles,
    write_audit: {
      git_available: writeAudit.git_available,
      base_kind: writeAudit.base_kind,
      base_ref: writeAudit.base_ref,
      ...(writeAudit.base_error ? { base_error: writeAudit.base_error } : {}),
      files_touched: writeAudit.files_touched,
      outside_declared: reclassifiedOutsideDeclared,
      declared_unused: writeAudit.declared_unused,
      warnings,
      lifecycle_control_plane: lifecycleControlPlane,
    },
    task_verification: taskVerification,
    classifier_verification: classifierVerificationEntries,
    remote_ci: { status: "pending" },
    at: new Date().toISOString(),
    actor: opts.actor ?? "agent",
    agent: opts.agent,
    author: opts.author,
  };

  await writeReviewManifest(cwd, manifest);

  const bundlePath = opts.outputPath ?? getReviewBundlePath(cwd, taskId);
  await createReviewZip(cwd, taskId, bundlePath, manifest, phaseContent);

  return {
    task_id: taskId,
    phase_id: phaseId,
    phase_path: phasePath,
    manifest_path: getReviewManifestPath(cwd, taskId),
    bundle_path: bundlePath,
    head_sha: headSha,
    tree_sha: treeSha,
    contract_digest: lock.contract_digest,
  };
}

async function createReviewZip(
  cwd: string,
  taskId: string,
  outputPath: string,
  manifest: ReviewManifest,
  phaseContent: string,
): Promise<void> {
  const staging = getReviewManifestDir(cwd, taskId) + "/bundle";
  const stagingWrite = await resolveReviewCacheDirWritePath(
    cwd,
    `${taskId}/bundle`,
  );
  await mkdirOwned(stagingWrite, { recursive: true });

  const write = async (name: string, content: string) => {
    const path = await resolveReviewCacheDirWritePath(
      cwd,
      `${taskId}/bundle/${name}`,
    );
    await writeOwnedText(path, content);
  };

  await write("manifest.json", JSON.stringify(manifest, null, 2));

  const lockPath = await resolveContractLockReadPath(cwd, `${taskId}.yaml`);
  const lockContent = await readOwnedText(lockPath);
  await write("contract-lock.yaml", lockContent);

  await write("phase.yaml", phaseContent);

  const eventFiles = await readEventFiles(cwd);
  const doneEventFile = [...eventFiles]
    .reverse()
    .find(e => e.event.task_id === taskId && e.event.status === "done");
  if (doneEventFile) {
    const eventPath = await resolveProgressEventReadPath(
      cwd,
      doneEventFile.file,
    );
    const eventContent = await readOwnedText(eventPath);
    await write("done-event.yaml", eventContent);
  }

  await write(
    "verification.json",
    JSON.stringify(
      {
        task_verification: manifest.task_verification,
        classifier_verification: manifest.classifier_verification,
      },
      null,
      2,
    ),
  );
  await write(
    "changed-files.json",
    JSON.stringify(manifest.actual_changed_files, null, 2),
  );
  const patch = await diffPatchSince(cwd, manifest.base_sha);
  await write("diff.patch", patch);

  // Zip requires the `zip` CLI. Fail explicitly if it is not installed.
  try {
    await execFileAsync("zip", ["-r", outputPath, "."], { cwd: staging });
  } catch (err) {
    const message = err instanceof Error ? err.message : "zip command failed";
    const zipErr = new Error(
      `Review bundle ZIP creation failed: ${message}. Install \`zip\` (e.g. apt install zip) and retry.`,
    );
    (zipErr as NodeJS.ErrnoException).code = "ARCHIVE_BUNDLE_WRITE_FAILED";
    throw zipErr;
  }
}
