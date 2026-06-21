// Author attribution for progress events.
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

import { parse as parseYaml } from "yaml";
import { runGit } from "../audit/index.ts";
import { readProjectTextOrNull } from "../project-read.ts";

/** True iff project.yaml explicitly sets `collaboration.author: off`. Tolerant:
 * a missing / unparseable / partial project.yaml is treated as "not off".
 * Exported so `code-pact status --mine` can distinguish "capture disabled"
 * (`AUTHOR_CAPTURE_DISABLED`) from "no identity resolved" (`AUTHOR_UNAVAILABLE`). */
export async function isAuthorCaptureDisabled(cwd: string): Promise<boolean> {
  const raw = await readProjectTextOrNull(cwd, ".code-pact/project.yaml");
  if (raw === null) return false;
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
  if (await isAuthorCaptureDisabled(cwd)) return undefined;

  const env = process.env.CODE_PACT_AUTHOR?.trim();
  if (env) return env;

  const r = await runGit(cwd, ["config", "user.name"]);
  if (r.ok) {
    const name = r.stdout.trim();
    if (name.length > 0) return name;
  }
  return undefined;
}
