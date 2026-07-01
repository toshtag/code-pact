import { createHash, randomUUID } from "node:crypto";
import {
  fsyncOwnedDirectory,
  mkdirOwned,
  readOwnedText,
  listOwned,
  renameOwned,
  unlinkOwned,
  lstatOwned,
  statOwned,
  writeOwnedTempDurably,
} from "../project-fs/operations.ts";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { atomicWriteText } from "../../io/atomic-text.ts";
import { isSupportedAgent, type SupportedAgent } from "../agents.ts";
import { adapterRegistry } from "./index.ts";
import type { DesiredAdapterFileRole } from "./types.ts";
import {
  unbrand,
  adapterWritePath,
  adapterReadPath,
  adapterDeletePath,
  adapterListPath,
} from "../project-fs/authorities/adapter-authority.ts";
import type {
  OwnedDeletePath,
  OwnedWritePath,
} from "../project-fs/branded-paths.ts";
import {
  assertSafeRelativePath,
  pathTraversesSymlink,
} from "../path-safety.ts";
import { resolveOwnedAgentProfilePath } from "../agent-profile-path.ts";
import { resolveManifestPath } from "./manifest.ts";
import {
  authorizeAdapterMutationPath,
  type AdapterMutationPathAuthority,
} from "./manifest-file-ownership.ts";
import {
  adapterTransactionProjectDir,
  canonicalProjectRoot,
  LEGACY_TRANSACTION_DIR_REL,
} from "./transaction-state-root.ts";

/**
 * Error code for a partial mutation: some filesystem operation started, but a
 * later operation failed. Recovery evidence is preserved when automatic rollback
 * cannot safely converge the state.
 */
export class PartialMutationError extends Error {
  code = "PARTIAL_MUTATION" as const;
  committedPaths: readonly string[];
  rollbackFailures: readonly string[];
  backupPaths: readonly string[];
  constructor(
    message: string,
    committedPaths: readonly string[],
    rollbackFailures: readonly string[] = [],
    backupPaths: readonly string[] = [],
  ) {
    super(message);
    this.name = "PartialMutationError";
    this.committedPaths = committedPaths;
    this.rollbackFailures = rollbackFailures;
    this.backupPaths = backupPaths;
  }
}

export class TransactionCleanupPendingError extends Error {
  code = "TRANSACTION_CLEANUP_PENDING" as const;
  journalPath: string;
  cleanupFailures: readonly string[];
  backupPaths: readonly string[];
  constructor(
    message: string,
    journalPath: string,
    cleanupFailures: readonly string[],
    backupPaths: readonly string[],
  ) {
    super(message);
    this.name = "TransactionCleanupPendingError";
    this.journalPath = journalPath;
    this.cleanupFailures = cleanupFailures;
    this.backupPaths = backupPaths;
  }
}

export class TransactionRecoveryError extends Error {
  code = "ADAPTER_TRANSACTION_RECOVERY_FAILED" as const;
  journalPath: string;
  constructor(message: string, journalPath: string) {
    super(message);
    this.name = "TransactionRecoveryError";
    this.journalPath = journalPath;
  }
}

type FileState = { kind: "absent" } | { kind: "present"; sha256: string };

type JournalStatus = "prepared" | "committed" | "cleanup_pending";

type AdapterTransactionEntryV2 = {
  operation: "write" | "delete";
  target_kind:
    | "agent_profile"
    | "adapter_manifest"
    | "adapter_static_file"
    | "adapter_dynamic_create"
    | "test_only";
  target_rel_path: string;
  role?: DesiredAdapterFileRole;
  pre_state: FileState;
  post_state: FileState;
  index: number;
};

type AdapterTransactionJournalV2 = {
  schema_version: 2;
  id: string;
  project_root: string;
  agent_name?: SupportedAgent;
  status: JournalStatus;
  entries: AdapterTransactionEntryV2[];
  cleanup_failures?: string[];
};

export type AdapterWriteTarget =
  | {
      kind: "agent_profile";
      agentName: SupportedAgent;
      absPath: OwnedWritePath;
    }
  | {
      kind: "adapter_manifest";
      agentName: SupportedAgent;
      absPath: OwnedWritePath;
    }
  | {
      kind: "adapter_static_file";
      agentName: SupportedAgent;
      relPath: string;
      role: DesiredAdapterFileRole;
      absPath: OwnedWritePath;
    }
  | {
      kind: "adapter_dynamic_create";
      agentName: SupportedAgent;
      relPath: string;
      role: DesiredAdapterFileRole;
      absPath: OwnedWritePath;
    }
  | {
      kind: "test_only";
      absPath: string;
    };

