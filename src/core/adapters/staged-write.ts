import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
} from "../project-fs/index.ts";
import { randomUUID } from "node:crypto";
import { atomicWriteText } from "../../io/atomic-text.ts";
import { dirname, join, relative, resolve, sep } from "node:path";
import { resolveSymlinkFreeProjectPath } from "../path-safety.ts";

/**
 * Error code for a partial mutation: some files were committed but a later
 * rename failed. Backups are restored, but callers should treat the on-disk
 * state as inconsistent and surface this to the user.
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

interface StagedEntry {
  kind: "write" | "delete";
  tempPath: string;
  finalPath: string;
  backupPath: string;
  hadOriginal: boolean;
}

type JournalEntryState = "prepared" | "backup_done" | "final_done";

interface JournalEntry {
  kind: "write" | "delete";
  tempRelPath: string | null;
  finalRelPath: string;
  backupRelPath: string;
  hadOriginal: boolean;
  state: JournalEntryState;
}

interface TransactionJournal {
  schema_version: 1;
  id: string;
  status: "prepared" | "committed" | "cleanup_pending";
  entries: JournalEntry[];
  cleanup_failures?: string[];
}

export type AdapterTransactionRecoveryResult = {
  recovered: string[];
  cleaned: string[];
};

type FileTransactionOptions = {
  cwd?: string;
};

const TRANSACTION_DIR_REL = join(
  ".code-pact",
  "state",
  "adapter-transactions",
);

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

function toRel(cwd: string, absPath: string): string {
  const rel = relative(cwd, absPath).split(sep).join("/");
  if (rel.startsWith("../") || rel === ".." || rel.startsWith("/")) {
    throw new Error(`transaction path is outside cwd: ${absPath}`);
  }
  return rel;
}

async function fromRel(cwd: string, relPath: string): Promise<string> {
  return resolveSymlinkFreeProjectPath(cwd, relPath);
}

async function syncDirectory(dir: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(dir, "r");
    await handle.sync();
  } catch {
    // Directory fsync is not supported on every platform/filesystem.
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function durableWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${randomUUID()}`;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(tmp, "wx");
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(tmp, path);
    await syncDirectory(dirname(path));
  } catch (err) {
    await handle?.close().catch(() => {});
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

async function removeFileIfExists(path: string): Promise<void> {
  await unlink(path).catch(err => {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  });
}

async function cleanupJournal(path: string): Promise<void> {
  await removeFileIfExists(path);
  await syncDirectory(dirname(path));
}

/**
 * Best-effort multi-file transaction: stage all writes to temp files first,
 * stage deletes as backup renames, then commit the sequence. If any stage or
 * commit fails, rollback restores backups and deletes temp files best-effort.
 * A rollback failure is surfaced as PARTIAL_MUTATION evidence.
 *
 * Improvements over a bare temp-rename loop:
 *
 * - **Backup rename**: before overwriting an existing file, it is renamed to
 *   a `.bak-<uuid>` path. On rollback, backups are restored so the original
 *   content survives a failed commit.
 * - **Journal**: a JSON journal is written before commit begins, recording
 *   each staged operation. On successful commit, the journal is deleted. If
 *   a crash occurs mid-commit, the journal can be inspected for recovery.
 * - **PARTIAL_MUTATION**: if a rename or rollback fails after some files have
 *   already been committed, a `PartialMutationError` is thrown with committed
 *   paths, rollback failures, and any remaining backup paths.
 *
 * This does NOT protect against concurrent writers and is NOT a filesystem
 * CAS — a crash between the first and last rename leaves partial state (but
 * the journal records what happened). The manifest write (the "commit
 * record") happens AFTER `commit()` succeeds, so if the write loop fails,
 * the old manifest still reflects the old state.
 */
export class FileTransaction {
  private staged: StagedEntry[] = [];
  private finalPaths = new Set<string>();
  private journalPath: string | null = null;
  private transactionId = randomUUID();
  private state: "open" | "committing" | "committed" | "cleanup_pending" | "rolled_back" =
    "open";
  private cwd: string | null;

