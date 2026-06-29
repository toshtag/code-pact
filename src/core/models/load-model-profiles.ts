import { readFile, readdir, stat } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { ModelProfile } from "../schemas/model-profile.ts";
import { resolveSymlinkFreeProjectPath } from "../path-safety.ts";

const MODEL_PROFILES_DIR = ".code-pact/model-profiles";

function modelProfileConfigError(message: string): Error {
  const err = new Error(message);
  (err as NodeJS.ErrnoException).code = "CONFIG_ERROR";
  return err;
}

/**
 * Shared strict loader for `.code-pact/model-profiles/*.yaml`. Uses
 * {@link resolveSymlinkFreeProjectPath} so an in-project symlink alias
 * on the directory or any entry is rejected before any read/readdir.
 *
 * - Directory: exact `.code-pact/model-profiles`, symlink-free.
 * - Entry: filename policy validated (*.yaml), symlink-free, regular file only.
 *
 * Unsafe directory/file is NOT silently degraded to an empty array.
 * Callers must decide how to handle the error:
 *   - Mutation/generation commands → CONFIG_ERROR / exit 2
 *   - doctor/validate → structured error issue
 */
export async function loadModelProfilesStrict(
  cwd: string,
): Promise<ModelProfile[]> {
  const dirAbs = await resolveSymlinkFreeProjectPath(cwd, MODEL_PROFILES_DIR);
  let entries: string[];
  try {
    entries = await readdir(dirAbs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw err;
  }

  const profiles: ModelProfile[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".yaml")) continue;
    const relPath = `${MODEL_PROFILES_DIR}/${entry}`;
    const abs = await resolveSymlinkFreeProjectPath(cwd, relPath);
    const s = await stat(abs);
    if (!s.isFile()) {
      throw modelProfileConfigError(
        `Model profile entry "${relPath}" is not a regular file.`,
      );
    }
    const raw = await readFile(abs, "utf8");
    profiles.push(ModelProfile.parse(parseYaml(raw) as unknown));
  }
  return profiles;
}

/**
 * Diagnostic-compatible loader. Missing `.code-pact/model-profiles` means
 * "no model profiles" and returns `[]`; present-but-broken directories or
 * entries throw so doctor/adapter-doctor can surface a structured error rather
 * than silently treating unsafe configuration as an empty model profile set.
 */
export async function loadModelProfilesSafe(
  cwd: string,
): Promise<ModelProfile[]> {
  let dirAbs: string;
  try {
    dirAbs = await resolveSymlinkFreeProjectPath(cwd, MODEL_PROFILES_DIR);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  let entries: string[];
  try {
    entries = await readdir(dirAbs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const profiles: ModelProfile[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".yaml")) continue;
    const relPath = `${MODEL_PROFILES_DIR}/${entry}`;
    const abs = await resolveSymlinkFreeProjectPath(cwd, relPath);
    const s = await stat(abs);
    if (!s.isFile()) {
      throw modelProfileConfigError(
        `Model profile entry "${relPath}" is not a regular file.`,
      );
    }
    const raw = await readFile(abs, "utf8");
    profiles.push(ModelProfile.parse(parseYaml(raw) as unknown));
  }
  return profiles;
}