export type AdapterDeleteTarget =
  | {
      kind: "adapter_static_file";
      agentName: SupportedAgent;
      relPath: string;
      role: DesiredAdapterFileRole;
      absPath: OwnedDeletePath;
    }
  | {
      kind: "test_only";
      absPath: string;
    };

interface StagedEntry {
  kind: "write" | "delete";
  targetKind: AdapterTransactionEntryV2["target_kind"];
  agentName?: SupportedAgent;
  role?: DesiredAdapterFileRole;
  tempPath: string;
  finalPath: string;
  backupPath: string;
  relPath: string;
  content?: string;
  preState: FileState;
  postState: FileState;
}

export type AdapterTransactionRecoveryResult = {
  recovered: string[];
  cleaned: string[];
  rejected: string[];
};

type FileTransactionOptions = {
  cwd?: string;
};

const LEGACY_REJECTION = "LEGACY_TRANSACTION_JOURNAL_UNTRUSTED";

export function assertNoUntrustedAdapterTransactionJournals(
  result: AdapterTransactionRecoveryResult,
): void {
  if (result.rejected.length === 0) return;
  const err = new Error(
    "Legacy project-local adapter transaction journals are untrusted and cannot be recovered automatically. Inspect .code-pact/state/adapter-transactions manually before retrying.",
  );
  (err as NodeJS.ErrnoException).code = LEGACY_REJECTION;
  throw err;
}

export function adapterProfileWriteTarget(
  agentName: SupportedAgent,
  absPath: OwnedWritePath,
): AdapterWriteTarget {
  return { kind: "agent_profile", agentName, absPath };
}

export function adapterManifestWriteTarget(
  agentName: SupportedAgent,
  absPath: OwnedWritePath,
): AdapterWriteTarget {
  return { kind: "adapter_manifest", agentName, absPath };
}

export function adapterStaticWriteTarget(
  agentName: SupportedAgent,
  relPath: string,
  role: DesiredAdapterFileRole,
  authority: Extract<AdapterMutationPathAuthority, { kind: "owned" }>,
): AdapterWriteTarget {
  return {
    kind: "adapter_static_file",
    agentName,
    relPath,
    role,
    absPath: authority.absPath,
  };
}

export function adapterDynamicCreateTarget(
  agentName: SupportedAgent,
  relPath: string,
  role: DesiredAdapterFileRole,
  authority: Extract<AdapterMutationPathAuthority, { kind: "dynamic_write" }>,
): AdapterWriteTarget {
  return {
    kind: "adapter_dynamic_create",
    agentName,
    relPath,
    role,
    absPath: authority.absPath,
  };
}

