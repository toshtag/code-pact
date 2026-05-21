// `plan brief --from-file <yaml>` integration tests — v1.6 P17-T1.
//
// Verifies:
//   * Non-TTY + --from-file <valid> → succeeds, writes design/brief.md,
//     emits the standard success envelope under --json.
//   * Non-TTY without --from-file → CONFIG_ERROR exit 2 (v1.5.1
//     contract preserved).
//   * --from-file <missing | malformed | schema-invalid> → CONFIG_ERROR
//     exit 2 with structured envelope (detail + path on `data`).
//   * --from-file with --json never invokes the wizard (no stdin
//     interaction is possible in the subprocess test harness, so the
//     fact that the command completes without hanging is itself the
//     proof).

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
    prefix: `code-pact-plan-brief-from-file-${prefix}-`,
  });
  cleanups.push(p.cleanup);
  return p;
}

async function writeYaml(p: Project, rel: string, content: string): Promise<void> {
  const abs = join(p.dir, rel);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, content, "utf8");
}

const VALID_YAML = [
  "what: A control plane for AI coding agents.",
  "who: Software teams using AI coding agents.",
  "differentiator: Vendor-neutral, deterministic CLI.",
  "",
].join("\n");

describe("plan brief --from-file (non-TTY success path)", () => {
  it("writes design/brief.md and emits the success JSON envelope", async () => {
    const p = await freshProject("success");
    await writeYaml(p, "input/brief.yaml", VALID_YAML);
    const res = p.run([
      "plan",
      "brief",
      "--from-file",
      "input/brief.yaml",
      "--json",
    ]);
    expect(res.code).toBe(0);
    const env = JSON.parse(res.stdout) as JsonEnvelope<{ path: string }>;
    expect(env.ok).toBe(true);
    if (env.ok) {
      expect(env.data.path).toContain("design/brief.md");
    }
    const written = await readFile(join(p.dir, "design/brief.md"), "utf8");
    expect(written).toContain("A control plane for AI coding agents.");
    expect(written).toContain("Software teams using AI coding agents.");
    expect(written).toContain("Vendor-neutral, deterministic CLI.");
  });

  it("works without --json (human stdout / stderr split preserved)", async () => {
    const p = await freshProject("success-human");
    await writeYaml(p, "input/brief.yaml", VALID_YAML);
    const res = p.run(["plan", "brief", "--from-file", "input/brief.yaml"]);
    expect(res.code).toBe(0);
    // Human-mode emits the completion message to stderr (per
    // existing wizard contract); stdout stays empty / informational.
    const briefPath = join(p.dir, "design/brief.md");
    const written = await readFile(briefPath, "utf8");
    expect(written).toContain("Project Brief");
  });

  it("differentiator omitted → placeholder template fills in", async () => {
    const p = await freshProject("no-diff");
    await writeYaml(
      p,
      "input/brief.yaml",
      ["what: x", "who: y", ""].join("\n"),
    );
    const res = p.run([
      "plan",
      "brief",
      "--from-file",
      "input/brief.yaml",
      "--json",
    ]);
    expect(res.code).toBe(0);
    const written = await readFile(join(p.dir, "design/brief.md"), "utf8");
    // The placeholder is locale-dependent text; just assert the
    // section header exists and the file is non-empty.
    expect(written).toContain("What makes it different");
    expect(written.length).toBeGreaterThan(0);
  });
});

describe("plan brief --from-file (regression — TTY contract preserved)", () => {
  it("plan brief WITHOUT --from-file in non-TTY still returns CONFIG_ERROR exit 2", async () => {
    // This is the v1.5.1 behaviour. P17-T1 must not weaken it.
    const p = await freshProject("regression-no-from-file");
    const res = p.run(["plan", "brief", "--json"]);
    expect(res.code).toBe(2);
    const env = JSON.parse(res.stdout) as JsonEnvelope<unknown>;
    expect(env.ok).toBe(false);
    if (!env.ok) {
      expect(env.error.code).toBe("CONFIG_ERROR");
      // The v1.6 message now also points users at --from-file.
      expect(env.error.message).toContain("TTY");
      expect(env.error.message).toContain("--from-file");
    }
  });
});

