// `plan brief --what / --who / --differentiator` integration tests — v1.6 P17-T3.
//
// Verifies:
//   * Flag-driven success path writes design/brief.md with the supplied
//     values (--json envelope identical to --from-file / --stdin / wizard).
//   * Missing required flags (--what or --who) → CONFIG_ERROR exit 2 with
//     a `data.missing` array naming the missing flags.
//   * Empty-string values for required flags are rejected the same as
//     missing flags.
//   * Pairwise mutex with --from-file and --stdin.
//   * --differentiator alone (without --what/--who) is enough to trigger
//     flag-driven mode → still errors on missing requireds.
//   * --force interaction (overrides file-exists short-circuit).

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  createTempProject,
  ensureCliBuilt,
  type JsonEnvelope,
} from "../helpers/cli.ts";

type Project = Awaited<ReturnType<typeof createTempProject>>;

let cleanups: Array<() => Promise<void>> = [];

beforeAll(() => {
  ensureCliBuilt();
}, 60_000);

afterEach(async () => {
  await Promise.all(cleanups.map((c) => c()));
  cleanups = [];
});

async function freshProject(prefix: string): Promise<Project> {
  const p = await createTempProject({
    prefix: `code-pact-plan-brief-flags-${prefix}-`,
  });
  cleanups.push(p.cleanup);
  return p;
}

describe("plan brief flag-driven (success path)", () => {
  it("--what + --who + --differentiator writes brief.md", async () => {
    const p = await freshProject("success");
    const res = p.run([
      "plan",
      "brief",
      "--what",
      "AI control plane",
      "--who",
      "Software teams adopting agentic workflows",
      "--differentiator",
      "Vendor-neutral, deterministic CLI",
      "--json",
    ]);
    expect(res.code).toBe(0);
    const env = JSON.parse(res.stdout) as JsonEnvelope<{ path: string }>;
    expect(env.ok).toBe(true);

    const written = await readFile(join(p.dir, "design/brief.md"), "utf8");
    expect(written).toContain("AI control plane");
    expect(written).toContain("Software teams adopting agentic workflows");
    expect(written).toContain("Vendor-neutral, deterministic CLI");
  });

  it("--what + --who alone (no --differentiator) uses the locale placeholder", async () => {
    const p = await freshProject("no-diff");
    const res = p.run([
      "plan",
      "brief",
      "--what",
      "x",
      "--who",
      "y",
      "--json",
    ]);
    expect(res.code).toBe(0);
    const written = await readFile(join(p.dir, "design/brief.md"), "utf8");
    expect(written).toContain("What makes it different");
    // The placeholder text fills in for empty differentiator.
    expect(written).toContain("x");
    expect(written).toContain("y");
  });

  it("works in human mode (no --json)", async () => {
    const p = await freshProject("human");
    const res = p.run([
      "plan",
      "brief",
      "--what",
      "x",
      "--who",
      "y",
    ]);
    expect(res.code).toBe(0);
    const written = await readFile(join(p.dir, "design/brief.md"), "utf8");
    expect(written).toContain("Project Brief");
  });
});

describe("plan brief flag-driven (missing-required-flag matrix)", () => {
  it("missing --who → CONFIG_ERROR with data.missing = [\"--who\"]", async () => {
    const p = await freshProject("missing-who");
    const res = p.run([
      "plan",
      "brief",
      "--what",
      "x",
      "--json",
    ]);
    expect(res.code).toBe(2);
    const env = JSON.parse(res.stdout) as JsonEnvelope<unknown>;
    expect(env.ok).toBe(false);
    if (!env.ok) {
      expect(env.error.code).toBe("CONFIG_ERROR");
      const data = env.data as { missing?: string[] } | undefined;
      expect(data?.missing).toEqual(["--who"]);
    }
  });

  it("missing --what → CONFIG_ERROR with data.missing = [\"--what\"]", async () => {
    const p = await freshProject("missing-what");
    const res = p.run([
      "plan",
      "brief",
      "--who",
      "y",
      "--json",
    ]);
    expect(res.code).toBe(2);
    const env = JSON.parse(res.stdout) as JsonEnvelope<unknown>;
    expect(env.ok).toBe(false);
    if (!env.ok) {
      const data = env.data as { missing?: string[] } | undefined;
      expect(data?.missing).toEqual(["--what"]);
    }
  });

  it("--differentiator alone (no --what / --who) still triggers flag-driven mode → errors on both missing", async () => {
    const p = await freshProject("diff-only");
    const res = p.run([
      "plan",
      "brief",
      "--differentiator",
      "z",
      "--json",
    ]);
    expect(res.code).toBe(2);
    const env = JSON.parse(res.stdout) as JsonEnvelope<unknown>;
    expect(env.ok).toBe(false);
    if (!env.ok) {
      const data = env.data as { missing?: string[] } | undefined;
      expect(data?.missing).toEqual(["--what", "--who"]);
    }
  });

  it("empty --what value is rejected like a missing flag", async () => {
    const p = await freshProject("empty-what");
    const res = p.run([
      "plan",
      "brief",
      "--what",
      "",
      "--who",
      "y",
      "--json",
    ]);
    expect(res.code).toBe(2);
    const env = JSON.parse(res.stdout) as JsonEnvelope<unknown>;
    expect(env.ok).toBe(false);
    if (!env.ok) {
      const data = env.data as { missing?: string[] } | undefined;
      expect(data?.missing).toEqual(["--what"]);
    }
  });

  it("no design/brief.md written on missing-flag failure (partial-write guard)", async () => {
    const p = await freshProject("no-partial-write");
    const res = p.run([
      "plan",
      "brief",
      "--what",
      "x",
      "--json",
    ]);
    expect(res.code).toBe(2);
    await expect(
      readFile(join(p.dir, "design/brief.md")),
    ).rejects.toThrow(/ENOENT/);
  });
});

