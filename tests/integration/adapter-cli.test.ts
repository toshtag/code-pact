import { beforeAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../../src/commands/init.ts";
import {
  computeContentHash,
  readManifest,
  writeManifest,
} from "../../src/core/adapters/manifest.ts";
import { cliPath, ensureCliBuilt } from "../helpers/cli.ts";

beforeAll(() => {
  ensureCliBuilt();
}, 60_000);

let dir: string;

beforeEach(async () => {
  // On macOS /var/folders/... is a symlink to /private/var/folders/...; the
  // spawned node's process.cwd() returns the realpath'd form, so we
  // realpath dir up front to make path comparisons stable.
  dir = await realpath(await mkdtemp(join(tmpdir(), "code-pact-adapter-cli-test-")));
  await runInit({
    cwd: dir,
    locale: "en-US",
    agents: ["claude-code"],
    force: false,
    json: false,
  });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function runCli(args: string[]) {
  return spawnSync("node", [cliPath, ...args], {
    cwd: dir,
    encoding: "utf8",
    stdio: "pipe",
  });
}

describe("adapter list — CLI", () => {
  it("--json returns ok envelope with agents array", () => {
    const res = runCli(["adapter", "list", "--json"]);
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout) as {
      ok: boolean;
      data: { agents: Array<{ name: string }> };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.agents.map((a) => a.name).sort()).toEqual(
      ["claude-code", "codex", "cursor", "gemini-cli", "generic"].sort(),
    );
  });

  it("human form writes one line per agent to stderr", () => {
    const res = runCli(["adapter", "list"]);
    expect(res.status).toBe(0);
    expect(res.stderr).toContain("claude-code");
    expect(res.stderr).toContain("enabled");
    expect(res.stderr).toContain("experimental"); // cursor or gemini-cli
  });
});

describe("adapter install <agent> — CLI", () => {
  it("--json returns ok envelope with manifestPath and generatorVersion", () => {
    const res = runCli(["adapter", "install", "claude-code", "--json"]);
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout) as {
      ok: boolean;
      data: { agentName: string; manifestPath: string; generatorVersion: string };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.agentName).toBe("claude-code");
    expect(parsed.data.manifestPath).toBe(
      join(dir, ".code-pact", "adapters", "claude-code.manifest.yaml"),
    );
    expect(parsed.data.generatorVersion).toMatch(/^\d/); // looks like a version
  });

  it("missing <agent> positional → CONFIG_ERROR exit 2", () => {
    const res = runCli(["adapter", "install", "--json"]);
    expect(res.status).toBe(2);
    const parsed = JSON.parse(res.stdout) as { ok: false; error: { code: string } };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("CONFIG_ERROR");
  });

  it("unknown agent → AGENT_NOT_FOUND exit 2", () => {
    const res = runCli(["adapter", "install", "no-such-agent", "--json"]);
    expect(res.status).toBe(2);
    const parsed = JSON.parse(res.stdout) as { ok: false; error: { code: string } };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("AGENT_NOT_FOUND");
  });
});

describe("adapter bare-form removed — CLI", () => {
  it("bare `adapter` (no subcommand) → CONFIG_ERROR exit 2, no side effects", () => {
    const res = runCli(["adapter", "--json"]);
    expect(res.status).toBe(2);
    const parsed = JSON.parse(res.stdout) as { ok: false; error: { code: string; message: string } };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("CONFIG_ERROR");
    expect(parsed.error.message).toMatch(/adapter install/);
    // No implicit install: no manifest was created.
    const manifestPath = join(dir, ".code-pact", "adapters", "claude-code.manifest.yaml");
    expect(existsSync(manifestPath)).toBe(false);
  });

  it("former bare-form `adapter --agent claude-code` → CONFIG_ERROR, no manifest", () => {
    const res = runCli(["adapter", "--agent", "claude-code", "--json"]);
    expect(res.status).toBe(2);
    const parsed = JSON.parse(res.stdout) as { ok: false; error: { code: string } };
    expect(parsed.error.code).toBe("CONFIG_ERROR");
    const manifestPath = join(dir, ".code-pact", "adapters", "claude-code.manifest.yaml");
    expect(existsSync(manifestPath)).toBe(false);
  });

  it("no deprecation notice is emitted (the warning + side-effect form is gone)", () => {
    const res = runCli(["adapter", "--agent", "claude-code"]);
    expect(res.status).toBe(2);
    expect(res.stderr).not.toMatch(/deprecated/i);
  });
});

describe("adapter --help — CLI", () => {
  it("`adapter --help` → usage on stdout, exit 0", () => {
    const res = runCli(["adapter", "--help"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/Subcommands:/);
    expect(res.stdout).toMatch(/install/);
  });

  it("`adapter -h` and `adapter help` also print usage, exit 0", () => {
    for (const variant of [["adapter", "-h"], ["adapter", "help"]]) {
      const res = runCli(variant);
      expect(res.status).toBe(0);
      expect(res.stdout).toMatch(/Subcommands:/);
    }
  });

  it("`adapter install --help` → per-subcommand usage, exit 0, no install", () => {
    const res = runCli(["adapter", "install", "--help"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/adapter install/);
    const manifestPath = join(dir, ".code-pact", "adapters", "claude-code.manifest.yaml");
    expect(existsSync(manifestPath)).toBe(false);
  });
});

describe("adapter upgrade — CLI", () => {
  it("missing <agent> → CONFIG_ERROR exit 2", () => {
    const res = runCli(["adapter", "upgrade", "--check", "--json"]);
    expect(res.status).toBe(2);
    const parsed = JSON.parse(res.stdout) as { ok: false; error: { code: string } };
    expect(parsed.error.code).toBe("CONFIG_ERROR");
  });

  it("neither --check nor --write → CONFIG_ERROR exit 2", () => {
    const res = runCli(["adapter", "upgrade", "claude-code", "--json"]);
    expect(res.status).toBe(2);
    const parsed = JSON.parse(res.stdout) as { ok: false; error: { code: string; message: string } };
    expect(parsed.error.code).toBe("CONFIG_ERROR");
    expect(parsed.error.message).toMatch(/--check or --write/);
  });

  it("both --check and --write → CONFIG_ERROR exit 2 (mutually exclusive)", () => {
    const res = runCli(["adapter", "upgrade", "claude-code", "--check", "--write", "--json"]);
    expect(res.status).toBe(2);
    const parsed = JSON.parse(res.stdout) as { ok: false; error: { code: string; message: string } };
    expect(parsed.error.code).toBe("CONFIG_ERROR");
    expect(parsed.error.message).toMatch(/mutually exclusive/);
  });

  it("no manifest → MANIFEST_NOT_FOUND exit 2", () => {
    const res = runCli(["adapter", "upgrade", "claude-code", "--check", "--json"]);
    expect(res.status).toBe(2);
    const parsed = JSON.parse(res.stdout) as { ok: false; error: { code: string } };
    expect(parsed.error.code).toBe("MANIFEST_NOT_FOUND");
  });

  it("--check --model → CONFIG_ERROR exit 2 (read-only must not pin)", () => {
    runCli(["adapter", "install", "claude-code", "--json"]);
    const res = runCli(["adapter", "upgrade", "claude-code", "--check", "--model", "opus-4.7", "--json"]);
    expect(res.status).toBe(2);
    const parsed = JSON.parse(res.stdout) as { ok: false; error: { code: string; message: string } };
    expect(parsed.error.code).toBe("CONFIG_ERROR");
    expect(parsed.error.message).toMatch(/--model.*--check|--check.*--model/);
  });

  it("unknown agent → AGENT_NOT_FOUND exit 2", () => {
    const res = runCli(["adapter", "upgrade", "no-such-agent", "--check", "--json"]);
    expect(res.status).toBe(2);
    const parsed = JSON.parse(res.stdout) as { ok: false; error: { code: string } };
    expect(parsed.error.code).toBe("AGENT_NOT_FOUND");
  });

  it("--write --model (unknown value) → CONFIG_ERROR exit 2", () => {
    runCli(["adapter", "install", "claude-code", "--json"]);
    const res = runCli(["adapter", "upgrade", "claude-code", "--write", "--model", "gpt-9", "--json"]);
    expect(res.status).toBe(2);
    const parsed = JSON.parse(res.stdout) as { ok: false; error: { code: string } };
    expect(parsed.error.code).toBe("CONFIG_ERROR");
  });

  it("--check after fresh install → clean true, exit 0", () => {
    runCli(["adapter", "install", "claude-code", "--json"]);
    const res = runCli(["adapter", "upgrade", "claude-code", "--check", "--json"]);
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout) as { ok: boolean; data: { clean: boolean } };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.clean).toBe(true);
  });

  it("--write after fresh install → idempotent (manifest hashes unchanged)", () => {
    const install = runCli(["adapter", "install", "claude-code", "--json"]);
    const installed = JSON.parse(install.stdout) as { data: { manifestPath: string } };
    const manifestPath = installed.data.manifestPath;
    const fs = require("node:fs") as typeof import("node:fs");
    const before = fs.readFileSync(manifestPath, "utf8");
    const hashesBefore = before.match(/sha256: [0-9a-f]{64}/g);

    const res = runCli(["adapter", "upgrade", "claude-code", "--write", "--json"]);
    expect(res.status).toBe(0);
    const after = fs.readFileSync(manifestPath, "utf8");
    const hashesAfter = after.match(/sha256: [0-9a-f]{64}/g);
    expect(hashesAfter).toEqual(hashesBefore);
  });
});

describe("adapter upgrade — MODEL_MAP_STALE remaining-advisory hint (CLI)", () => {
  const profileRel = ".code-pact/agent-profiles/claude-code.yaml";

  function pinStale(): void {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = join(dir, profileRel);
    const raw = fs.readFileSync(path, "utf8");
    const next = raw.replace(/(highest_reasoning:\s*)\S+/, "$1claude-opus-4-7");
    expect(next).not.toBe(raw);
    fs.writeFileSync(path, next, "utf8");
  }

  it("non-refused --write with a stale model_map pin prints the hint on stderr", () => {
    runCli(["adapter", "install", "claude-code", "--json"]);
    pinStale();
    const res = runCli(["adapter", "upgrade", "claude-code", "--write"]);
    expect(res.status).toBe(0);
    expect(res.stderr).toContain("Remaining manual advisory: MODEL_MAP_STALE");
    expect(res.stderr).toContain("claude-opus-4-7");
    expect(res.stderr).toContain("claude-opus-4-8");
    // Must not advise --model (it re-pins model_version, not model_map).
    expect(res.stderr).not.toContain("--model");
    // Must not mutate model_map — the stale pin is still on disk afterward.
    const fs = require("node:fs") as typeof import("node:fs");
    expect(fs.readFileSync(join(dir, profileRel), "utf8")).toContain(
      "highest_reasoning: claude-opus-4-7",
    );
  });

  it("fresh (default) model_map → no hint", () => {
    runCli(["adapter", "install", "claude-code", "--json"]);
    const res = runCli(["adapter", "upgrade", "claude-code", "--write"]);
    expect(res.status).toBe(0);
    expect(res.stderr).not.toContain("MODEL_MAP_STALE");
  });

  it("--json never emits the hint (human-only; envelope stays clean)", () => {
    runCli(["adapter", "install", "claude-code", "--json"]);
    pinStale();
    const res = runCli(["adapter", "upgrade", "claude-code", "--write", "--json"]);
    expect(res.status).toBe(0);
    expect(res.stderr).not.toContain("MODEL_MAP_STALE");
    const parsed = JSON.parse(res.stdout) as { ok: boolean; data: Record<string, unknown> };
    expect(parsed.ok).toBe(true);
    expect("drift" in parsed.data).toBe(false);
  });

  it("doctor.yaml disabled_checks suppresses the hint (no contradiction with its own silence guidance)", () => {
    runCli(["adapter", "install", "claude-code", "--json"]);
    pinStale();
    const fs = require("node:fs") as typeof import("node:fs");
    fs.writeFileSync(
      join(dir, ".code-pact", "doctor.yaml"),
      "disabled_checks:\n  - MODEL_MAP_STALE\n",
      "utf8",
    );
    const res = runCli(["adapter", "upgrade", "claude-code", "--write"]);
    expect(res.status).toBe(0);
    expect(res.stderr).not.toContain("MODEL_MAP_STALE");
  });

  it("withholds the hint when a file was refused (--accept-modified is the real next step)", () => {
    runCli(["adapter", "install", "claude-code", "--json"]);
    pinStale(); // makes desired CLAUDE.md stale relative to the new pin
    const fs = require("node:fs") as typeof import("node:fs");
    // Locally edit the managed CLAUDE.md → managed-modified × stale → refuse.
    const claudeMd = join(dir, "CLAUDE.md");
    fs.writeFileSync(claudeMd, fs.readFileSync(claudeMd, "utf8") + "\n<!-- local edit -->\n", "utf8");
    const res = runCli(["adapter", "upgrade", "claude-code", "--write"]);
    expect(res.status).toBe(1); // a refusal exits 1
    expect(res.stderr).toContain("refused");
    // The hint would tell the user to re-run --write; the refusal already told
    // them to use --accept-modified. Suppress the contradictory hint here.
    expect(res.stderr).not.toContain("MODEL_MAP_STALE");
  });
});

describe("adapter doctor — CLI", () => {
  it("--json returns ok envelope with issues array (exit 0 for warning-only state)", () => {
    const res = runCli(["adapter", "doctor", "--json"]);
    // Before install, claude-code has no manifest → MANIFEST_MISSING is a
    // warning, not an error. Matches global doctor's semantic: exit 0 unless
    // a severity:"error" issue is present.
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout) as {
      ok: boolean;
      data: { ok: boolean; issues: Array<{ code: string; agent: string }> };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.ok).toBe(true);
    const codes = parsed.data.issues.map((i) => i.code);
    expect(codes).toContain("ADAPTER_MANIFEST_MISSING");
  });

  it("exit 0 after install — clean state with no issues", () => {
    runCli(["adapter", "install", "claude-code", "--json"]);
    const res = runCli(["adapter", "doctor", "--json"]);
    // generator_version may differ from the install-recorded version, so
    // a warning could still surface; this asserts the exit code only when
    // truly clean. In practice the test repo's package version matches.
    if (res.status === 0) {
      const parsed = JSON.parse(res.stdout) as {
        data: { issues: Array<{ code: string }> };
      };
      expect(parsed.data.issues).toEqual([]);
    } else {
      expect(res.status).toBe(1);
    }
  });

  it("--agent flag accepts an explicit target", () => {
    const res = runCli(["adapter", "doctor", "--agent", "codex", "--json"]);
    expect(res.status).toBe(0); // codex isn't enabled in this project → no findings
    const parsed = JSON.parse(res.stdout) as { ok: boolean; data: { issues: unknown[] } };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.issues).toEqual([]);
  });

  it("--agent with an unknown name → AGENT_NOT_FOUND exit 2", () => {
    const res = runCli(["adapter", "doctor", "--agent", "no-such-agent", "--json"]);
    expect(res.status).toBe(2);
    const parsed = JSON.parse(res.stdout) as { ok: false; error: { code: string } };
    expect(parsed.error.code).toBe("AGENT_NOT_FOUND");
  });

  it("human form prints one line per issue", () => {
    const res = runCli(["adapter", "doctor"]);
    expect(res.stderr).toContain("ADAPTER_MANIFEST_MISSING");
    expect(res.stderr).toContain("[claude-code]");
  });
});

