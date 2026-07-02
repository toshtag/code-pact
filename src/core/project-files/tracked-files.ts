import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { RelativePosixPath } from "../schemas/relative-path.ts";

const execFileAsync = promisify(execFile);

export async function listTrackedProjectFiles(cwd: string): Promise<string[]> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("git", ["-C", cwd, "ls-files", "-z"], {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    }));
  } catch (cause) {
    const err = new Error(
      "Cannot enumerate task.reads matches because this project has no readable Git tracked-file index.",
    );
    (err as NodeJS.ErrnoException).code = "TASK_READS_UNAVAILABLE";
    (err as Error & { cause?: unknown }).cause = cause;
    throw err;
  }

  const seen = new Set<string>();
  for (const raw of stdout.split("\0")) {
    if (raw.length === 0) continue;
    const path = raw.split(/[\\/]/).join("/");
    if (path === ".git" || path.startsWith(".git/")) continue;
    if (RelativePosixPath.safeParse(path).success) seen.add(path);
  }
  return [...seen].sort();
}