describe("plan brief flag-driven (mutex with --from-file and --stdin)", () => {
  it("--what + --from-file → CONFIG_ERROR mutex", async () => {
    const p = await freshProject("mutex-file");
    await mkdir(join(p.dir, "input"), { recursive: true });
    await writeFile(
      join(p.dir, "input/brief.yaml"),
      "what: file-what\nwho: file-who\n",
      "utf8",
    );
    const res = p.run([
      "plan",
      "brief",
      "--what",
      "flag-what",
      "--who",
      "flag-who",
      "--from-file",
      "input/brief.yaml",
      "--json",
    ]);
    expect(res.code).toBe(2);
    const env = JSON.parse(res.stdout) as JsonEnvelope<unknown>;
    expect(env.ok).toBe(false);
    if (!env.ok) {
      expect(env.error.code).toBe("CONFIG_ERROR");
      expect(env.error.message).toContain("mutually exclusive");
      expect(env.error.message).toContain("--from-file");
      expect(env.error.message).toContain("--what/--who/--differentiator");
    }
  });

  it("--what + --stdin → CONFIG_ERROR mutex", async () => {
    const p = await freshProject("mutex-stdin");
    const res = p.run(
      [
        "plan",
        "brief",
        "--what",
        "flag-what",
        "--who",
        "flag-who",
        "--stdin",
        "--json",
      ],
      { input: "what: stdin-what\nwho: stdin-who\n" },
    );
    expect(res.code).toBe(2);
    const env = JSON.parse(res.stdout) as JsonEnvelope<unknown>;
    expect(env.ok).toBe(false);
    if (!env.ok) {
      expect(env.error.code).toBe("CONFIG_ERROR");
      expect(env.error.message).toContain("--stdin");
      expect(env.error.message).toContain("--what/--who/--differentiator");
    }
  });
});

describe("plan brief flag-driven (file-exists semantics)", () => {
  it("does NOT overwrite an existing brief.md without --force", async () => {
    const p = await freshProject("exists-no-force");
    await mkdir(join(p.dir, "design"), { recursive: true });
    await writeFile(join(p.dir, "design/brief.md"), "existing\n", "utf8");
    const res = p.run([
      "plan",
      "brief",
      "--what",
      "x",
      "--who",
      "y",
      "--json",
    ]);
    expect(res.code).toBe(2);
    const env = JSON.parse(res.stdout) as JsonEnvelope<unknown>;
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error.code).toBe("ALREADY_EXISTS");
    const after = await readFile(join(p.dir, "design/brief.md"), "utf8");
    expect(after).toBe("existing\n");
  });

  it("--force overrides the file-exists short-circuit", async () => {
    const p = await freshProject("exists-force");
    await mkdir(join(p.dir, "design"), { recursive: true });
    await writeFile(join(p.dir, "design/brief.md"), "stale\n", "utf8");
    const res = p.run([
      "plan",
      "brief",
      "--what",
      "fresh-what",
      "--who",
      "fresh-who",
      "--force",
      "--json",
    ]);
    expect(res.code).toBe(0);
    const after = await readFile(join(p.dir, "design/brief.md"), "utf8");
    expect(after).toContain("fresh-what");
    expect(after).not.toContain("stale");
  });
});

describe("plan brief (regression — non-TTY error message lists all three modes)", () => {
  it("non-TTY without any input mode mentions --from-file, --stdin, AND --what/--who[/--differentiator]", async () => {
    const p = await freshProject("regression-msg");
    const res = p.run(["plan", "brief", "--json"]);
    expect(res.code).toBe(2);
    const env = JSON.parse(res.stdout) as JsonEnvelope<unknown>;
    expect(env.ok).toBe(false);
    if (!env.ok) {
      expect(env.error.code).toBe("CONFIG_ERROR");
      expect(env.error.message).toContain("--from-file");
      expect(env.error.message).toContain("--stdin");
      expect(env.error.message).toContain("--what/--who");
    }
  });
});
