// Unit tests for the P14 advisory write lock.
//
// These tests MUST exercise the real acquisition path — the default
// `CODE_PACT_DISABLE_LOCKS=1` set in tests/setup.ts is deleted in the
// beforeEach below. After the suite the env var is restored so the
// global test-escape contract is preserved for subsequent test files.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  acquireWriteLock,
  isLockHeldError,
  lockPathFor,
  type LockHeldError,
} from "../../../../src/core/locks/write-lock.ts";

let cwd: string;
let previousEnv: string | undefined;

beforeEach(async () => {
  previousEnv = process.env.CODE_PACT_DISABLE_LOCKS;
  delete process.env.CODE_PACT_DISABLE_LOCKS;
  cwd = await mkdtemp(join(tmpdir(), "code-pact-write-lock-"));
});

afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
  if (previousEnv === undefined) {
    delete process.env.CODE_PACT_DISABLE_LOCKS;
  } else {
    process.env.CODE_PACT_DISABLE_LOCKS = previousEnv;
  }
});

describe("acquireWriteLock", () => {
  it("creates the lock file with diagnostic JSON content", async () => {
    const handle = await acquireWriteLock(cwd, "test cmd");
    const lockPath = lockPathFor(cwd);
    const raw = await readFile(lockPath, "utf8");
    const holder = JSON.parse(raw) as {
      pid: number;
      hostname: string;
      cmd: string;
      created_at: string;
    };
    expect(holder.pid).toBe(process.pid);
    expect(typeof holder.hostname).toBe("string");
    expect(holder.hostname.length).toBeGreaterThan(0);
    expect(holder.cmd).toBe("test cmd");
    expect(() => new Date(holder.created_at)).not.toThrow();
    expect(Number.isNaN(Date.parse(holder.created_at))).toBe(false);
    await handle.release();
  });

  it("release() removes the lock file", async () => {
    const handle = await acquireWriteLock(cwd, "test cmd");
    await handle.release();
    await expect(readFile(lockPathFor(cwd), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("allows re-acquisition after release (acquire / release / acquire)", async () => {
    const first = await acquireWriteLock(cwd, "first");
    await first.release();
    const second = await acquireWriteLock(cwd, "second");
    const holder = JSON.parse(await readFile(lockPathFor(cwd), "utf8")) as {
      cmd: string;
    };
    expect(holder.cmd).toBe("second");
    await second.release();
  });

  it("throws LOCK_HELD with the existing holder when the lock is already held", async () => {
    const first = await acquireWriteLock(cwd, "first cmd");
    let captured: LockHeldError | undefined;
    try {
      await acquireWriteLock(cwd, "second cmd");
    } catch (err) {
      if (isLockHeldError(err)) captured = err;
      else throw err;
    }
    expect(captured).toBeDefined();
    expect(captured!.code).toBe("LOCK_HELD");
    expect(captured!.lock_holder).not.toBeNull();
    expect(captured!.lock_holder!.cmd).toBe("first cmd");
    expect(captured!.lock_holder!.pid).toBe(process.pid);
    expect(captured!.lock_path).toBe(lockPathFor(cwd));
    expect(captured!.message).toContain("first cmd");
    expect(captured!.message).toContain(String(process.pid));
    await first.release();
  });

  it("surfaces lock_holder: null when the existing lock file is unparseable", async () => {
    const lockPath = lockPathFor(cwd);
    await mkdir(dirname(lockPath), { recursive: true });
    // Write a corrupt lock file (not JSON) to simulate a partial
    // write or hand-edit. The contender should still surface
    // LOCK_HELD without crashing on parse.
    await writeFile(lockPath, "not json {{{", "utf8");
    let captured: LockHeldError | undefined;
    try {
      await acquireWriteLock(cwd, "contender");
    } catch (err) {
      if (isLockHeldError(err)) captured = err;
      else throw err;
    }
    expect(captured).toBeDefined();
    expect(captured!.lock_holder).toBeNull();
    expect(captured!.lock_path).toBe(lockPath);
    expect(captured!.message).toContain("could not be read");
  });

  it("creates the .code-pact/locks/ directory on demand", async () => {
    // mkdtemp creates an empty directory; .code-pact does NOT exist
    // yet. Acquisition must mkdir -p the lock directory.
    const handle = await acquireWriteLock(cwd, "init-time");
    const raw = await readFile(lockPathFor(cwd), "utf8");
    expect(raw).toContain("init-time");
    await handle.release();
  });

  it("respects CODE_PACT_DISABLE_LOCKS=1 (test escape: no-op acquire/release)", async () => {
    process.env.CODE_PACT_DISABLE_LOCKS = "1";
    const handle = await acquireWriteLock(cwd, "should-be-noop");
    // No lock file is created when disabled.
    await expect(readFile(lockPathFor(cwd), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    // Release is a no-op and must not throw.
    await handle.release();
  });

  it("ignores CODE_PACT_DISABLE_LOCKS values other than \"1\"", async () => {
    // Defensive: only the exact string "1" disables locks. Empty
    // string, "true", "0", etc. all leave locks active. This guards
    // against test config drift where the env var is set but the
    // value is wrong.
    for (const value of ["", "0", "true", "false", "yes"]) {
      process.env.CODE_PACT_DISABLE_LOCKS = value;
      const handle = await acquireWriteLock(cwd, `value=${value}`);
      expect(await readFile(lockPathFor(cwd), "utf8")).toContain(
        `value=${value}`,
      );
      await handle.release();
    }
  });
});

describe("isLockHeldError", () => {
  it("identifies LOCK_HELD errors and rejects unrelated errors", async () => {
    const first = await acquireWriteLock(cwd, "first");
    try {
      await acquireWriteLock(cwd, "second");
      expect.fail("expected LOCK_HELD");
    } catch (err) {
      expect(isLockHeldError(err)).toBe(true);
    }
    await first.release();

    expect(isLockHeldError(new Error("not a lock error"))).toBe(false);
    expect(isLockHeldError(null)).toBe(false);
    expect(isLockHeldError(undefined)).toBe(false);
    expect(isLockHeldError("string")).toBe(false);
  });
});
