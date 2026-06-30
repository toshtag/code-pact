import { createHash } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";

export const LEGACY_TRANSACTION_DIR_REL = join(
  ".code-pact",
  "state",
  "adapter-transactions",
);

export function adapterTransactionStateRoot(): string {
  if (process.env.CODE_PACT_STATE_HOME) return process.env.CODE_PACT_STATE_HOME;
  if (platform() === "win32" && process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, "code-pact", "state");
  }
  if (process.env.XDG_STATE_HOME) {
    return join(process.env.XDG_STATE_HOME, "code-pact");
  }
  return join(homedir(), ".local", "state", "code-pact");
}

export async function canonicalProjectRoot(cwd: string): Promise<string> {
  return realpath(cwd);
}

export async function adapterTransactionProjectDir(cwd: string): Promise<string> {
  const projectRoot = await canonicalProjectRoot(cwd);
  const key = createHash("sha256").update(projectRoot).digest("hex");
  const dir = join(adapterTransactionStateRoot(), "adapter-transactions", key);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}
