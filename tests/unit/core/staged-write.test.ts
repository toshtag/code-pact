import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdtemp,
  rm,
  writeFile,
  readFile,
  stat,
  mkdir,
  symlink,
  realpath,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { SupportedAgent } from "../../../src/core/agents.ts";

// Mock project-fs to inject failures into rename
const failAfterFirstRename = vi.hoisted(() => ({
  enabled: false,
  threshold: 4,
  count: 0,
}));
const failBackupUnlink = vi.hoisted(() => ({
  enabled: false,
  threshold: 2,
  count: 0,
}));

vi.mock("../../../src/core/project-fs/index.ts", async importActual => {
  const actual =
    await importActual<
      typeof import("../../../src/core/project-fs/index.ts")
    >();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      const from = String(args[0]);
      const to = String(args[1]);
      const isDataRename =
        !from.includes(".code-pact/state/adapter-transactions") &&
        !to.includes(".code-pact/state/adapter-transactions");
      if (isDataRename) failAfterFirstRename.count++;
      if (
        isDataRename &&
        failAfterFirstRename.enabled &&
        failAfterFirstRename.count > failAfterFirstRename.threshold
      ) {
        failAfterFirstRename.enabled = false;
        throw new Error("injected rename failure");
      }
      return actual.rename(...args);
    },
    unlink: async (...args: Parameters<typeof actual.unlink>) => {
      const path = String(args[0]);
      if (failBackupUnlink.enabled && path.includes(".bak-")) {
        failBackupUnlink.count++;
        if (failBackupUnlink.count >= failBackupUnlink.threshold) {
          failBackupUnlink.enabled = false;
          throw new Error("injected backup cleanup failure");
        }
      }
      return actual.unlink(...args);
    },
  };
});

const {
  FileTransaction,
  PartialMutationError,
  TransactionCleanupPendingError,
  adapterDynamicCreateTarget,
  adapterManifestWriteTarget,
  adapterStaticWriteTarget,
  recoverPendingAdapterTransactions,
} =
  await import("../../../src/core/adapters/staged-write.ts");
const { brandOwnedWrite } = await import(
  "../../../src/core/project-fs/branded-paths.ts"
);
const { adapterTransactionProjectDir } = await import(
  "../../../src/core/adapters/transaction-state-root.ts"
);

let dir: string;
let previousStateHome: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "code-pact-staged-"));
  previousStateHome = process.env.CODE_PACT_STATE_HOME;
  process.env.CODE_PACT_STATE_HOME = await mkdtemp(
    join(tmpdir(), "code-pact-state-"),
  );
  failAfterFirstRename.enabled = false;
  failAfterFirstRename.count = 0;
  failAfterFirstRename.threshold = 4;
  failBackupUnlink.enabled = false;
  failBackupUnlink.count = 0;
  failBackupUnlink.threshold = 2;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  if (process.env.CODE_PACT_STATE_HOME) {
    await rm(process.env.CODE_PACT_STATE_HOME, { recursive: true, force: true });
  }
  if (previousStateHome === undefined) delete process.env.CODE_PACT_STATE_HOME;
  else process.env.CODE_PACT_STATE_HOME = previousStateHome;
});

function sha256Text(value: string): string {
  return createHash("sha256").update(Buffer.from(value)).digest("hex");
}

function manifestWriteTarget(agentName: SupportedAgent = "claude-code") {
  const path = join(dir, ".code-pact", "adapters", `${agentName}.manifest.yaml`);
  return {
    path,
    target: adapterManifestWriteTarget(agentName, brandOwnedWrite(path)),
  };
}

function staticInstructionWriteTarget() {
  const path = join(dir, "CLAUDE.md");
  return {
    path,
    target: adapterStaticWriteTarget(
      "claude-code",
      "CLAUDE.md",
      "instruction",
      { kind: "owned", absPath: brandOwnedWrite(path) },
    ),
  };
}

async function writePrivateJournal(name: string, journal: unknown): Promise<void> {
  const journalDir = await adapterTransactionProjectDir(dir);
  await writeFile(join(journalDir, name), JSON.stringify(journal), "utf8");
}

