import { createHash } from "node:crypto";
import {
  lstatOwned,
  mkdirOwned,
  realpathOwned,
} from "../project-fs/operations.ts";
import {
  brandOwnedRead,
  brandOwnedWrite,
} from "../project-fs/branded-paths-internal.ts";
import { homedir, platform } from "node:os";
import { isAbsolute, join } from "node:path";

export const LEGACY_TRANSACTION_DIR_REL = join(
  ".code-pact",
  "state",
  "adapter-transactions",
);

export function adapterTransactionStateRoot(): string {
  if (process.env.CODE_PACT_STATE_HOME) {
    return requireAbsoluteEnvPath(
      "CODE_PACT_STATE_HOME",
      process.env.CODE_PACT_STATE_HOME,
    );
  }
  if (platform() === "win32" && process.env.LOCALAPPDATA) {
    return join(
      requireAbsoluteEnvPath("LOCALAPPDATA", process.env.LOCALAPPDATA),
      "code-pact",
      "state",
    );
  }
  if (process.env.XDG_STATE_HOME) {
    return join(
      requireAbsoluteEnvPath("XDG_STATE_HOME", process.env.XDG_STATE_HOME),
      "code-pact",
    );
  }
  return join(homedir(), ".local", "state", "code-pact");
}

export async function canonicalProjectRoot(cwd: string): Promise<string> {
  return realpathOwned(brandOwnedRead(cwd));
}

export async function adapterTransactionProjectDir(
  cwd: string,
): Promise<string> {
  const projectRoot = await canonicalProjectRoot(cwd);
  const key = createHash("sha256").update(projectRoot).digest("hex");
  const root = adapterTransactionStateRoot();
  await ensurePrivateDirectory(root);
  const transactionsDir = join(root, "adapter-transactions");
  await ensurePrivateDirectory(transactionsDir);
  const dir = join(transactionsDir, key);
  await ensurePrivateDirectory(dir);
  return dir;
}

function configError(message: string): Error {
  const err = new Error(message);
  (err as NodeJS.ErrnoException).code = "CONFIG_ERROR";
  return err;
}

function requireAbsoluteEnvPath(name: string, value: string): string {
  if (!isAbsolute(value)) {
    throw configError(`${name} must be an absolute path`);
  }
  return value;
}

async function ensurePrivateDirectory(dir: string): Promise<void> {
  await mkdirOwned(brandOwnedWrite(dir), { recursive: true, mode: 0o700 });
  await assertPrivateDirectory(dir);
}

async function assertPrivateDirectory(dir: string): Promise<void> {
  const st = await lstatOwned(brandOwnedRead(dir));
  if (st.isSymbolicLink()) {
    throw configError(
      `transaction state directory must not be a symlink: ${dir}`,
    );
  }
  if (!st.isDirectory()) {
    throw configError(`transaction state path must be a directory: ${dir}`);
  }
  if (platform() !== "win32") {
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    if (uid !== null && st.uid !== uid) {
      throw configError(
        `transaction state directory is not owned by the current user: ${dir}`,
      );
    }
    if ((st.mode & 0o022) !== 0) {
      throw configError(
        `transaction state directory must not be group/other writable: ${dir}`,
      );
    }
  }
}
