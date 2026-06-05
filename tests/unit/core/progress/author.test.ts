import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { resolveEventAuthor } from "../../../../src/core/progress/author.ts";

let dir: string;
const saved: Record<string, string | undefined> = {};
// Keys neutralised so the dev machine's GLOBAL/SYSTEM git identity can't leak
// into the "no identity" case (and `git config user.name` reflects only what the
// test sets at the repo level).
const ENV_KEYS = ["CODE_PACT_AUTHOR", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "code-pact-author-test-"));
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  delete process.env.CODE_PACT_AUTHOR;
  // /dev/null is an empty config file → no global/system user.name.
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_SYSTEM = "/dev/null";
});

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await rm(dir, { recursive: true, force: true });
});

function git(args: string[]): void {
  const r = spawnSync("git", args, { cwd: dir });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed`);
}

async function writeProject(authorMode?: "auto" | "off"): Promise<void> {
  await mkdir(join(dir, ".code-pact"), { recursive: true });
  const collab = authorMode ? `\ncollaboration:\n  author: ${authorMode}\n` : "\n";
  await writeFile(
    join(dir, ".code-pact", "project.yaml"),
    `name: t\nversion: 1.0.0\nlocale: en-US\ndefault_agent: claude-code\nagents:\n  - name: claude-code\n    profile: agent-profiles/claude-code.yaml${collab}`,
    "utf8",
  );
}

describe("resolveEventAuthor — precedence (Collaboration UX RFC D1)", () => {
  it("uses git config user.name when present (no env, no off)", async () => {
    git(["init", "--quiet"]);
    git(["config", "user.name", "Ada Lovelace"]); // local config overrides any global
    await writeProject("auto");
    expect(await resolveEventAuthor(dir)).toBe("Ada Lovelace");
  });

  it("CODE_PACT_AUTHOR wins over git config user.name", async () => {
    git(["init", "--quiet"]);
    git(["config", "user.name", "Ada Lovelace"]);
    process.env.CODE_PACT_AUTHOR = "ci-bot";
    await writeProject("auto");
    expect(await resolveEventAuthor(dir)).toBe("ci-bot");
  });

  it("collaboration.author: off wins over everything (never capture)", async () => {
    git(["init", "--quiet"]);
    git(["config", "user.name", "Ada Lovelace"]);
    process.env.CODE_PACT_AUTHOR = "ci-bot";
    await writeProject("off");
    expect(await resolveEventAuthor(dir)).toBeUndefined();
  });

  it("omits (undefined) when there is no identity — not a git repo, no env, no off", async () => {
    // Not a git repo → `git config user.name` fails; no env; project not off.
    await writeProject("auto");
    expect(await resolveEventAuthor(dir)).toBeUndefined();
  });

  it("never throws on a missing / malformed project.yaml (treats as not-off)", async () => {
    // No project.yaml at all; env provides the identity.
    process.env.CODE_PACT_AUTHOR = "ci-bot";
    expect(await resolveEventAuthor(dir)).toBe("ci-bot");
  });

  it("trims whitespace and ignores an empty CODE_PACT_AUTHOR", async () => {
    process.env.CODE_PACT_AUTHOR = "   ";
    // empty-after-trim → falls through to git (none here) → undefined
    expect(await resolveEventAuthor(dir)).toBeUndefined();
  });
});