export function adapterStaticDeleteTarget(
  agentName: SupportedAgent,
  relPath: string,
  role: DesiredAdapterFileRole,
  authority: Extract<AdapterMutationPathAuthority, { kind: "owned" }>,
): AdapterDeleteTarget {
  return {
    kind: "adapter_static_file",
    agentName,
    relPath,
    role,
    absPath: adapterDeletePath(unbrand(authority.absPath)),
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await statOwned(adapterReadPath(path));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

async function syncDirectory(dir: string): Promise<void> {
  try {
    await fsyncOwnedDirectory(adapterListPath(dir));
  } catch {
    // Directory fsync is not supported on every platform/filesystem.
  }
}

async function durableWriteJson(path: string, value: unknown): Promise<void> {
  await mkdirOwned(adapterWritePath(dirname(path)), {
    recursive: true,
    mode: 0o700,
  });
  const tmp = `${path}.tmp-${randomUUID()}`;
  try {
    await writeOwnedTempDurably(
      adapterWritePath(tmp),
      `${JSON.stringify(value, null, 2)}\n`,
    );
    await renameOwned(adapterDeletePath(tmp), adapterWritePath(path));
    await syncDirectory(dirname(path));
  } catch (err) {
    await unlinkOwned(adapterDeletePath(tmp)).catch(() => {});
    throw err;
  }
}

async function removeFileIfExists(path: string): Promise<void> {
  await unlinkOwned(adapterDeletePath(path)).catch(err => {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  });
}

async function cleanupJournal(path: string): Promise<void> {
  await unlinkOwned(adapterDeletePath(path)).catch(err => {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  });
  await syncDirectory(dirname(path));
}

function sha256Bytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function hashFile(path: string): Promise<FileState> {
  try {
    const bytes = await readOwnedText(adapterReadPath(path));
    return { kind: "present", sha256: sha256Bytes(Buffer.from(bytes)) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "absent" };
    }
    throw err;
  }
}

function sameState(actual: FileState, expected: FileState): boolean {
  if (actual.kind !== expected.kind) return false;
  if (actual.kind === "absent") return true;
  return expected.kind === "present" && actual.sha256 === expected.sha256;
}

function stateLabel(state: FileState): string {
  return state.kind === "absent" ? "absent" : `sha256:${state.sha256}`;
}

function toRel(cwd: string, absPath: string): string {
  const rel = relative(cwd, absPath).split(sep).join("/");
  if (rel.startsWith("../") || rel === ".." || rel.startsWith("/")) {
    throw new Error(`transaction path is outside cwd: ${absPath}`);
  }
  assertSafeRelativePath(rel);
  return rel;
}

function fromRel(cwd: string, relPath: string): string {
  assertSafeRelativePath(relPath);
  return resolve(cwd, relPath);
}

function artifactPathsFor(
  cwd: string,
  journalId: string,
  entry: Pick<AdapterTransactionEntryV2, "target_rel_path" | "index">,
): { finalPath: string; tempPath: string; backupPath: string } {
  assertUuidV4(journalId, "journal id");
  const finalPath = fromRel(cwd, entry.target_rel_path);
  const tempPath = `${finalPath}.code-pact-tx-${journalId}-${entry.index}.tmp`;
  const backupPath = `${finalPath}.bak-${journalId}-${entry.index}`;
  if (
    dirname(tempPath) !== dirname(finalPath) ||
    dirname(backupPath) !== dirname(finalPath)
  ) {
    throw new Error("transaction artifact path escapes target directory");
  }
  if (
    tempPath !==
      join(
        dirname(finalPath),
        `${basename(finalPath)}.code-pact-tx-${journalId}-${entry.index}.tmp`,
      ) ||
    backupPath !==
      join(
        dirname(finalPath),
        `${basename(finalPath)}.bak-${journalId}-${entry.index}`,
      )
  ) {
    throw new Error("transaction artifact path does not match expected format");
  }
  return {
    finalPath,
    tempPath,
    backupPath,
  };
}

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

function assertUuidV4(value: string, label: string): void {
  if (!UUID_V4_RE.test(value)) {
    throw new Error(`${label} must be a UUIDv4`);
  }
}

async function ensureRegularFileIfPresent(path: string): Promise<void> {
  try {
    const st = await statOwned(adapterReadPath(path));
    if (st.isDirectory()) {
      throw new Error(`transaction target is a directory: ${path}`);
    }
    if (!st.isFile()) {
      throw new Error(`transaction target is not a regular file: ${path}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}

/**
 * Multi-file transaction with a private v2 recovery journal. The journal is not
 * stored in the repository because repository content is attacker-controlled.
 * Recovery never executes project-local v1 journals.
 */
export class FileTransaction {
  private staged: StagedEntry[] = [];
  private finalPaths = new Set<string>();
  private journalPath: string | null = null;
  private transactionId = randomUUID();
  private state:
    | "open"
    | "committing"
    | "committed"
    | "cleanup_pending"
    | "rolled_back" = "open";
  private cwd: string | null;

  constructor(options: FileTransactionOptions = {}) {
    this.cwd = options.cwd ? resolve(options.cwd) : null;
  }

  async addWrite(target: AdapterWriteTarget, content: string): Promise<void> {
    await this.stageInternal(target, content);
  }

  addDelete(target: AdapterDeleteTarget): void {
    this.stageDeleteInternal(target);
  }

  async stageForTest(path: string, content: string): Promise<void> {
    await this.stageInternal({ kind: "test_only", absPath: path }, content);
  }

  stageDeleteForTest(path: string): void {
    this.stageDeleteInternal({ kind: "test_only", absPath: path });
  }

  private async stageInternal(
    target: AdapterWriteTarget,
    content: string,
  ): Promise<void> {
    const path =
      target.kind === "test_only" ? target.absPath : unbrand(target.absPath);
    this.assertCanStage(path);
    const cwd = this.resolveCwd(path);
    const relPath = toRel(cwd, path);
    if (
      (target.kind === "adapter_static_file" ||
        target.kind === "adapter_dynamic_create") &&
      target.relPath !== relPath
    ) {
      throw new Error(
        `transaction target metadata does not match authority path: ${target.relPath} !== ${relPath}`,
      );
    }
    const index = this.staged.length;
    const tempPath = `${path}.code-pact-tx-${this.transactionId}-${index}.tmp`;
    const backupPath = `${path}.bak-${this.transactionId}-${index}`;
    this.staged.push({
      kind: "write",
      targetKind: target.kind,
      agentName: target.kind === "test_only" ? undefined : target.agentName,
      role:
        target.kind === "adapter_static_file" ||
        target.kind === "adapter_dynamic_create"
          ? target.role
          : undefined,
      tempPath,
      finalPath: path,
      backupPath,
      relPath,
      content,
      preState: { kind: "absent" },
      postState: { kind: "present", sha256: sha256Bytes(Buffer.from(content)) },
    });
  }

  private stageDeleteInternal(target: AdapterDeleteTarget): void {
    const path =
      target.kind === "test_only" ? target.absPath : unbrand(target.absPath);
    this.assertCanStage(path);
    const cwd = this.resolveCwd(path);
    const relPath = toRel(cwd, path);
    if (target.kind === "adapter_static_file" && target.relPath !== relPath) {
      throw new Error(
        `transaction target metadata does not match authority path: ${target.relPath} !== ${relPath}`,
      );
    }
    const index = this.staged.length;
    this.staged.push({
      kind: "delete",
      targetKind: target.kind,
      agentName: target.kind === "test_only" ? undefined : target.agentName,
      role: target.kind === "adapter_static_file" ? target.role : undefined,
      tempPath: "",
      finalPath: path,
      backupPath: `${path}.bak-${this.transactionId}-${index}`,
      relPath,
      preState: { kind: "absent" },
      postState: { kind: "absent" },
    });
  }

  async commit(): Promise<void> {
    if (this.staged.length === 0) return;
    if (this.state !== "open") {
      throw new Error("transaction has already been committed or rolled back");
    }
    this.state = "committing";

    const journal = await this.writePreparedJournal();
    let mutated = false;
    try {
      await this.createPreparedTemps();
      for (const s of this.staged) {
        if (s.preState.kind === "present") {
          await renameOwned(
            adapterDeletePath(s.finalPath),
            adapterWritePath(s.backupPath),
          );
          mutated = true;
        }
        if (s.kind === "write") {
          await renameOwned(
            adapterDeletePath(s.tempPath),
            adapterWritePath(s.finalPath),
          );
          mutated = true;
        } else {
          mutated = true;
        }
      }

      journal.status = "committed";
      await durableWriteJson(this.requireJournalPath(), journal);
      this.state = "committed";

      const cleanupFailures = await this.cleanupCommittedArtifacts();
      if (cleanupFailures.length > 0) {
        journal.status = "cleanup_pending";
        journal.cleanup_failures = cleanupFailures;
        await durableWriteJson(this.requireJournalPath(), journal);
        this.state = "cleanup_pending";
        throw new TransactionCleanupPendingError(
          `Transaction committed, but cleanup is pending: ${cleanupFailures.join("; ")}`,
          this.requireJournalPath(),
          cleanupFailures,
          this.staged.map(s => s.backupPath),
        );
      }

      try {
        await cleanupJournal(this.requireJournalPath());
        this.journalPath = null;
      } catch (err) {
        journal.status = "cleanup_pending";
        journal.cleanup_failures = [
          `${this.requireJournalPath()}: ${(err as Error).message}`,
        ];
        await durableWriteJson(this.requireJournalPath(), journal).catch(
          () => {},
        );
        this.state = "cleanup_pending";
        throw new TransactionCleanupPendingError(
          `Transaction committed, but journal cleanup is pending: ${(err as Error).message}`,
          this.requireJournalPath(),
          journal.cleanup_failures,
          this.staged.map(s => s.backupPath),
        );
      }
    } catch (err) {
      if (this.state === "committed" || this.state === "cleanup_pending") {
        throw err;
      }
      const rollbackFailures = await rollbackJournalToOldState(
        this.resolveCwd(),
        journal,
        { allowTestOnlyTargets: true },
      );
      if (this.journalPath && rollbackFailures.length === 0) {
        await cleanupJournal(this.journalPath).catch(() => {});
        this.journalPath = null;
      }
      if (mutated || rollbackFailures.length > 0) {
        throw new PartialMutationError(
          `Transaction failed after mutating filesystem state: ${(err as Error).message}`,
          this.staged.map(s => s.finalPath),
          rollbackFailures,
          this.staged.map(s => s.backupPath),
        );
      }
      throw err;
    }
  }

  async rollback(): Promise<void> {
    if (this.state !== "open") {
      return;
    }
    for (const s of this.staged) {
      if (s.kind === "write")
        await unlinkOwned(adapterDeletePath(s.tempPath)).catch(() => {});
    }
    this.state = "rolled_back";
  }

  async writePreparedJournalForTest(): Promise<void> {
    await this.writePreparedJournal();
  }

  stagedArtifactsForTest(): ReadonlyArray<{
    finalPath: string;
    tempPath: string;
    backupPath: string;
  }> {
    return this.staged.map(s => ({
      finalPath: s.finalPath,
      tempPath: s.tempPath,
      backupPath: s.backupPath,
    }));
  }

  private assertCanStage(path: string): void {
    if (this.state !== "open") {
      throw new Error("cannot stage after transaction commit has started");
    }
    if (this.finalPaths.has(path)) {
      throw new Error(`duplicate transaction target: ${path}`);
    }
    this.finalPaths.add(path);
  }

  private resolveCwd(path?: string): string {
    if (this.cwd) return this.cwd;
    if (path) {
      this.cwd = dirname(path);
      return this.cwd;
    }
    this.cwd = dirname(this.staged[0]!.finalPath);
    return this.cwd;
  }

  private requireJournalPath(): string {
    if (!this.journalPath)
      throw new Error("transaction journal was not prepared");
    return this.journalPath;
  }

  private async writePreparedJournal(): Promise<AdapterTransactionJournalV2> {
    const cwd = this.resolveCwd();
    await this.prepareEntries();
    const agentNames = new Set(
      this.staged.flatMap(s =>
        s.agentName === undefined ? [] : [s.agentName],
      ),
    );
    if (agentNames.size > 1) {
      throw new Error("adapter transaction cannot mix multiple agents");
    }
    const journalDir = await adapterTransactionProjectDir(cwd);
    this.journalPath = join(journalDir, `${this.transactionId}.json`);
    const journal: AdapterTransactionJournalV2 = {
      schema_version: 2,
      id: this.transactionId,
      project_root: await canonicalProjectRoot(cwd),
      agent_name: agentNames.values().next().value,
      status: "prepared",
      entries: this.staged.map((s, index) => ({
        operation: s.kind,
        target_kind: s.targetKind,
        target_rel_path: s.relPath,
        ...(s.role !== undefined ? { role: s.role } : {}),
        pre_state: s.preState,
        post_state: s.postState,
        index,
      })),
    };
    await durableWriteJson(this.journalPath, journal);
    return journal;
  }

  private async prepareEntries(): Promise<void> {
    const cwd = this.resolveCwd();
    for (const s of this.staged) {
      if (await pathTraversesSymlink(cwd, s.relPath)) {
        const err = new Error(
          `transaction target "${s.relPath}" resolves through a symlink`,
        );
        (err as NodeJS.ErrnoException).code = "PATH_NOT_OWNED";
        throw err;
      }
      if (await pathExists(s.backupPath)) {
        throw new Error(`backup path already exists: ${s.backupPath}`);
      }
      if (s.kind === "write" && (await pathExists(s.tempPath))) {
        throw new Error(`temp path already exists: ${s.tempPath}`);
      }
      await ensureRegularFileIfPresent(s.finalPath);
      s.preState = await hashFile(s.finalPath);
      if (
        s.targetKind === "adapter_dynamic_create" &&
        s.preState.kind !== "absent"
      ) {
        throw new Error(
          `dynamic adapter target already exists and cannot be transaction-created: ${s.relPath}`,
        );
      }
      if (s.kind === "write") {
        s.postState = {
          kind: "present",
          sha256: sha256Bytes(Buffer.from(s.content ?? "")),
        };
      } else {
        s.postState = { kind: "absent" };
      }
    }
  }

  private async createPreparedTemps(): Promise<void> {
    for (const s of this.staged) {
      if (s.kind !== "write") continue;
      if (s.content === undefined) {
        throw new Error(`missing staged write content for ${s.relPath}`);
      }
      await atomicWriteText(adapterWritePath(s.tempPath), s.content);
      const tempStat = await statOwned(adapterReadPath(s.tempPath));
      if (!tempStat.isFile()) {
        await unlinkOwned(adapterDeletePath(s.tempPath)).catch(() => {});
        throw new Error(
          `staged temp path is not a regular file: ${s.tempPath}`,
        );
      }
      const tempState = await hashFile(s.tempPath);
      if (!sameState(tempState, s.postState)) {
        throw new Error(
          `staged temp hash mismatch: expected ${stateLabel(s.postState)}, got ${stateLabel(tempState)}`,
        );
      }
    }
  }

  private async cleanupCommittedArtifacts(): Promise<string[]> {
    const failures: string[] = [];
    for (const s of this.staged) {
      if (s.preState.kind === "present") {
        try {
          await unlinkOwned(adapterDeletePath(s.backupPath));
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            failures.push(`${s.backupPath}: ${(err as Error).message}`);
          }
        }
      }
      if (s.kind === "write") {
        try {
          await unlinkOwned(adapterDeletePath(s.tempPath));
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            failures.push(`${s.tempPath}: ${(err as Error).message}`);
          }
        }
      }
    }
    return failures;
  }
}

function isFileState(value: unknown): value is FileState {
  const state = value as Partial<FileState>;
  return (
    state.kind === "absent" ||
    (state.kind === "present" &&
      typeof state.sha256 === "string" &&
      SHA256_RE.test(state.sha256))
  );
}

function isJournalEntryV2(value: unknown): value is AdapterTransactionEntryV2 {
  const entry = value as Partial<AdapterTransactionEntryV2>;
  return (
    (entry.operation === "write" || entry.operation === "delete") &&
    (entry.target_kind === "agent_profile" ||
      entry.target_kind === "adapter_manifest" ||
      entry.target_kind === "adapter_static_file" ||
      entry.target_kind === "adapter_dynamic_create") &&
    typeof entry.target_rel_path === "string" &&
    (entry.role === undefined || typeof entry.role === "string") &&
    isFileState(entry.pre_state) &&
    isFileState(entry.post_state) &&
    typeof entry.index === "number" &&
    Number.isInteger(entry.index) &&
    entry.index >= 0
  );
}

async function loadJournal(
  cwd: string,
  journalPath: string,
): Promise<AdapterTransactionJournalV2> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readOwnedText(adapterReadPath(journalPath)));
  } catch (err) {
    throw new TransactionRecoveryError(
      `cannot read adapter transaction journal: ${(err as Error).message}`,
      journalPath,
    );
  }
  const journal = parsed as Partial<AdapterTransactionJournalV2>;
  const journalFileMatch = basename(journalPath).match(/^(.+)\.json$/);
  if (
    journal.schema_version !== 2 ||
    typeof journal.id !== "string" ||
    (journal.status !== "prepared" &&
      journal.status !== "committed" &&
      journal.status !== "cleanup_pending") ||
    typeof journal.project_root !== "string" ||
    (journal.agent_name !== undefined &&
      (typeof journal.agent_name !== "string" ||
        !isSupportedAgent(journal.agent_name))) ||
    !Array.isArray(journal.entries)
  ) {
    throw new TransactionRecoveryError(
      "adapter transaction journal is corrupt",
      journalPath,
    );
  }
  try {
    assertUuidV4(journal.id, "journal id");
  } catch {
    throw new TransactionRecoveryError(
      "adapter transaction journal id is invalid",
      journalPath,
    );
  }
  if (!journalFileMatch || journalFileMatch[1] !== journal.id) {
    throw new TransactionRecoveryError(
      "adapter transaction journal filename does not match journal id",
      journalPath,
    );
  }
  const canonical = await canonicalProjectRoot(cwd);
  if (journal.project_root !== canonical) {
    throw new TransactionRecoveryError(
      "adapter transaction journal belongs to a different project root",
      journalPath,
    );
  }
  const seen = new Set<number>();
  const seenTargets = new Set<string>();
  for (const entry of journal.entries) {
    if (!isJournalEntryV2(entry)) {
      throw new TransactionRecoveryError(
        "adapter transaction journal is corrupt",
        journalPath,
      );
    }
    if (seen.has(entry.index)) {
      throw new TransactionRecoveryError(
        "adapter transaction journal has duplicate entry indexes",
        journalPath,
      );
    }
    if (entry.index >= journal.entries.length) {
      throw new TransactionRecoveryError(
        "adapter transaction journal has non-contiguous entry indexes",
        journalPath,
      );
    }
    seen.add(entry.index);
    if (seenTargets.has(entry.target_rel_path)) {
      throw new TransactionRecoveryError(
        "adapter transaction journal has duplicate target paths",
        journalPath,
      );
    }
    seenTargets.add(entry.target_rel_path);
    if (
      (entry.target_kind === "agent_profile" ||
        entry.target_kind === "adapter_manifest" ||
        entry.target_kind === "adapter_static_file" ||
        entry.target_kind === "adapter_dynamic_create") &&
      !journal.agent_name
    ) {
      throw new TransactionRecoveryError(
        "adapter transaction journal is missing agent_name",
        journalPath,
      );
    }
    if (
      entry.operation === "delete" &&
      entry.target_kind !== "adapter_static_file"
    ) {
      throw new TransactionRecoveryError(
        "adapter transaction journal has invalid delete target",
        journalPath,
      );
    }
    if (
      entry.target_kind === "adapter_dynamic_create" &&
      (entry.operation !== "write" || entry.pre_state.kind !== "absent")
    ) {
      throw new TransactionRecoveryError(
        "adapter transaction journal has invalid dynamic create state",
        journalPath,
      );
    }
    if (
      (entry.operation === "delete" && entry.post_state.kind !== "absent") ||
      (entry.operation === "write" && entry.post_state.kind !== "present")
    ) {
      throw new TransactionRecoveryError(
        "adapter transaction journal operation and post-state disagree",
        journalPath,
      );
    }
    try {
      assertSafeRelativePath(entry.target_rel_path);
      const paths = artifactPathsFor(cwd, journal.id, entry);
      if (
        relative(cwd, paths.finalPath).startsWith("..") ||
        relative(cwd, paths.tempPath).startsWith("..") ||
        relative(cwd, paths.backupPath).startsWith("..")
      ) {
        throw new Error("transaction artifact path escapes project root");
      }
    } catch (err) {
      throw new TransactionRecoveryError(
        `adapter transaction journal contains an unsafe path: ${(err as Error).message}`,
        journalPath,
      );
    }
  }
  return journal as AdapterTransactionJournalV2;
}

async function rollbackJournalToOldState(
  cwd: string,
  journal: AdapterTransactionJournalV2,
  opts: { allowTestOnlyTargets?: boolean } = {},
): Promise<string[]> {
  const failures: string[] = [];
  for (const entry of [...journal.entries].reverse()) {
    const paths = artifactPathsFor(cwd, journal.id, entry);
    try {
      await reconcileEntryToOldState(
        cwd,
        journal,
        paths,
        entry,
        opts.allowTestOnlyTargets === true,
      );
    } catch (err) {
      failures.push(`${entry.target_rel_path}: ${(err as Error).message}`);
    }
  }
  return failures;
}

async function cleanupCommittedJournal(
  cwd: string,
  journal: AdapterTransactionJournalV2,
): Promise<void> {
  const failures: string[] = [];
  for (const entry of journal.entries) {
    const paths = artifactPathsFor(cwd, journal.id, entry);
    try {
      await reconcileEntryToNewState(cwd, journal, paths, entry);
    } catch (err) {
      failures.push(`${entry.target_rel_path}: ${(err as Error).message}`);
    }
  }
  if (failures.length > 0) throw new Error(failures.join("; "));
}

async function reconcileEntryToOldState(
  cwd: string,
  journal: AdapterTransactionJournalV2,
  paths: { finalPath: string; tempPath: string; backupPath: string },
  entry: AdapterTransactionEntryV2,
  allowTestOnlyTarget: boolean,
): Promise<void> {
  await assertTransactionTargetStillOwned(
    cwd,
    journal,
    paths.finalPath,
    entry,
    allowTestOnlyTarget,
  );
  const finalState = await hashFile(paths.finalPath);
  const backupState = await hashFile(paths.backupPath);
  const tempState = await hashFile(paths.tempPath);

  if (entry.pre_state.kind === "present") {
    if (sameState(backupState, entry.pre_state)) {
      if (sameState(finalState, entry.post_state)) {
        await removeFileIfExists(paths.finalPath);
      } else if (
        finalState.kind !== "absent" &&
        !sameState(finalState, entry.pre_state)
      ) {
        throw new Error(
          `ambiguous final state ${stateLabel(finalState)} while backup holds pre-state`,
        );
      }
      await renameOwned(
        adapterDeletePath(paths.backupPath),
        adapterWritePath(paths.finalPath),
      );
    } else if (!sameState(finalState, entry.pre_state)) {
      throw new Error(
        `cannot restore old state; final=${stateLabel(finalState)} backup=${stateLabel(backupState)}`,
      );
    }
  } else {
    if (sameState(finalState, entry.post_state)) {
      await removeFileIfExists(paths.finalPath);
    } else if (finalState.kind !== "absent") {
      throw new Error(
        `ambiguous new-file final state ${stateLabel(finalState)}`,
      );
    }
  }

  if (entry.operation === "write" && sameState(tempState, entry.post_state)) {
    await removeFileIfExists(paths.tempPath);
  } else if (tempState.kind !== "absent") {
    throw new Error(
      `refusing to remove mismatched temp ${stateLabel(tempState)}`,
    );
  }
}

async function reconcileEntryToNewState(
  cwd: string,
  journal: AdapterTransactionJournalV2,
  paths: { finalPath: string; tempPath: string; backupPath: string },
  entry: AdapterTransactionEntryV2,
): Promise<void> {
  await assertTransactionTargetStillOwned(
    cwd,
    journal,
    paths.finalPath,
    entry,
    false,
  );
  const finalState = await hashFile(paths.finalPath);
  const backupState = await hashFile(paths.backupPath);
  const tempState = await hashFile(paths.tempPath);

  if (!sameState(finalState, entry.post_state)) {
    throw new Error(
      `committed final state mismatch: expected ${stateLabel(entry.post_state)}, got ${stateLabel(finalState)}`,
    );
  }
  if (entry.pre_state.kind === "present") {
    if (sameState(backupState, entry.pre_state)) {
      await removeFileIfExists(paths.backupPath);
    } else if (backupState.kind !== "absent") {
      throw new Error(
        `refusing to remove mismatched backup ${stateLabel(backupState)}`,
      );
    }
  }
  if (entry.operation === "write" && sameState(tempState, entry.post_state)) {
    await removeFileIfExists(paths.tempPath);
  } else if (tempState.kind !== "absent") {
    throw new Error(
      `refusing to remove mismatched temp ${stateLabel(tempState)}`,
    );
  }
}

async function assertTransactionTargetStillOwned(
  cwd: string,
  journal: AdapterTransactionJournalV2,
  finalPath: string,
  entry: AdapterTransactionEntryV2,
  allowTestOnlyTarget: boolean,
): Promise<void> {
  if (await pathTraversesSymlink(cwd, entry.target_rel_path)) {
    const err = new Error(
      `transaction target "${entry.target_rel_path}" resolves through a symlink`,
    );
    (err as NodeJS.ErrnoException).code = "PATH_NOT_OWNED";
    throw err;
  }
  if (entry.target_kind === "test_only") {
    if (allowTestOnlyTarget) return;
    throw new Error("test-only transaction targets are not recoverable");
  }

  const agentName = journal.agent_name;
  if (!agentName) {
    throw new Error("adapter transaction journal is missing agent_name");
  }

  if (entry.target_kind === "agent_profile") {
    const authorized = await resolveOwnedAgentProfilePath(cwd, agentName);
    if (unbrand(authorized) !== finalPath) {
      throw new Error(
        "adapter transaction target is not the authorized agent profile path",
      );
    }
    return;
  }

  if (entry.target_kind === "adapter_manifest") {
    const authorized = await resolveManifestPath(cwd, agentName);
    if (unbrand(authorized) !== finalPath) {
      throw new Error(
        "adapter transaction target is not the authorized manifest path",
      );
    }
    return;
  }

  if (entry.role === undefined) {
    throw new Error("adapter transaction journal entry is missing role");
  }
  const descriptor = adapterRegistry[agentName];
  const authority = await authorizeAdapterMutationPath(
    cwd,
    descriptor,
    entry.target_rel_path,
    {
      expectedRole: entry.role,
      declaredRole: entry.role,
      allowDynamicWrite: entry.target_kind === "adapter_dynamic_create",
    },
  );
  if (entry.target_kind === "adapter_static_file") {
    if (
      authority.kind !== "owned" ||
      unbrand(authority.absPath) !== finalPath
    ) {
      throw new Error(
        "adapter transaction target is not an authorized static adapter file",
      );
    }
    return;
  }
  if (
    entry.operation !== "write" ||
    entry.pre_state.kind !== "absent" ||
    authority.kind !== "dynamic_write" ||
    unbrand(authority.absPath) !== finalPath
  ) {
    throw new Error(
      "adapter transaction target is not an authorized dynamic create",
    );
  }
}

async function rejectLegacyProjectJournals(cwd: string): Promise<string[]> {
  const legacyDir = join(resolve(cwd), LEGACY_TRANSACTION_DIR_REL);
  try {
    await lstatOwned(adapterReadPath(legacyDir));
    return [LEGACY_REJECTION];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

export async function recoverPendingAdapterTransactions(
  cwd: string,
): Promise<AdapterTransactionRecoveryResult> {
  const rejected = await rejectLegacyProjectJournals(cwd);
  if (rejected.length > 0) {
    return { recovered: [], cleaned: [], rejected };
  }
  const stateDir = await adapterTransactionProjectDir(cwd);
  let names: string[];
  try {
    names = await listOwned(adapterReadPath(stateDir));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { recovered: [], cleaned: [], rejected };
    }
    throw err;
  }

  const recovered: string[] = [];
  const cleaned: string[] = [];
  for (const name of names.filter(
    n => UUID_V4_RE.test(n.replace(/\.json$/, "")) && n.endsWith(".json"),
  )) {
    const journalPath = join(stateDir, name);
    const journal = await loadJournal(resolve(cwd), journalPath);
    try {
      if (
        journal.status === "committed" ||
        journal.status === "cleanup_pending"
      ) {
        await cleanupCommittedJournal(resolve(cwd), journal);
        cleaned.push(journalPath);
      } else {
        const failures = await rollbackJournalToOldState(resolve(cwd), journal);
        if (failures.length > 0) throw new Error(failures.join("; "));
        recovered.push(journalPath);
      }
      await cleanupJournal(journalPath);
    } catch (err) {
      throw new TransactionRecoveryError(
        `adapter transaction recovery failed: ${(err as Error).message}`,
        journalPath,
      );
    }
  }
  return { recovered, cleaned, rejected };
}