describe("plan brief --from-file (error matrix)", () => {
  it("missing file → CONFIG_ERROR with detail=unreadable", async () => {
    const p = await freshProject("missing");
    const res = p.run([
      "plan",
      "brief",
      "--from-file",
      "does-not-exist.yaml",
      "--json",
    ]);
    expect(res.code).toBe(2);
    const env = JSON.parse(res.stdout) as JsonEnvelope<unknown>;
    expect(env.ok).toBe(false);
    if (!env.ok) {
      expect(env.error.code).toBe("CONFIG_ERROR");
      const data = env.data as { detail?: string; path?: string } | undefined;
      expect(data?.detail).toBe("unreadable");
      expect(data?.path).toBe("does-not-exist.yaml");
    }
  });

  it("malformed YAML → CONFIG_ERROR with detail=invalid_yaml", async () => {
    const p = await freshProject("malformed");
    await writeYaml(p, "input/bad.yaml", "what: [unclosed\n");
    const res = p.run([
      "plan",
      "brief",
      "--from-file",
      "input/bad.yaml",
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

  it("schema violation (missing required field) → CONFIG_ERROR with detail=schema_invalid", async () => {
    const p = await freshProject("schema-missing");
    await writeYaml(p, "input/partial.yaml", "what: only-what\n");
    const res = p.run([
      "plan",
      "brief",
      "--from-file",
      "input/partial.yaml",
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

  it("schema violation (unknown key) → CONFIG_ERROR with detail=schema_invalid", async () => {
    const p = await freshProject("schema-extra");
    await writeYaml(
      p,
      "input/extra.yaml",
      "what: x\nwho: y\nbogus: 1\n",
    );
    const res = p.run([
      "plan",
      "brief",
      "--from-file",
      "input/extra.yaml",
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

  it("unsafe path (absolute) → CONFIG_ERROR with detail=unsafe_path", async () => {
    const p = await freshProject("unsafe");
    const res = p.run([
      "plan",
      "brief",
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

  it("no design/brief.md is written on failure (partial-write guard)", async () => {
    const p = await freshProject("no-partial-write");
    const res = p.run([
      "plan",
      "brief",
      "--from-file",
      "missing.yaml",
      "--json",
    ]);
    expect(res.code).toBe(2);
    await expect(
      readFile(join(p.dir, "design/brief.md")),
    ).rejects.toThrow(/ENOENT/);
  });
});

describe("plan brief --from-file (existing-file semantics)", () => {
  it("does NOT overwrite an existing design/brief.md without --force", async () => {
    const p = await freshProject("exists-no-force");
    await mkdir(join(p.dir, "design"), { recursive: true });
    await writeFile(join(p.dir, "design/brief.md"), "existing\n", "utf8");
    await writeYaml(p, "input/brief.yaml", VALID_YAML);
    const res = p.run([
      "plan",
      "brief",
      "--from-file",
      "input/brief.yaml",
      "--json",
    ]);
    // The existing file-exists short-circuit returns ALREADY_EXISTS
    // / exit 2 (matches the wizard path's behaviour).
    expect(res.code).toBe(2);
    const env = JSON.parse(res.stdout) as JsonEnvelope<unknown>;
    expect(env.ok).toBe(false);
    if (!env.ok) {
      expect(env.error.code).toBe("ALREADY_EXISTS");
    }
    const after = await readFile(join(p.dir, "design/brief.md"), "utf8");
    expect(after).toBe("existing\n");
  });

  it("--force overrides the file-exists short-circuit", async () => {
    const p = await freshProject("exists-force");
    await mkdir(join(p.dir, "design"), { recursive: true });
    await writeFile(join(p.dir, "design/brief.md"), "stale\n", "utf8");
    await writeYaml(p, "input/brief.yaml", VALID_YAML);
    const res = p.run([
      "plan",
      "brief",
      "--from-file",
      "input/brief.yaml",
      "--force",
      "--json",
    ]);
    expect(res.code).toBe(0);
    const after = await readFile(join(p.dir, "design/brief.md"), "utf8");
    expect(after).toContain("A control plane for AI coding agents.");
    expect(after).not.toContain("stale");
  });
});