  constructor(options: FileTransactionOptions = {}) {
    this.cwd = options.cwd ? resolve(options.cwd) : null;
  }

  /**
   * Write `content` to a temp file in the same directory as `path`.
   * The temp file is created with an unpredictable name and exclusive create
   * semantics (via `atomicWriteText`). The parent directory is created if
   * missing.
   *
   * On failure, any previously staged temp files are NOT cleaned up here —
   * call `rollback()` to clean them all.
   */
  async stage(path: string, content: string): Promise<void> {
    this.assertCanStage(path);
    const tempPath = `${path}.staged-${randomUUID()}`;
    await atomicWriteText(tempPath, content);
    const tempStat = await stat(tempPath);
    if (!tempStat.isFile()) {
      await unlink(tempPath).catch(() => {});
      throw new Error(`staged temp path is not a regular file: ${tempPath}`);
    }
    this.staged.push({
      kind: "write",
      tempPath,
      finalPath: path,
      backupPath: `${path}.bak-${randomUUID()}`,
      hadOriginal: false,
    });
  }

  /**
   * Stage a delete as a commit-time backup rename. The target is not touched
   * until commit, so staging all writes can still fail without mutating state.
   */
  stageDelete(path: string): void {
    this.assertCanStage(path);
    this.staged.push({
      kind: "delete",
      tempPath: "",
      finalPath: path,
      backupPath: `${path}.bak-${randomUUID()}`,
      hadOriginal: false,
    });
  }

  /**
   * Rename all staged temp files to their final destinations.
   * Each rename is atomic. Before overwriting an existing file, it is
   * renamed to a backup path. On success, backups are deleted and the
   * journal is removed. On failure, backups are restored and temp files
   * are cleaned up.
   */
  async commit(): Promise<void> {
    if (this.staged.length === 0) return;
    if (this.state !== "open") {
      throw new Error("transaction has already been committed or rolled back");
    }
    this.state = "committing";

    const cwd = this.resolveCwd();
    await this.prepareEntries();

    this.journalPath = join(
      cwd,
      TRANSACTION_DIR_REL,
      `${this.transactionId}.json`,
    );
    const journal: TransactionJournal = {
      schema_version: 1,
      id: this.transactionId,
      status: "prepared",
      entries: this.staged.map(s => ({
        kind: s.kind,
        tempRelPath: s.kind === "write" ? toRel(cwd, s.tempPath) : null,
        finalRelPath: toRel(cwd, s.finalPath),
        backupRelPath: toRel(cwd, s.backupPath),
        hadOriginal: s.hadOriginal,
        state: "prepared",
      })),
    };
    await durableWriteJson(this.journalPath, journal);

    try {
      for (const [index, s] of this.staged.entries()) {
        if (s.hadOriginal) {
          await rename(s.finalPath, s.backupPath);
          journal.entries[index]!.state = "backup_done";
          await durableWriteJson(this.journalPath, journal);
        }
        if (s.kind === "write") {
          await rename(s.tempPath, s.finalPath);
        }
        journal.entries[index]!.state = "final_done";
        await durableWriteJson(this.journalPath, journal);
      }

      journal.status = "committed";
      await durableWriteJson(this.journalPath, journal);
      this.state = "committed";

      const cleanupFailures = await this.cleanupCommittedArtifacts();
      if (cleanupFailures.length > 0) {
        journal.status = "cleanup_pending";
        journal.cleanup_failures = cleanupFailures;
        await durableWriteJson(this.journalPath, journal);
        this.state = "cleanup_pending";
        throw new TransactionCleanupPendingError(
          `Transaction committed, but cleanup is pending: ${cleanupFailures.join("; ")}`,
          this.journalPath,
          cleanupFailures,
          this.staged.map(s => s.backupPath),
        );
      }

      await cleanupJournal(this.journalPath);
      this.journalPath = null;
    } catch (err) {
      if (this.state === "committed" || this.state === "cleanup_pending") {
        throw err;
      }
      const rollbackFailures = await this.rollbackPreparedEntries();
      await this.cleanupUncommittedTemps();
      if (this.journalPath && rollbackFailures.length === 0) {
        await cleanupJournal(this.journalPath).catch(() => {});
        this.journalPath = null;
      }
      const mutated = journal.entries.filter(e => e.state !== "prepared");
      if (mutated.length > 0 || rollbackFailures.length > 0) {
        throw new PartialMutationError(
          `Transaction failed after mutating ${mutated.length} operation(s): ${(err as Error).message}`,
          mutated.map(e => resolve(cwd, e.finalRelPath)),
          rollbackFailures,
          this.staged
            .map(s => s.backupPath),
        );
      }
      throw err;
    }
  }

