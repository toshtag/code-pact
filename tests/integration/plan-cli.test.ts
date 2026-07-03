// CLI integration suite for `plan brief` / `plan prompt` /
// `plan constitution`. These three commands were previously only
// unit-tested; v1.0 P8-T1 adds subprocess coverage so the public
// surface (exit codes, --json envelope, non-TTY behaviour) is locked
// in before P8-T3's contract freeze.
//
// `plan brief` and `plan constitution` are TTY-required wizards
// (Stable (human-output) candidates) — in a subprocess they must
// surface CONFIG_ERROR exit 2 rather than silently hanging.
//
// `plan prompt` is non-interactive and reads design/brief.md +
// design/constitution.md from disk (Stable (v1.0) candidate). The
// --clipboard path is intentionally not exercised here because it
// shells out to pbcopy / xclip, which is brittle in CI; that branch
// is covered by tests/unit/commands/plan-prompt.test.ts.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  run as cliRun,
  ensureCliBuilt,
  type RunResult,
} from "../helpers/cli.ts";

let tmpDir: string;

function run(args: string[], env?: NodeJS.ProcessEnv): RunResult {
  return cliRun(tmpDir, args, env);
}

beforeAll(() => {
  ensureCliBuilt();
}, 60_000);

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "code-pact-plan-cli-test-"));
});

