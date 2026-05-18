import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Best-effort atomic replacement for raw text content. Writes to a temp
 * file in the same directory then renames to the destination, so a crash
 * mid-write cannot leave the target half-written. Does NOT protect
 * against concurrent writers — that is a known limitation noted in
 * docs/cli-contract.md.
 */
export async function atomicWriteText(
  path: string,
  content: string,
): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path);
}
