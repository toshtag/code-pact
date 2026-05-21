// `plan constitution` non-interactive integration tests — v1.6 P17-T4.
//
// Mirrors the plan-brief P17-T1/T2/T3 integration coverage. Verifies:
//   * Each of three modes (--from-file, --stdin, --description/--principle)
//     successfully writes design/constitution.md.
//   * Pairwise mutex returns CONFIG_ERROR.
//   * Error matrix on --from-file / --stdin (unsafe_path / unreadable /
//     invalid_yaml / schema_invalid / stdin_read_failed).
//   * The non-TTY regression: without any input mode, plan constitution
//     still returns CONFIG_ERROR (v1.5.1 contract preserved); the
//     message now mentions all three modes.

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
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
  // `init` always seeds a design/constitution.md from the locale
  // template. To exercise the non-interactive write path we delete
  // that seed before each test (and rely on `--force` only when the
  // test explicitly wants to test the overwrite path).
  const p = await createTempProject({
    prefix: `code-pact-plan-constitution-${prefix}-`,
  });
  cleanups.push(p.cleanup);
  await rm(join(p.dir, "design", "constitution.md"), { force: true });
  return p;
}

async function writeRel(p: Project, rel: string, content: string): Promise<void> {
  const abs = join(p.dir, rel);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, content, "utf8");
}

const VALID_YAML = [
  "description: A control plane for AI coding agents.",
  "principles:",
  "  - Vendor neutrality",
  "  - Determinism over plausibility",
  "  - Boundaries over conventions",
  "",
].join("\n");

// ---------------------------------------------------------------------------
// --from-file success
// ---------------------------------------------------------------------------

describe("plan constitution --from-file (success)", () => {
  it("writes design/constitution.md and emits the success envelope", async () => {
    const p = await freshProject("file-success");
    await writeRel(p, "input/c.yaml", VALID_YAML);
    const res = p.run([
      "plan",
      "constitution",
      "--from-file",
      "input/c.yaml",
      "--json",
    ]);
    expect(res.code).toBe(0);
    const env = JSON.parse(res.stdout) as JsonEnvelope<{ path: string }>;
    expect(env.ok).toBe(true);
    if (env.ok) expect(env.data.path).toContain("design/constitution.md");

    const written = await readFile(join(p.dir, "design/constitution.md"), "utf8");
    expect(written).toContain("A control plane for AI coding agents.");
    expect(written).toContain("- Vendor neutrality");
    expect(written).toContain("- Determinism over plausibility");
  });

  it("an empty YAML file (`{}`) falls back to locale defaults", async () => {
    const p = await freshProject("file-empty");
    await writeRel(p, "input/c.yaml", "{}\n");
    const res = p.run([
      "plan",
      "constitution",
      "--from-file",
      "input/c.yaml",
      "--json",
    ]);
    expect(res.code).toBe(0);
    const written = await readFile(join(p.dir, "design/constitution.md"), "utf8");
    expect(written).toContain("Core principles");
  });
});

// ---------------------------------------------------------------------------
// --stdin success
// ---------------------------------------------------------------------------

describe("plan constitution --stdin (success)", () => {
  it("reads YAML from stdin and writes the file", async () => {
    const p = await freshProject("stdin-success");
    const res = p.run(["plan", "constitution", "--stdin", "--json"], {
      input: VALID_YAML,
    });
    expect(res.code).toBe(0);
    const written = await readFile(join(p.dir, "design/constitution.md"), "utf8");
    expect(written).toContain("Vendor neutrality");
  });

  it("empty stdin falls back to locale defaults (parity with --from-file)", async () => {
    const p = await freshProject("stdin-empty");
    const res = p.run(["plan", "constitution", "--stdin", "--json"], {
      input: "",
    });
    expect(res.code).toBe(0);
    const written = await readFile(join(p.dir, "design/constitution.md"), "utf8");
    expect(written).toContain("Core principles");
  });
});

// ---------------------------------------------------------------------------
// flag-driven success
// ---------------------------------------------------------------------------