afterEach(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// plan brief (TTY-required wizard)
// ---------------------------------------------------------------------------

describe("CLI: plan brief (no-TTY)", () => {
  it("plan brief --json in a non-TTY subprocess returns {ok:false,error:CONFIG_ERROR} exit 2", () => {
    run([
      "init",
      "--non-interactive",
      "--locale",
      "en-US",
      "--agent",
      "claude-code",
      "--json",
    ]);
    const res = run(["plan", "brief", "--json"]);
    expect(res.code).toBe(2);
    const parsed = JSON.parse(res.stdout) as {
      ok: boolean;
      error: { code: string; message: string };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("CONFIG_ERROR");
    expect(parsed.error.message.toLowerCase()).toContain("tty");
  });

  it("plan brief (human output) in a non-TTY subprocess writes a single stderr line and exit 2", () => {
    run([
      "init",
      "--non-interactive",
      "--locale",
      "en-US",
      "--agent",
      "claude-code",
      "--json",
    ]);
    const res = run(["plan", "brief"]);
    expect(res.code).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr.toLowerCase()).toContain("tty");
  });
});

// ---------------------------------------------------------------------------
// plan constitution (TTY-required wizard)
// ---------------------------------------------------------------------------

describe("CLI: plan constitution (no-TTY)", () => {
  it("plan constitution --json in a non-TTY subprocess returns {ok:false,error:CONFIG_ERROR} exit 2", () => {
    run([
      "init",
      "--non-interactive",
      "--locale",
      "en-US",
      "--agent",
      "claude-code",
      "--json",
    ]);
    const res = run(["plan", "constitution", "--json"]);
    expect(res.code).toBe(2);
    const parsed = JSON.parse(res.stdout) as {
      ok: boolean;
      error: { code: string; message: string };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("CONFIG_ERROR");
    expect(parsed.error.message.toLowerCase()).toContain("tty");
  });

  it("plan constitution (human output) in a non-TTY subprocess writes a single stderr line and exit 2", () => {
    run([
      "init",
      "--non-interactive",
      "--locale",
      "en-US",
      "--agent",
      "claude-code",
      "--json",
    ]);
    const res = run(["plan", "constitution"]);
    expect(res.code).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr.toLowerCase()).toContain("tty");
  });
});

// ---------------------------------------------------------------------------
// plan prompt (non-interactive)
// ---------------------------------------------------------------------------

describe("CLI: plan prompt", () => {
  it("plan prompt --json on an uninitialized project returns {ok:true,data:{has_brief:false,has_constitution:false}} exit 0", () => {
    // plan prompt does not require an initialized project — it just
    // reports has_brief / has_constitution = false when the files are
    // missing.
    const res = run(["plan", "prompt", "--json"]);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout) as {
      ok: boolean;
      data: {
        prompt: string;
        has_brief: boolean;
        has_constitution: boolean;
        clipboard_copied: boolean;
      };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.has_brief).toBe(false);
    expect(parsed.data.has_constitution).toBe(false);
    expect(parsed.data.clipboard_copied).toBe(false);
    expect(parsed.data.prompt.length).toBeGreaterThan(0);
  });

  it("plan prompt --json picks up design/brief.md and design/constitution.md when present", async () => {
    run([
      "init",
      "--non-interactive",
      "--locale",
      "en-US",
      "--agent",
      "claude-code",
      "--json",
    ]);
    await mkdir(join(tmpDir, "design"), { recursive: true });
    await writeFile(
      join(tmpDir, "design", "brief.md"),
      "# Brief\n\nTest brief content.\n",
    );
    await writeFile(
      join(tmpDir, "design", "constitution.md"),
      "# Constitution\n\nTest constitution content.\n",
    );

    const res = run(["plan", "prompt", "--json"]);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout) as {
      ok: boolean;
      data: { has_brief: boolean; has_constitution: boolean; prompt: string };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.has_brief).toBe(true);
    expect(parsed.data.has_constitution).toBe(true);
    expect(parsed.data.prompt).toContain("Test brief content.");
    expect(parsed.data.prompt).toContain("Test constitution content.");
  });

  it("plan prompt (human output) writes the prompt to stdout and exits 0", () => {
    const res = run(["plan", "prompt"]);
    expect(res.code).toBe(0);
    // The prompt is the entire stdout in human mode.
    expect(res.stdout.length).toBeGreaterThan(0);
    // It should NOT be a JSON envelope.
    expect(res.stdout.trimStart().startsWith("{")).toBe(false);
  });

  it("plan prompt --schema-only --json returns {ok:true,data:{schema_only:true}} exit 0", () => {
    const res = run(["plan", "prompt", "--schema-only", "--json"]);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout) as {
      ok: boolean;
      data: {
        prompt: string;
        schema_only: boolean;
        has_brief: boolean;
        suggested_next_steps: string[];
      };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.schema_only).toBe(true);
    expect(parsed.data.prompt).toContain("verify_commands:");
    expect(parsed.data.prompt).toContain("phases:");
    expect(parsed.data.suggested_next_steps.length).toBeGreaterThan(0);
  });

  it("plan prompt --schema-only ignores design/brief.md even when present", async () => {
    run([
      "init",
      "--non-interactive",
      "--locale",
      "en-US",
      "--agent",
      "claude-code",
      "--json",
    ]);
    await mkdir(join(tmpDir, "design"), { recursive: true });
    await writeFile(
      join(tmpDir, "design", "brief.md"),
      "# Brief\n\nSCHEMA_ONLY_LEAK_CHECK content.\n",
    );
    const res = run(["plan", "prompt", "--schema-only", "--json"]);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout) as {
      ok: boolean;
      data: { schema_only: boolean; has_brief: boolean; prompt: string };
    };
    expect(parsed.data.schema_only).toBe(true);
    expect(parsed.data.has_brief).toBe(false);
    expect(parsed.data.prompt).not.toContain("SCHEMA_ONLY_LEAK_CHECK");
  });

  it("plan prompt --json includes schema_only:false in normal mode (additive field)", () => {
    const res = run(["plan", "prompt", "--json"]);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout) as {
      ok: boolean;
      data: { schema_only: boolean };
    };
    expect(parsed.data.schema_only).toBe(false);
  });

  it("plan prompt rejects unknown options with parseArgs strict:false behaviour (tolerant)", () => {
    // plan prompt currently uses parseArgs strict:false, so unknown flags
    // are quietly ignored. This test pins that behaviour so the v1.0
    // contract freeze records it accurately — if we tighten this later
    // it will be an intentional, documented change.
    const res = run(["plan", "prompt", "--bogus", "--json"]);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout) as { ok: boolean };
    expect(parsed.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// plan adopt
// ---------------------------------------------------------------------------

describe("CLI: plan adopt", () => {
  async function initAndWrite(name: string, body: string): Promise<void> {
    run([
      "init",
      "--non-interactive",
      "--locale",
      "en-US",
      "--agent",
      "claude-code",
      "--json",
    ]);
    await writeFile(join(tmpDir, name), body);
  }

  it("plan adopt <md> --json dry-runs, does not write, returns would_adopt", async () => {
    await initAndWrite(
      "roadmap.md",
      `## Phase 1: Foundations\n- Scaffold the package\n- Write the README docs\n`,
    );
    const res = run(["plan", "adopt", "roadmap.md", "--json"]);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout) as {
      ok: boolean;
      data: {
        kind: string;
        source_type: string;
        phases_detected: number;
        tasks_detected: number;
        generated_import_yaml: string;
        import_result: unknown;
      };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.kind).toBe("would_adopt");
    expect(parsed.data.source_type).toBe("markdown");
    expect(parsed.data.tasks_detected).toBe(2);
    expect(parsed.data.generated_import_yaml).toContain("verify_commands");
    expect(parsed.data.import_result).toBeNull();

    // dry-run must not have created any phase
    const ls = run(["phase", "ls", "--json"]);
    const lsParsed = JSON.parse(ls.stdout) as { data: { id: string }[] };
    expect(lsParsed.data).toHaveLength(0);
  });

  it("plan adopt <md> --write --json creates the phases via phase import", async () => {
    await initAndWrite(
      "roadmap.md",
      `## Phase 1: Foundations\n- Scaffold\n- Wire the CLI\n`,
    );
    const res = run(["plan", "adopt", "roadmap.md", "--write", "--json"]);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout) as {
      ok: boolean;
      data: {
        kind: string;
        import_result: { imported_tasks: string[] } | null;
      };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.kind).toBe("adopted");
    expect(parsed.data.import_result?.imported_tasks).toEqual([
      "P1-T1",
      "P1-T2",
    ]);

    const ls = run(["phase", "ls", "--json"]);
    const lsParsed = JSON.parse(ls.stdout) as { data: { id: string }[] };
    expect(lsParsed.data.map(p => p.id)).toContain("P1");
  });

  it("plan adopt with no path returns CONFIG_ERROR exit 2", async () => {
    run([
      "init",
      "--non-interactive",
      "--locale",
      "en-US",
      "--agent",
      "claude-code",
      "--json",
    ]);
    const res = run(["plan", "adopt", "--json"]);
    expect(res.code).toBe(2);
    const parsed = JSON.parse(res.stdout) as {
      ok: boolean;
      error: { code: string };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("CONFIG_ERROR");
  });

  it("plan adopt of a prose file returns no_plan_items_detected", async () => {
    await initAndWrite(
      "notes.md",
      `# Notes\n\nJust prose, no bullet lists at all.\n`,
    );
    const res = run(["plan", "adopt", "notes.md", "--json"]);
    expect(res.code).toBe(2);
    const parsed = JSON.parse(res.stdout) as {
      ok: boolean;
      error: { code: string };
      data: { detail: string };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("CONFIG_ERROR");
    expect(parsed.data.detail).toBe("no_plan_items_detected");
  });

  it("plan adopt of an unsafe path is rejected", async () => {
    run([
      "init",
      "--non-interactive",
      "--locale",
      "en-US",
      "--agent",
      "claude-code",
      "--json",
    ]);
    const res = run(["plan", "adopt", "../escape.md", "--json"]);
    expect(res.code).toBe(2);
    const parsed = JSON.parse(res.stdout) as { data: { detail: string } };
    expect(parsed.data.detail).toBe("unsafe_path");
  });
});