  /**
   * Delete all staged temp files and restore any remaining backups.
   * Best-effort: errors are swallowed so rollback never masks the original
   * failure.
   */
  async rollback(): Promise<void> {
    if (this.state === "committed" || this.state === "cleanup_pending") {
      return;
    }
    for (const s of this.staged) {
      if (s.kind === "write") await unlink(s.tempPath).catch(() => {});
      await rename(s.backupPath, s.finalPath).catch(() => {});
    }
    if (this.journalPath) {
      await cleanupJournal(this.journalPath).catch(() => {});
      this.journalPath = null;
    }
    this.state = "rolled_back";
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

  private resolveCwd(): string {
    if (this.cwd) return this.cwd;
    this.cwd = dirname(this.staged[0]!.finalPath);
    return this.cwd;
  }

  private async prepareEntries(): Promise<void> {
    for (const s of this.staged) {
      if (await pathExists(s.backupPath)) {
        throw new Error(`backup path already exists: ${s.backupPath}`);
      }
      try {
        const st = await stat(s.finalPath);
        if (st.isDirectory()) {
          throw new Error(`transaction target is a directory: ${s.finalPath}`);
        }
        if (!st.isFile()) {
          throw new Error(`transaction target is not a regular file: ${s.finalPath}`);
        }
        s.hadOriginal = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        s.hadOriginal = false;
      }
      if (s.kind === "write") {
        const tempStat = await stat(s.tempPath);
        if (!tempStat.isFile()) {
          throw new Error(`staged temp path is not a regular file: ${s.tempPath}`);
        }
      }
    }
  }

  private async cleanupCommittedArtifacts(): Promise<string[]> {
    const failures: string[] = [];
    for (const s of this.staged) {
      if (s.hadOriginal) {
        try {
          await unlink(s.backupPath);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            failures.push(`${s.backupPath}: ${(err as Error).message}`);
          }
        }
      }
      if (s.kind === "write") {
        try {
          await unlink(s.tempPath);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            failures.push(`${s.tempPath}: ${(err as Error).message}`);
          }
        }
      }
    }
    return failures;
  }

  private async rollbackPreparedEntries(): Promise<string[]> {
    const failures: string[] = [];
    for (const s of [...this.staged].reverse()) {
      try {
        if (s.kind === "write") {
          await unlink(s.finalPath).catch(err => {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
          });
        }
        if (s.hadOriginal) {
          await rename(s.backupPath, s.finalPath);
        }
      } catch (rollbackErr) {
        failures.push(`${s.finalPath}: ${(rollbackErr as Error).message}`);
      }
    }
    return failures;
  }

  private async cleanupUncommittedTemps(): Promise<void> {
    for (const s of this.staged) {
      if (s.kind === "write") await unlink(s.tempPath).catch(() => {});
    }
  }
}

function isJournalEntry(value: unknown): value is JournalEntry {
  const entry = value as Partial<JournalEntry>;
  return (
    (entry.kind === "write" || entry.kind === "delete") &&
    (typeof entry.tempRelPath === "string" || entry.tempRelPath === null) &&
    typeof entry.finalRelPath === "string" &&
    typeof entry.backupRelPath === "string" &&
    typeof entry.hadOriginal === "boolean" &&
    (entry.state === "prepared" ||
      entry.state === "backup_done" ||
      entry.state === "final_done")
  );
}