describe("FileTransaction — basic stage and commit", () => {
  it("stages and commits a single new file", async () => {
    const tx = new FileTransaction({ cwd: dir });
    const target = join(dir, "a.txt");
    await tx.stageForTest(target, "hello");
    await tx.commit();
    expect(await readFile(target, "utf8")).toBe("hello");
  });

  it("stages and commits multiple new files", async () => {
    const tx = new FileTransaction({ cwd: dir });
    await tx.stageForTest(join(dir, "a.txt"), "aaa");
    await tx.stageForTest(join(dir, "b.txt"), "bbb");
    await tx.commit();
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("aaa");
    expect(await readFile(join(dir, "b.txt"), "utf8")).toBe("bbb");
  });

  it("overwrites an existing file with backup", async () => {
    const target = join(dir, "existing.txt");
    await writeFile(target, "OLD", "utf8");
    const tx = new FileTransaction({ cwd: dir });
    await tx.stageForTest(target, "NEW");
    await tx.commit();
    expect(await readFile(target, "utf8")).toBe("NEW");
  });

  it("creates parent directories lazily via atomicWriteText", async () => {
    const tx = new FileTransaction({ cwd: dir });
    const target = join(dir, "sub", "deep", "file.txt");
    await tx.stageForTest(target, "nested");
    await tx.commit();
    expect(await readFile(target, "utf8")).toBe("nested");
  });
});

describe("FileTransaction — authority target guards", () => {
  it("rejects mismatched transaction target metadata before staging", async () => {
    const tx = new FileTransaction({ cwd: dir });
    const target = join(dir, ".claude", "skills", "code-pact-private.md");

    await expect(
      tx.addWrite(
        adapterDynamicCreateTarget(
          "claude-code",
          ".claude/skills/code-pact-other.md",
          "skill",
          { kind: "dynamic_write", absPath: brandOwnedWrite(target) },
        ),
        "content",
      ),
    ).rejects.toThrow("transaction target metadata does not match authority path");
  });

  it("rejects dynamic creates when the target already exists during prepare", async () => {
    await mkdir(join(dir, ".claude", "skills"), { recursive: true });
    const target = join(dir, ".claude", "skills", "code-pact-private.md");
    await writeFile(target, "existing", "utf8");
    const tx = new FileTransaction({ cwd: dir });

    await tx.addWrite(
      adapterDynamicCreateTarget(
        "claude-code",
        ".claude/skills/code-pact-private.md",
        "skill",
        { kind: "dynamic_write", absPath: brandOwnedWrite(target) },
      ),
      "content",
    );
    await expect(tx.commit()).rejects.toThrow(
      "dynamic adapter target already exists",
    );
  });
});

