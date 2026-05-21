// `plan brief --stdin` integration tests — v1.6 P17-T2.
//
// Verifies:
//   * Non-TTY + --stdin <valid YAML on stdin> → succeeds, writes
//     design/brief.md, emits the standard success envelope under --json.
//   * --stdin + --from-file → CONFIG_ERROR exit 2 (mutex contract).
//   * --stdin with malformed YAML / schema-invalid input → CONFIG_ERROR
//     exit 2 with `data.detail` + `data.source: "stdin"`.
//   * --stdin honours the existing file-exists short-circuit and the
//     --force override.

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
    prefix: `code-pact-plan-brief-stdin-${prefix}-`,
  });
  cleanups.push(p.cleanup);
  return p;
}

const VALID_YAML = [
  "what: A control plane for AI coding agents.",
  "who: Software teams using AI coding agents.",
  "differentiator: Vendor-neutral, deterministic CLI.",
  "",
].join("\n");

describe("plan brief --stdin (success path)", () => {
  it("reads YAML from stdin and writes design/brief.md (--json envelope)", async () => {
    const p = await freshProject("success");
    const res = p.run(["plan", "brief", "--stdin", "--json"], {
      input: VALID_YAML,
    });
    expect(res.code).toBe(0);
    const env = JSON.parse(res.stdout) as JsonEnvelope<{ path: string }>;
    expect(env.ok).toBe(true);
    if (env.ok) expect(env.data.path).toContain("design/brief.md");

    const written = await readFile(join(p.dir, "design/brief.md"), "utf8");
    expect(written).toContain("A control plane for AI coding agents.");
    expect(written).toContain("Software teams using AI coding agents.");
    expect(written).toContain("Vendor-neutral, deterministic CLI.");
  });

  it("works without --json (human-mode brief.md is produced)", async () => {
    const p = await freshProject("success-human");
    const res = p.run(["plan", "brief", "--stdin"], { input: VALID_YAML });
    expect(res.code).toBe(0);
    const written = await readFile(join(p.dir, "design/brief.md"), "utf8");
    expect(written).toContain("Project Brief");
  });

  it("differentiator omitted → placeholder fills in (parity with --from-file)", async () => {
    const p = await freshProject("no-diff");
    const res = p.run(["plan", "brief", "--stdin", "--json"], {
      input: "what: x\nwho: y\n",
    });
    expect(res.code).toBe(0);
    const written = await readFile(join(p.dir, "design/brief.md"), "utf8");
    expect(written).toContain("What makes it different");
  });
});

describe("plan brief --stdin (mutex with --from-file)", () => {
  it("--stdin + --from-file → CONFIG_ERROR exit 2", async () => {
    const p = await freshProject("mutex");
    // Write a valid file so --from-file would otherwise succeed.
    await mkdir(join(p.dir, "input"), { recursive: true });
    await writeFile(join(p.dir, "input/brief.yaml"), VALID_YAML, "utf8");
    const res = p.run(
      ["plan", "brief", "--stdin", "--from-file", "input/brief.yaml", "--json"],
      { input: VALID_YAML },
    );
    expect(res.code).toBe(2);
    const env = JSON.parse(res.stdout) as JsonEnvelope<unknown>;
    expect(env.ok).toBe(false);
    if (!env.ok) {
      expect(env.error.code).toBe("CONFIG_ERROR");
      expect(env.error.message).toContain("mutually exclusive");
    }
    // Partial-write guard: brief.md must not have been touched.
    await expect(
      readFile(join(p.dir, "design/brief.md")),
    ).rejects.toThrow(/ENOENT/);
  });
});

describe("plan brief --stdin (error matrix)", () => {
  it("malformed YAML → CONFIG_ERROR with detail=invalid_yaml + source=stdin", async () => {
    const p = await freshProject("malformed");
    const res = p.run(["plan", "brief", "--stdin", "--json"], {
      input: "what: [unclosed\n",
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

  it("schema violation (missing required field) → CONFIG_ERROR with detail=schema_invalid", async () => {
    const p = await freshProject("schema-missing");
    const res = p.run(["plan", "brief", "--stdin", "--json"], {
      input: "what: only-what\n",
    });
    expect(res.code).toBe(2);
    const env = JSON.parse(res.stdout) as JsonEnvelope<unknown>;
    expect(env.ok).toBe(false);
    if (!env.ok) {
      const data = env.data as { detail?: string; source?: string } | undefined;
      expect(data?.detail).toBe("schema_invalid");
      expect(data?.source).toBe("stdin");
    }
  });

  it("schema violation (unknown key) → CONFIG_ERROR with detail=schema_invalid", async () => {
    const p = await freshProject("schema-extra");
    const res = p.run(["plan", "brief", "--stdin", "--json"], {
      input: "what: x\nwho: y\nbogus: 1\n",
    });
    expect(res.code).toBe(2);
    const env = JSON.parse(res.stdout) as JsonEnvelope<unknown>;
    expect(env.ok).toBe(false);
    if (!env.ok) {
      const data = env.data as { detail?: string } | undefined;
      expect(data?.detail).toBe("schema_invalid");
    }
  });

  it("no design/brief.md is written on failure (partial-write guard)", async () => {
    const p = await freshProject("no-partial-write");
    const res = p.run(["plan", "brief", "--stdin", "--json"], {
      input: "what: [unclosed\n",
    });
    expect(res.code).toBe(2);
    await expect(
      readFile(join(p.dir, "design/brief.md")),
    ).rejects.toThrow(/ENOENT/);
  });
});

describe("plan brief --stdin (existing-file semantics)", () => {
  it("does NOT overwrite an existing design/brief.md without --force", async () => {
    const p = await freshProject("exists-no-force");
    await mkdir(join(p.dir, "design"), { recursive: true });
    await writeFile(join(p.dir, "design/brief.md"), "existing\n", "utf8");
    const res = p.run(["plan", "brief", "--stdin", "--json"], {
      input: VALID_YAML,
    });
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
    const res = p.run(["plan", "brief", "--stdin", "--force", "--json"], {
      input: VALID_YAML,
    });
    expect(res.code).toBe(0);
    const after = await readFile(join(p.dir, "design/brief.md"), "utf8");
    expect(after).toContain("A control plane for AI coding agents.");
    expect(after).not.toContain("stale");
  });
});

describe("plan brief (regression — TTY contract preserved with new --stdin)", () => {
  it("plan brief WITHOUT --stdin or --from-file in non-TTY still returns CONFIG_ERROR exit 2", async () => {
    const p = await freshProject("regression-tty");
    const res = p.run(["plan", "brief", "--json"]);
    expect(res.code).toBe(2);
    const env = JSON.parse(res.stdout) as JsonEnvelope<unknown>;
    expect(env.ok).toBe(false);
    if (!env.ok) {
      expect(env.error.code).toBe("CONFIG_ERROR");
      // v1.6 P17-T2/T3: the message lists all three non-interactive
      // input modes (--from-file, --stdin, --what/--who).
      expect(env.error.message).toContain("--from-file");
      expect(env.error.message).toContain("--stdin");
      expect(env.error.message).toContain("--what/--who");
    }
  });
});