describe("plan constitution --description / --principle (success)", () => {
  it("--description + --principle x2 writes the file", async () => {
    const p = await freshProject("flag-success");
    const res = p.run([
      "plan",
      "constitution",
      "--description",
      "Flag-driven description",
      "--principle",
      "First",
      "--principle",
      "Second",
      "--json",
    ]);
    expect(res.code).toBe(0);
    const written = await readFile(join(p.dir, "design/constitution.md"), "utf8");
    expect(written).toContain("Flag-driven description");
    expect(written).toContain("- First");
    expect(written).toContain("- Second");
  });

  it("--description alone (no principles) → locale-default principles fill in", async () => {
    const p = await freshProject("flag-desc-only");
    const res = p.run([
      "plan",
      "constitution",
      "--description",
      "Only desc",
      "--json",
    ]);
    expect(res.code).toBe(0);
    const written = await readFile(join(p.dir, "design/constitution.md"), "utf8");
    expect(written).toContain("Only desc");
    expect(written).toContain("Write for the next reader");
  });

  it("--principle alone (no description) → locale-default description fills in", async () => {
    const p = await freshProject("flag-prin-only");
    const res = p.run([
      "plan",
      "constitution",
      "--principle",
      "Sole principle",
      "--json",
    ]);
    expect(res.code).toBe(0);
    const written = await readFile(join(p.dir, "design/constitution.md"), "utf8");
    expect(written).toContain("- Sole principle");
    // The English locale default description mentions "principles".
    expect(written.length).toBeGreaterThan(0);
  });

  it("works in human mode (no --json)", async () => {
    const p = await freshProject("flag-human");
    const res = p.run([
      "plan",
      "constitution",
      "--description",
      "x",
      "--principle",
      "y",
    ]);
    expect(res.code).toBe(0);
    const written = await readFile(join(p.dir, "design/constitution.md"), "utf8");
    expect(written).toContain("x");
    expect(written).toContain("- y");
  });
});

// ---------------------------------------------------------------------------
// mutex
// ---------------------------------------------------------------------------

describe("plan constitution mutex (--from-file ↔ --stdin ↔ flag-driven)", () => {
  it("--from-file + --stdin → CONFIG_ERROR", async () => {
    const p = await freshProject("mutex-file-stdin");
    await writeRel(p, "c.yaml", VALID_YAML);
    const res = p.run(
      ["plan", "constitution", "--from-file", "c.yaml", "--stdin", "--json"],
      { input: VALID_YAML },
    );
    expect(res.code).toBe(2);
    const env = JSON.parse(res.stdout) as JsonEnvelope<unknown>;
    expect(env.ok).toBe(false);
    if (!env.ok) {
      expect(env.error.code).toBe("CONFIG_ERROR");
      expect(env.error.message).toContain("mutually exclusive");
      expect(env.error.message).toContain("--from-file");
      expect(env.error.message).toContain("--stdin");
    }
  });

  it("--from-file + --description → CONFIG_ERROR", async () => {
    const p = await freshProject("mutex-file-flag");
    await writeRel(p, "c.yaml", VALID_YAML);
    const res = p.run([
      "plan",
      "constitution",
      "--from-file",
      "c.yaml",
      "--description",
      "flag desc",
      "--json",
    ]);
    expect(res.code).toBe(2);
    const env = JSON.parse(res.stdout) as JsonEnvelope<unknown>;
    expect(env.ok).toBe(false);
    if (!env.ok) {
      expect(env.error.message).toContain("--from-file");
      expect(env.error.message).toContain("--description/--principle");
    }
  });

  it("--stdin + --principle → CONFIG_ERROR", async () => {
    const p = await freshProject("mutex-stdin-flag");
    const res = p.run(
      [
        "plan",
        "constitution",
        "--stdin",
        "--principle",
        "x",
        "--json",
      ],
      { input: VALID_YAML },
    );
    expect(res.code).toBe(2);
    const env = JSON.parse(res.stdout) as JsonEnvelope<unknown>;
    expect(env.ok).toBe(false);
    if (!env.ok) {
      expect(env.error.message).toContain("--stdin");
      expect(env.error.message).toContain("--description/--principle");
    }
  });
});

// ---------------------------------------------------------------------------
// error matrix
// ---------------------------------------------------------------------------

describe("plan constitution --from-file error matrix", () => {
  it("missing file → CONFIG_ERROR with detail=unreadable", async () => {
    const p = await freshProject("file-missing");
    const res = p.run([
      "plan",
      "constitution",
      "--from-file",
      "nope.yaml",
      "--json",
    ]);
    expect(res.code).toBe(2);
    const env = JSON.parse(res.stdout) as JsonEnvelope<unknown>;
    expect(env.ok).toBe(false);
    if (!env.ok) {
      const data = env.data as { detail?: string; path?: string } | undefined;
      expect(data?.detail).toBe("unreadable");
      expect(data?.path).toBe("nope.yaml");
    }
  });

  it("malformed YAML → CONFIG_ERROR with detail=invalid_yaml", async () => {
    const p = await freshProject("file-malformed");
    await writeRel(p, "c.yaml", "description: [unclosed\n");
    const res = p.run([
      "plan",
      "constitution",
      "--from-file",
      "c.yaml",
      "--json",
    ]);
    expect(res.code).toBe(2);
    const env = JSON.parse(res.stdout) as JsonEnvelope<unknown>;
    expect(env.ok).toBe(false);
    if (!env.ok) {
      const data = env.data as { detail?: string } | undefined;
      expect(data?.detail).toBe("invalid_yaml");
    }
  });

  it("schema-invalid (unknown key) → CONFIG_ERROR with detail=schema_invalid", async () => {
    const p = await freshProject("file-schema");
    await writeRel(p, "c.yaml", "description: d\nbogus: 1\n");
    const res = p.run([
      "plan",
      "constitution",
      "--from-file",
      "c.yaml",
      "--json",
    ]);
    expect(res.code).toBe(2);
    const env = JSON.parse(res.stdout) as JsonEnvelope<unknown>;
    expect(env.ok).toBe(false);
    if (!env.ok) {
      const data = env.data as { detail?: string } | undefined;
      expect(data?.detail).toBe("schema_invalid");
    }
  });

  it("unsafe path → CONFIG_ERROR with detail=unsafe_path", async () => {
    const p = await freshProject("file-unsafe");
    const res = p.run([
      "plan",
      "constitution",
      "--from-file",
      "/etc/passwd",
      "--json",
    ]);
    expect(res.code).toBe(2);
    const env = JSON.parse(res.stdout) as JsonEnvelope<unknown>;
    expect(env.ok).toBe(false);
    if (!env.ok) {
      const data = env.data as { detail?: string } | undefined;
      expect(data?.detail).toBe("unsafe_path");
    }
  });
});

