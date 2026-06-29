import { rename, unlink, stat, writeFile } from "../project-fs/index.ts";
import { randomUUID } from "node:crypto";
import { atomicWriteText } from "../../io/atomic-text.ts";
import { dirname, join } from "node:path";

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

interface StagedEntry {
  kind: "write" | "delete";
  tempPath: string;
  finalPath: string;
  backupPath: string | null;
}

interface JournalEntry {
  kind: "write" | "delete";
  tempPath: string;
  finalPath: string;
  backupPath: string | null;
  committed: boolean;
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
  private journalPath: string | null = null;

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
    const tempPath = `${path}.staged-${randomUUID()}`;
    await atomicWriteText(tempPath, content);
    this.staged.push({
      kind: "write",
      tempPath,
      finalPath: path,
      backupPath: null,
    });
  }

  /**
   * Stage a delete as a commit-time backup rename. The target is not touched
   * until commit, so staging all writes can still fail without mutating state.
   */
  stageDelete(path: string): void {
    this.staged.push({
      kind: "delete",
      tempPath: "",
      finalPath: path,
      backupPath: null,
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

    // Write journal before starting commit.
    this.journalPath = join(
      dirname(this.staged[0]!.finalPath),
      `.code-pact-txn-${randomUUID()}.journal`,
    );
    const journalEntries: JournalEntry[] = this.staged.map(s => ({
      kind: s.kind,
      tempPath: s.tempPath,
      finalPath: s.finalPath,
      backupPath: s.backupPath,
      committed: false,
    }));
    await writeFile(this.journalPath, JSON.stringify(journalEntries), "utf8");

    const committed: StagedEntry[] = [];
    try {
      for (const s of this.staged) {
        // Backup existing file before overwriting.
        try {
          await stat(s.finalPath);
          s.backupPath = `${s.finalPath}.bak-${randomUUID()}`;
          await rename(s.finalPath, s.backupPath);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
        if (s.kind === "write") {
          await rename(s.tempPath, s.finalPath);
        }
        committed.push(s);
        // Update journal entry.
        const entry = journalEntries.find(e => e.finalPath === s.finalPath);
        if (entry) {
          entry.committed = true;
          entry.backupPath = s.backupPath;
          await writeFile(
            this.journalPath,
            JSON.stringify(journalEntries),
            "utf8",
          );
        }
      }
      for (const s of this.staged) {
        if (s.backupPath) {
          await unlink(s.backupPath);
          s.backupPath = null;
        }
        if (s.kind === "write") {
          await unlink(s.tempPath).catch(() => {});
        }
      }
      // Clean up journal on success.
      if (this.journalPath) {
        await unlink(this.journalPath).catch(() => {});
        this.journalPath = null;
      }
    } catch (err) {
      const rollbackFailures = await this.rollbackCommitted(committed);
      await this.cleanupUncommittedTemps(committed);
      // Clean up journal.
      if (this.journalPath) {
        await unlink(this.journalPath).catch(() => {});
        this.journalPath = null;
      }
      if (committed.length > 0) {
        throw new PartialMutationError(
          `Transaction failed after committing ${committed.length} operation(s): ${(err as Error).message}`,
          committed.map(s => s.finalPath),
          rollbackFailures,
          this.staged
            .map(s => s.backupPath)
            .filter((p): p is string => p !== null),
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
    for (const s of this.staged) {
      if (s.kind === "write") await unlink(s.tempPath).catch(() => {});
      if (s.backupPath) {
        await rename(s.backupPath, s.finalPath).catch(() => {});
        s.backupPath = null;
      }
    }
    if (this.journalPath) {
      await unlink(this.journalPath).catch(() => {});
      this.journalPath = null;
    }
  }

  private async rollbackCommitted(
    committed: readonly StagedEntry[],
  ): Promise<string[]> {
    const failures: string[] = [];
    for (const s of [...committed].reverse()) {
      try {
        if (s.kind === "write") {
          await unlink(s.finalPath).catch(err => {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
          });
        }
        if (s.backupPath) {
          await rename(s.backupPath, s.finalPath);
          s.backupPath = null;
        }
      } catch (rollbackErr) {
        failures.push(`${s.finalPath}: ${(rollbackErr as Error).message}`);
      }
    }
    return failures;
  }

  private async cleanupUncommittedTemps(
    committed: readonly StagedEntry[],
  ): Promise<void> {
    const committedSet = new Set(committed);
    for (const s of this.staged) {
      if (committedSet.has(s)) continue;
      if (s.kind === "write") await unlink(s.tempPath).catch(() => {});
      if (s.backupPath) {
        await rename(s.backupPath, s.finalPath).catch(() => {});
        s.backupPath = null;
      }
    }
  }
}
