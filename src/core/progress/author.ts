// Author attribution for progress events (Collaboration UX RFC, D1).
//
// The ledger is otherwise actor-anonymous (`actor: human|agent` + agent profile
// name, no human identity). `resolveEventAuthor` captures *who ran the verb* at
// write time, by a FIXED precedence — `off` wins first so a repo opt-out is a
// genuine "never capture", not overridable by an env var:
//
//   1. project.yaml `collaboration.author: off`  → undefined (capture disabled)
//   2. CODE_PACT_AUTHOR env var (trimmed, non-empty) → used (blank-after-trim ignored)
//   3. git config user.name                       → used
//   4. otherwise                                  → undefined (omit; never faked)
//
// There is NO automatic `user.email` fallback: an email is PII, and git holding
// one does not license auto-embedding it in the committed ledger. A team that
// wants email-as-identity sets CODE_PACT_AUTHOR explicitly.
//
// This is self-reported coordination metadata (as trustworthy as `git blame`,
// no more) — not an audit/security control. It must never throw: a malformed
// project.yaml or missing git simply yields undefined.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { runGit } from "../audit/index.ts";

/** True iff project.yaml explicitly sets `collaboration.author: off`. Tolerant:
 * a missing / unparseable / partial project.yaml is treated as "not off". */
async function authorCaptureDisabled(cwd: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(join(cwd, ".code-pact", "project.yaml"), "utf8");
  } catch {
    return false;
  }
  try {
    const doc = parseYaml(raw) as { collaboration?: { author?: unknown } } | null;
    return doc?.collaboration?.author === "off";
  } catch {
    return false;
  }
}

/**
 * Resolve the `author` to stamp on a new progress event, or `undefined` to omit.
 * See the precedence above. Never throws.
 */
export async function resolveEventAuthor(cwd: string): Promise<string | undefined> {
  if (await authorCaptureDisabled(cwd)) return undefined;

  const env = process.env.CODE_PACT_AUTHOR?.trim();
  if (env) return env;

  const r = await runGit(cwd, ["config", "user.name"]);
  if (r.ok) {
    const name = r.stdout.trim();
    if (name.length > 0) return name;
  }
  return undefined;
}