async function loadJournal(cwd: string, journalPath: string): Promise<TransactionJournal> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(journalPath, "utf8"));
  } catch (err) {
    throw new TransactionRecoveryError(
      `cannot read adapter transaction journal: ${(err as Error).message}`,
      journalPath,
    );
  }
  const journal = parsed as Partial<TransactionJournal>;
  if (
    journal.schema_version !== 1 ||
    typeof journal.id !== "string" ||
    (journal.status !== "prepared" &&
      journal.status !== "committed" &&
      journal.status !== "cleanup_pending") ||
    !Array.isArray(journal.entries)
  ) {
    throw new TransactionRecoveryError(
      "adapter transaction journal is corrupt",
      journalPath,
    );
  }
  for (const entry of journal.entries) {
    if (!isJournalEntry(entry)) {
      throw new TransactionRecoveryError(
        "adapter transaction journal is corrupt",
        journalPath,
      );
    }
    try {
      await fromRel(cwd, entry.finalRelPath);
      await fromRel(cwd, entry.backupRelPath);
      if (entry.tempRelPath !== null) await fromRel(cwd, entry.tempRelPath);
    } catch (err) {
      throw new TransactionRecoveryError(
        `adapter transaction journal contains an unsafe path: ${(err as Error).message}`,
        journalPath,
      );
    }
  }
  return journal as TransactionJournal;
}

async function rollbackJournal(cwd: string, journal: TransactionJournal): Promise<void> {
  const failures: string[] = [];
  for (const entry of [...journal.entries].reverse()) {
    const finalPath = await fromRel(cwd, entry.finalRelPath);
    const backupPath = await fromRel(cwd, entry.backupRelPath);
    const tempPath =
      entry.tempRelPath !== null ? await fromRel(cwd, entry.tempRelPath) : null;
    try {
      if (entry.kind === "write" && entry.state === "final_done") {
        await removeFileIfExists(finalPath);
      }
      if (entry.hadOriginal && entry.state !== "prepared") {
        await rename(backupPath, finalPath);
      }
      if (tempPath !== null) await removeFileIfExists(tempPath);
    } catch (err) {
      failures.push(`${entry.finalRelPath}: ${(err as Error).message}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(failures.join("; "));
  }
}

async function cleanupCommittedJournal(
  cwd: string,
  journal: TransactionJournal,
): Promise<void> {
  const failures: string[] = [];
  for (const entry of journal.entries) {
    const backupPath = await fromRel(cwd, entry.backupRelPath);
    const tempPath =
      entry.tempRelPath !== null ? await fromRel(cwd, entry.tempRelPath) : null;
    try {
      if (entry.hadOriginal) await removeFileIfExists(backupPath);
      if (tempPath !== null) await removeFileIfExists(tempPath);
    } catch (err) {
      failures.push(`${entry.finalRelPath}: ${(err as Error).message}`);
    }
  }
  if (failures.length > 0) throw new Error(failures.join("; "));
}

export async function recoverPendingAdapterTransactions(
  cwd: string,
): Promise<AdapterTransactionRecoveryResult> {
  const stateDir = join(resolve(cwd), TRANSACTION_DIR_REL);
  let names: string[];
  try {
    names = await readdir(stateDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { recovered: [], cleaned: [] };
    }
    throw err;
  }

  const recovered: string[] = [];
  const cleaned: string[] = [];
  for (const name of names.filter(n => n.endsWith(".json"))) {
    const journalPath = join(stateDir, name);
    const journal = await loadJournal(resolve(cwd), journalPath);
    try {
      if (journal.status === "committed" || journal.status === "cleanup_pending") {
        await cleanupCommittedJournal(resolve(cwd), journal);
        cleaned.push(journalPath);
      } else {
        await rollbackJournal(resolve(cwd), journal);
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
  return { recovered, cleaned };
}