describe("plan constitution --stdin error matrix", () => {
  it("malformed YAML → CONFIG_ERROR with detail=invalid_yaml + source=stdin", async () => {
    const p = await freshProject("stdin-malformed");
    const res = p.run(["plan", "constitution", "--stdin", "--json"], {
      input: "description: [unclosed\n",
    });
    expect(res.code).toBe(2);
    const env = JSON.parse(res.stdout) as JsonEnvelope<unknown>;
    expect(env.ok).toBe(false);
    if (!env.ok) {
      const data = env.data as { detail?: string; source?: string } | undefined;
      expect(data?.detail).toBe("invalid_yaml");
      expect(data?.source).toBe("stdin");
    }
  });

  it("schema-invalid → CONFIG_ERROR with detail=schema_invalid", async () => {
    const p = await freshProject("stdin-schema");
    const res = p.run(["plan", "constitution", "--stdin", "--json"], {
      input: "principles: not-an-array\n",
    });
    expect(res.code).toBe(2);
    const env = JSON.parse(res.stdout) as JsonEnvelope<unknown>;
    expect(env.ok).toBe(false);
    if (!env.ok) {
      const data = env.data as { detail?: string } | undefined;
      expect(data?.detail).toBe("schema_invalid");
    }
  });
});

// ---------------------------------------------------------------------------
// regression — non-TTY message + partial-write guards
// ---------------------------------------------------------------------------

describe("plan constitution regression — non-TTY contract preserved", () => {
  it("non-TTY without any input mode → CONFIG_ERROR + message lists all three modes", async () => {
    const p = await freshProject("regression-no-mode");
    const res = p.run(["plan", "constitution", "--json"]);
    expect(res.code).toBe(2);
    const env = JSON.parse(res.stdout) as JsonEnvelope<unknown>;
    expect(env.ok).toBe(false);
    if (!env.ok) {
      expect(env.error.code).toBe("CONFIG_ERROR");
      expect(env.error.message).toContain("TTY");
      expect(env.error.message).toContain("--from-file");
      expect(env.error.message).toContain("--stdin");
      expect(env.error.message).toContain("--description/--principle");
    }
  });

  it("no design/constitution.md written on --from-file failure", async () => {
    const p = await freshProject("partial-write-file");
    const res = p.run([
      "plan",
      "constitution",
      "--from-file",
      "missing.yaml",
      "--json",
    ]);
    expect(res.code).toBe(2);
    await expect(
      readFile(join(p.dir, "design/constitution.md")),
    ).rejects.toThrow(/ENOENT/);
  });

  it("does NOT overwrite an existing constitution.md without --force (flag-driven)", async () => {
    const p = await freshProject("exists-no-force");
    await mkdir(join(p.dir, "design"), { recursive: true });
    await writeFile(join(p.dir, "design/constitution.md"), "existing\n", "utf8");
    const res = p.run([
      "plan",
      "constitution",
      "--description",
      "fresh",
      "--principle",
      "p1",
      "--json",
    ]);
    expect(res.code).toBe(2);
    const env = JSON.parse(res.stdout) as JsonEnvelope<unknown>;
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error.code).toBe("ALREADY_EXISTS");
    const after = await readFile(join(p.dir, "design/constitution.md"), "utf8");
    expect(after).toBe("existing\n");
  });

  it("--force overrides the file-exists short-circuit (--stdin)", async () => {
    const p = await freshProject("exists-force");
    await mkdir(join(p.dir, "design"), { recursive: true });
    await writeFile(join(p.dir, "design/constitution.md"), "stale\n", "utf8");
    const res = p.run(
      ["plan", "constitution", "--stdin", "--force", "--json"],
      { input: VALID_YAML },
    );
    expect(res.code).toBe(0);
    const after = await readFile(join(p.dir, "design/constitution.md"), "utf8");
    expect(after).toContain("Vendor neutrality");
    expect(after).not.toContain("stale");
  });
});
