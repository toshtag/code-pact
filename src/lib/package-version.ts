import { readFile } from "../core/project-fs/index.ts";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolves the package.json version of the code-pact build calling this
 * function. Works both for the bundled `dist/cli.js` (package.json sits
 * one level up) and for tsx-driven runs of `src/cli.ts` (where this file
 * is at `src/lib/package-version.ts` and the package.json is two levels
 * above).
 *
 * Cached per-process because the version cannot change at runtime.
 */
let cached: string | null = null;

export async function readPackageVersion(): Promise<string> {
  if (cached !== null) return cached;
  const here = dirname(fileURLToPath(import.meta.url));
  for (const ascend of ["..", "../.."]) {
    try {
      const raw = await readFile(resolve(here, ascend, "package.json"), "utf8");
      const pkg = JSON.parse(raw) as { name?: string; version?: string };
      if (pkg.name === "code-pact" && typeof pkg.version === "string") {
        cached = pkg.version;
        return cached;
      }
    } catch {
      // try next candidate
    }
  }
  cached = "0.0.0";
  return cached;
}