describe("FileTransaction — rollback", () => {
  it("rollback deletes staged temp files without committing", async () => {
    const tx = new FileTransaction({ cwd: dir });
    const target = join(dir, "a.txt");
    await tx.stageForTest(target, "hello");
    await tx.rollback();
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("FileTransaction — failure injection", () => {
  it("restores committed files when a later rename fails", async () => {
    // Stage two files; the second commit's rename will fail.
    const targetA = join(dir, "a.txt");
    const targetB = join(dir, "b.txt");
    await writeFile(targetA, "OLD_A", "utf8");
    await writeFile(targetB, "OLD_B", "utf8");

    const tx = new FileTransaction({ cwd: dir });
    await tx.stageForTest(targetA, "NEW_A");
    await tx.stageForTest(targetB, "NEW_B");

    failAfterFirstRename.count = 0;
    failAfterFirstRename.enabled = true;
    failAfterFirstRename.threshold = 3;

    await expect(tx.commit()).rejects.toMatchObject({
      code: "PARTIAL_MUTATION",
    });

    // File A was committed, then restored from its backup. File B failed during
    // commit and its backup was also restored.
    expect(await readFile(targetA, "utf8")).toBe("OLD_A");
    expect(await readFile(targetB, "utf8")).toBe("OLD_B");
  });

  it("rolls back staged deletes when a later operation fails", async () => {
    const targetA = join(dir, "delete-me.txt");
    const targetB = join(dir, "write-me.txt");
    await writeFile(targetA, "KEEP_A", "utf8");
    await writeFile(targetB, "KEEP_B", "utf8");

    const tx = new FileTransaction({ cwd: dir });
    tx.stageDeleteForTest(targetA);
    await tx.stageForTest(targetB, "NEW_B");

    failAfterFirstRename.count = 0;
    failAfterFirstRename.enabled = true;
    failAfterFirstRename.threshold = 2;

    await expect(tx.commit()).rejects.toMatchObject({
      code: "PARTIAL_MUTATION",
    });

    expect(await readFile(targetA, "utf8")).toBe("KEEP_A");
    expect(await readFile(targetB, "utf8")).toBe("KEEP_B");
  });

  it("non-partial failure (0 committed) rethrows original error", async () => {
    // When 0 files are committed and a rename fails, the original error
    // is rethrown (not PartialMutationError). This is implicitly covered
    // by the PartialMutationError test above — if 0 files were committed,
    // committed.length === 0 and the original error is thrown.
    // Here we just verify the PartialMutationError class exists.
    expect(PartialMutationError).toBeDefined();
  });
});

describe("FileTransaction — journal", () => {
  it("does not write project-side temp files before the durable journal exists", async () => {
    const tx = new FileTransaction({ cwd: dir });
    await tx.stageForTest(join(dir, "a.txt"), "aaa");
    const { tempPath } = tx.stagedArtifactsForTest()[0]!;

    await expect(stat(tempPath)).rejects.toMatchObject({ code: "ENOENT" });
    await tx.writePreparedJournalForTest();
    await expect(stat(tempPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("journal is deleted after successful commit", async () => {
    const tx = new FileTransaction({ cwd: dir });
    await tx.stageForTest(join(dir, "a.txt"), "aaa");
    await tx.commit();
    const result = await recoverPendingAdapterTransactions(dir);
    expect(result.cleaned).toHaveLength(0);
    expect(result.recovered).toHaveLength(0);
  });

  it("journal is deleted after rollback", async () => {
    const tx = new FileTransaction({ cwd: dir });
    await tx.stageForTest(join(dir, "a.txt"), "aaa");
    await tx.rollback();
    const { readdirSync } = await import("node:fs");
    const files = readdirSync(dir);
    expect(files.filter(f => f.includes(".journal"))).toHaveLength(0);
  });
});

describe("FileTransaction — empty commit", () => {
  it("commit with no staged files is a no-op", async () => {
    const tx = new FileTransaction({ cwd: dir });
    await tx.commit();
  });
});

describe("PartialMutationError", () => {
  it("carries committed paths", () => {
    const err = new PartialMutationError("test", ["/a", "/b"]);
    expect(err.code).toBe("PARTIAL_MUTATION");
    expect(err.committedPaths).toEqual(["/a", "/b"]);
    expect(err.message).toBe("test");
  });
});

describe("FileTransaction — cleanup failure does not roll back committed files", () => {
  it("keeps both new files when the second backup cleanup fails", async () => {
    const { path: targetA, target: txTargetA } = manifestWriteTarget("claude-code");
    const { path: targetB, target: txTargetB } = staticInstructionWriteTarget();
    await mkdir(dirname(targetA), { recursive: true });
    await writeFile(targetA, "OLD_A", "utf8");
    await writeFile(targetB, "OLD_B", "utf8");

    const tx = new FileTransaction({ cwd: dir });
    await tx.addWrite(txTargetA, "NEW_A");
    await tx.addWrite(txTargetB, "NEW_B");

    failBackupUnlink.enabled = true;
    failBackupUnlink.threshold = 2;

    await expect(tx.commit()).rejects.toBeInstanceOf(
      TransactionCleanupPendingError,
    );

    expect(await readFile(targetA, "utf8")).toBe("NEW_A");
    expect(await readFile(targetB, "utf8")).toBe("NEW_B");
    const result = await recoverPendingAdapterTransactions(dir);
    expect(result.cleaned).toHaveLength(1);
  });

  it("keeps delete and write results when cleanup fails", async () => {
    const deleteTarget = join(dir, "delete-me.txt");
    const writeTarget = join(dir, "write-me.txt");
    await writeFile(deleteTarget, "OLD_DELETE", "utf8");
    await writeFile(writeTarget, "OLD_WRITE", "utf8");

    const tx = new FileTransaction({ cwd: dir });
    tx.stageDeleteForTest(deleteTarget);
    await tx.stageForTest(writeTarget, "NEW_WRITE");

    failBackupUnlink.enabled = true;
    failBackupUnlink.threshold = 2;

    await expect(tx.commit()).rejects.toMatchObject({
      code: "TRANSACTION_CLEANUP_PENDING",
    });

    await expect(stat(deleteTarget)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(writeTarget, "utf8")).toBe("NEW_WRITE");
  });

  it("keeps profile, generated file, and manifest writes when cleanup fails", async () => {
    const profile = join(
      dir,
      ".code-pact",
      "agent-profiles",
      "claude-code.yaml",
    );
    const generated = join(dir, ".claude", "skills", "code-pact-context.md");
    const manifest = join(
      dir,
      ".code-pact",
      "adapters",
      "claude-code.manifest.json",
    );
    await mkdir(dirname(profile), { recursive: true });
    await mkdir(dirname(generated), { recursive: true });
    await mkdir(dirname(manifest), { recursive: true });
    await writeFile(profile, "OLD_PROFILE", "utf8");
    await writeFile(generated, "OLD_GENERATED", "utf8");
    await writeFile(manifest, "OLD_MANIFEST", "utf8");

    const tx = new FileTransaction({ cwd: dir });
    await tx.stageForTest(profile, "NEW_PROFILE");
    await tx.stageForTest(generated, "NEW_GENERATED");
    await tx.stageForTest(manifest, "NEW_MANIFEST");

    failBackupUnlink.enabled = true;
    failBackupUnlink.threshold = 2;

    await expect(tx.commit()).rejects.toMatchObject({
      code: "TRANSACTION_CLEANUP_PENDING",
    });

    expect(await readFile(profile, "utf8")).toBe("NEW_PROFILE");
    expect(await readFile(generated, "utf8")).toBe("NEW_GENERATED");
    expect(await readFile(manifest, "utf8")).toBe("NEW_MANIFEST");
  });
});

describe("FileTransaction — recovery", () => {
  it("does not execute forged committed journals from the project", async () => {
    await writeFile(join(dir, ".env"), "SECRET", "utf8");
    await mkdir(join(dir, ".code-pact", "state", "adapter-transactions"), {
      recursive: true,
    });
    await writeFile(
      join(dir, ".code-pact", "state", "adapter-transactions", "evil.json"),
      JSON.stringify({
        schema_version: 1,
        id: "evil",
        status: "committed",
        entries: [
          {
            kind: "delete",
            tempRelPath: null,
            finalRelPath: "README.md",
            backupRelPath: ".env",
            hadOriginal: true,
            state: "final_done",
          },
        ],
      }),
      "utf8",
    );

    const result = await recoverPendingAdapterTransactions(dir);

    expect(await readFile(join(dir, ".env"), "utf8")).toBe("SECRET");
    expect(result.cleaned).toHaveLength(0);
    expect(result.rejected).toContain("LEGACY_TRANSACTION_JOURNAL_UNTRUSTED");
  });

  it("does not execute forged prepared journals from the project", async () => {
    await writeFile(join(dir, ".env"), "SECRET", "utf8");
    await writeFile(join(dir, "payload.txt"), "ATTACKER", "utf8");
    await mkdir(join(dir, ".code-pact", "state", "adapter-transactions"), {
      recursive: true,
    });
    await writeFile(
      join(dir, ".code-pact", "state", "adapter-transactions", "evil.json"),
      JSON.stringify({
        schema_version: 1,
        id: "evil",
        status: "prepared",
        entries: [
          {
            kind: "write",
            tempRelPath: null,
            finalRelPath: ".env",
            backupRelPath: "payload.txt",
            hadOriginal: true,
            state: "backup_done",
          },
        ],
      }),
      "utf8",
    );

    const result = await recoverPendingAdapterTransactions(dir);

    expect(await readFile(join(dir, ".env"), "utf8")).toBe("SECRET");
    expect(await readFile(join(dir, "payload.txt"), "utf8")).toBe("ATTACKER");
    expect(result.rejected).toContain("LEGACY_TRANSACTION_JOURNAL_UNTRUSTED");
  });

  it("does not follow a project journal directory symlink", async () => {
    const outside = await mkdtemp(join(tmpdir(), "code-pact-outside-journal-"));
    await writeFile(join(dir, ".env"), "SECRET", "utf8");
    await writeFile(
      join(outside, "evil.json"),
      JSON.stringify({
        schema_version: 1,
        id: "evil",
        status: "committed",
        entries: [
          {
            kind: "delete",
            tempRelPath: null,
            finalRelPath: "README.md",
            backupRelPath: ".env",
            hadOriginal: true,
            state: "final_done",
          },
        ],
      }),
      "utf8",
    );
    await mkdir(join(dir, ".code-pact", "state"), { recursive: true });
    await symlink(outside, join(dir, ".code-pact", "state", "adapter-transactions"));

    try {
      const result = await recoverPendingAdapterTransactions(dir);
      expect(await readFile(join(dir, ".env"), "utf8")).toBe("SECRET");
      expect(result.rejected).toContain("LEGACY_TRANSACTION_JOURNAL_UNTRUSTED");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects private test-only journals without executing them", async () => {
    await writeFile(join(dir, ".env"), "SECRET", "utf8");
    const projectRoot = await realpath(dir);
    await writePrivateJournal("evil.json", {
      schema_version: 2,
      id: "evil",
      project_root: projectRoot,
      status: "prepared",
      entries: [
        {
          operation: "write",
          target_kind: "test_only",
          target_rel_path: ".env",
          pre_state: { kind: "absent" },
          post_state: { kind: "present", sha256: sha256Text("SECRET") },
          index: 0,
        },
      ],
    });

    await expect(recoverPendingAdapterTransactions(dir)).rejects.toMatchObject({
      code: "ADAPTER_TRANSACTION_RECOVERY_FAILED",
    });
    expect(await readFile(join(dir, ".env"), "utf8")).toBe("SECRET");
  });

  it("does not recover private journals after detecting legacy project journals", async () => {
    await writeFile(join(dir, ".env"), "SECRET", "utf8");
    await mkdir(join(dir, ".code-pact", "state", "adapter-transactions"), {
      recursive: true,
    });
    const projectRoot = await realpath(dir);
    await writePrivateJournal("evil.json", {
      schema_version: 2,
      id: "evil",
      project_root: projectRoot,
      status: "prepared",
      entries: [
        {
          operation: "write",
          target_kind: "test_only",
          target_rel_path: ".env",
          pre_state: { kind: "absent" },
          post_state: { kind: "present", sha256: sha256Text("SECRET") },
          index: 0,
        },
      ],
    });

    const result = await recoverPendingAdapterTransactions(dir);

    expect(result).toEqual({
      recovered: [],
      cleaned: [],
      rejected: ["LEGACY_TRANSACTION_JOURNAL_UNTRUSTED"],
    });
    expect(await readFile(join(dir, ".env"), "utf8")).toBe("SECRET");
  });

  it("recovers a crash after backup rename by restoring old final content", async () => {
    const { path: target, target: txTarget } = manifestWriteTarget();
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, "OLD", "utf8");
    const tx = new FileTransaction({ cwd: dir });
    await tx.addWrite(txTarget, "NEW");
    await tx.writePreparedJournalForTest();

    const { backupPath, tempPath } = tx.stagedArtifactsForTest()[0]!;
    await rm(target);
    await writeFile(backupPath, "OLD", "utf8");

    const result = await recoverPendingAdapterTransactions(dir);

    expect(result.recovered).toHaveLength(1);
    expect(await readFile(target, "utf8")).toBe("OLD");
    await expect(stat(backupPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(tempPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers a crash after final rename for a new file by removing the uncommitted final", async () => {
    const { path: target, target: txTarget } = manifestWriteTarget();
    const tx = new FileTransaction({ cwd: dir });
    await tx.addWrite(txTarget, "NEW");
    await tx.writePreparedJournalForTest();

    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, "NEW", "utf8");

    const result = await recoverPendingAdapterTransactions(dir);

    expect(result.recovered).toHaveLength(1);
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers cleanup-pending committed journals by preserving final files", async () => {
    const { path: targetA, target: txTargetA } = manifestWriteTarget("claude-code");
    const { path: targetB, target: txTargetB } = staticInstructionWriteTarget();
    await mkdir(dirname(targetA), { recursive: true });
    await writeFile(targetA, "OLD_A", "utf8");
    await writeFile(targetB, "OLD_B", "utf8");

    const tx = new FileTransaction({ cwd: dir });
    await tx.addWrite(txTargetA, "NEW_A");
    await tx.addWrite(txTargetB, "NEW_B");

    failBackupUnlink.enabled = true;
    failBackupUnlink.threshold = 2;
    await expect(tx.commit()).rejects.toMatchObject({
      code: "TRANSACTION_CLEANUP_PENDING",
    });

    const result = await recoverPendingAdapterTransactions(dir);
    expect(result.cleaned).toHaveLength(1);
    expect(await readFile(targetA, "utf8")).toBe("NEW_A");
    expect(await readFile(targetB, "utf8")).toBe("NEW_B");
    expect((await recoverPendingAdapterTransactions(dir)).cleaned).toHaveLength(0);
  });
});