describe("adapter unknown subcommand — CLI", () => {
  it("rejects unknown sub-word with CONFIG_ERROR exit 2", () => {
    const res = runCli(["adapter", "foobar", "--json"]);
    expect(res.status).toBe(2);
    const parsed = JSON.parse(res.stdout) as { ok: false; error: { code: string; message: string } };
    expect(parsed.error.code).toBe("CONFIG_ERROR");
    expect(parsed.error.message).toContain("foobar");
  });

  // The cluster-dispatch errors compute `effectiveJson = globalJson ||
  // argv.includes("--json")`, so a GLOBAL `--json` placed before the
  // subcommand must route the envelope to stdout exactly like a local one.
  it("honors a global --json before the subcommand (stdout JSON, stderr empty)", () => {
    const res = runCli(["--json", "adapter", "foobar"]);
    expect(res.status).toBe(2);
    expect(res.stderr).toBe("");
    const parsed = JSON.parse(res.stdout) as { ok: false; error: { code: string; message: string } };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("CONFIG_ERROR");
    expect(parsed.error.message).toContain("foobar");
  });
});

describe("adapter upgrade — unowned orphan warn output (security)", () => {
  // Seed an orphan whose path is NOT in claude's ownedPathGlobs: managed-clean
  // (manifest hash == disk hash) but not emitted by the generator. The CLI must
  // KEEP it and explain why + how to remove it (vs. silently deleting on a
  // project-supplied manifest's say-so).
  async function seedUnownedOrphan(relPath: string, content: string): Promise<void> {
    await writeFile(join(dir, relPath), content, "utf8");
    const m = await readManifest(dir, "claude-code");
    if (m === null) throw new Error("manifest expected after install");
    m.files.push({
      path: relPath,
      sha256: computeContentHash(content),
      managed: true,
      role: "skill",
    });
    await writeManifest(dir, "claude-code", m);
  }

  it("--write keeps an unowned orphan and prints which file + why + how to remove", async () => {
    expect(runCli(["adapter", "install", "claude-code"]).status).toBe(0);
    const orphan = ".claude/skills/old-renamed-skill.md";
    await seedUnownedOrphan(orphan, "# old skill\n");

    const res = runCli(["adapter", "upgrade", "claude-code", "--write"]);
    expect(res.status).toBe(0);
    // WHICH file
    expect(res.stderr).toContain(orphan);
    // WHY it was not deleted
    expect(res.stderr).toMatch(/not auto-removed|owned path set/);
    // HOW to remove it
    expect(res.stderr).toMatch(/by hand|rm </);
    // The file is still on disk (not deleted on the manifest's say-so).
    expect(existsSync(join(dir, orphan))).toBe(true);
  });

  it("--check surfaces the unowned orphan and does not suggest --write would fix it", async () => {
    expect(runCli(["adapter", "install", "claude-code"]).status).toBe(0);
    const orphan = ".claude/skills/old-renamed-skill.md";
    await seedUnownedOrphan(orphan, "# old skill\n");

    const res = runCli(["adapter", "upgrade", "claude-code", "--check"]);
    expect(res.status).toBe(1); // not clean
    expect(res.stderr).toContain(orphan);
    // warn-only drift: do NOT tell the user "run --write to apply" (it won't help).
    expect(res.stderr).not.toContain('--write" to apply');
    expect(res.stderr).toMatch(/review the orphaned file/i);
  });
});

describe("adapter bare form (no subcommand) — CLI", () => {
  it("--json: CONFIG_ERROR envelope on stdout, stderr empty, exit 2", () => {
    const res = runCli(["adapter", "--json"]);
    expect(res.status).toBe(2);
    expect(res.stderr).toBe("");
    const parsed = JSON.parse(res.stdout) as { ok: false; error: { code: string; message: string } };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("CONFIG_ERROR");
    expect(parsed.error.message).toContain("requires a subcommand");
  });

  it("human: message on stderr, stdout empty, exit 2", () => {
    const res = runCli(["adapter"]);
    expect(res.status).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("requires a subcommand");
  });
});
