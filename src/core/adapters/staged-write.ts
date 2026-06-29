import { rename, unlink } from "../project-fs/index.ts";
import { randomUUID } from "node:crypto";
import { atomicWriteText } from "../../io/atomic-text.ts";

/**
 * Best-effort multi-file transaction: stage all writes to temp files first,
 * then commit (rename) all at once. If any stage or commit fails, rollback
 * deletes the temp files so no partial state remains on disk.
 *
 * This does NOT protect against concurrent writers (same limitation as
 * `atomicWriteText`) and is NOT a filesystem CAS — a crash between the first
 * and last rename leaves partial state. But it does ensure that a write
 * failure mid-loop does not leave some files written and others not, which
 * would diverge the on-disk state from the manifest.
 *
 * The manifest write (the "commit record") happens AFTER `commit()` succeeds,
 * so if the write loop fails, the old manifest still reflects the old state.
 */
export class FileTransaction {
  private staged: Array<{ tempPath: string; finalPath: string }> = [];

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
    this.staged.push({ tempPath, finalPath: path });
  }

  /**
   * Rename all staged temp files to their final destinations.
   * Each rename is atomic. If a rename fails, the remaining temp files are
   * best-effort cleaned up and the error is re-thrown.
   */
  async commit(): Promise<void> {
    const committed: string[] = [];
    try {
      for (const s of this.staged) {
        await rename(s.tempPath, s.finalPath);
        committed.push(s.finalPath);
      }
    } catch (err) {
      // Best-effort: clean up any remaining temp files.
      await this.rollback();
      throw err;
    }
  }

  /**
   * Delete all staged temp files. Best-effort: errors are swallowed so
   * rollback never masks the original failure.
   */
  async rollback(): Promise<void> {
    for (const s of this.staged) {
      await unlink(s.tempPath).catch(() => {});
    }
  }
}
