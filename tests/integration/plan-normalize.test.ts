import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliPath, ensureCliBuilt } from "../helpers/cli.ts";

let tmpDir: string;

type RunResult = { code: number; stdout: string; stderr: string };

function run(args: string[]): RunResult {
  const res = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: tmpDir,
    encoding: "utf8",
    env: process.env,
  });
  return {
    code: res.status ?? -1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

beforeAll(() => {
  ensureCliBuilt();
}, 60_000);

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "code-pact-plan-norm-int-"));
  await mkdir(join(tmpDir, "design", "phases"), { recursive: true });
});

afterAll(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

type NormalizeJson = {
  ok: boolean;
  error?: { code: string; message: string };
  data?: {
    mode: "check" | "write";
    changed_count: number;
    changes: Array<{ path: string; kind: string; reasons: string[] }>;
    written: string[];
  };
};

function parseNormalize(stdout: string): NormalizeJson {
  return JSON.parse(stdout) as NormalizeJson;
}

describe("plan normalize", () => {
  it("clean tree: ok=true, exit 0", async () => {
    await writeFile(
      join(tmpDir, "design", "roadmap.yaml"),
      "phases: []\n",
      "utf8",
    );

    const res = run(["plan", "normalize", "--json"]);
    expect(res.code).toBe(0);
    const parsed = parseNormalize(res.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.data?.mode).toBe("check");
    expect(parsed.data?.changed_count).toBe(0);
  });

  it("dirty tree --check: ok=false, exit 1, PLAN_NORMALIZE_REQUIRED, file unchanged on disk", async () => {
    const path = join(tmpDir, "design", "roadmap.yaml");
    const dirty = "phases: []   \n\n\n";
    await writeFile(path, dirty, "utf8");

    const res = run(["plan", "normalize", "--check", "--json"]);
    expect(res.code).toBe(1);
    const parsed = parseNormalize(res.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error?.code).toBe("PLAN_NORMALIZE_REQUIRED");
    expect(parsed.data?.changed_count).toBeGreaterThanOrEqual(1);

    // Critical safety: --check must not touch the file.
    const onDisk = await readFile(path, "utf8");
    expect(onDisk).toBe(dirty);
  });

  it("dirty tree --write: rewrites the file, then --check reports clean", async () => {
    const path = join(tmpDir, "design", "phases", "P1.yaml");
    await writeFile(path, "id: P1  \r\n", "utf8");

    const write = run(["plan", "normalize", "--write", "--json"]);
    expect(write.code).toBe(0);
    const writeParsed = parseNormalize(write.stdout);
    expect(writeParsed.ok).toBe(true);
    expect(writeParsed.data?.mode).toBe("write");
    expect(writeParsed.data?.written).toContain("design/phases/P1.yaml");

    const onDisk = await readFile(path, "utf8");
    expect(onDisk).toBe("id: P1\n");

    const check = run(["plan", "normalize", "--check", "--json"]);
    expect(check.code).toBe(0);
    expect(parseNormalize(check.stdout).data?.changed_count).toBe(0);
  });

  it("--check and --write together: PLAN_NORMALIZE_CONFLICT exit 2", async () => {
    const res = run(["plan", "normalize", "--check", "--write", "--json"]);
    expect(res.code).toBe(2);
    const parsed = parseNormalize(res.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error?.code).toBe("PLAN_NORMALIZE_CONFLICT");
  });

  it("typo flag is rejected with exit 2 (not a silent no-op)", async () => {
    const res = run(["plan", "normalize", "--wite", "--json"]);
    expect(res.code).toBe(2);
    const parsed = parseNormalize(res.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error?.code).toBe("CONFIG_ERROR");
    expect(parsed.error?.message).toContain("--wite");
  });

  it("YAML comments survive --write end-to-end", async () => {
    const path = join(tmpDir, "design", "phases", "P1.yaml");
    const original =
      "# Comment kept\nid: P1\n# Trailing comment with spaces  \nname: P1\n";
    await writeFile(path, original, "utf8");

    run(["plan", "normalize", "--write", "--json"]);
    const after = await readFile(path, "utf8");
    expect(after).toContain("# Comment kept");
    expect(after).toContain("# Trailing comment with spaces");
  });

  it("Markdown two-space hard line breaks survive --write end-to-end", async () => {
    const path = join(tmpDir, "design", "notes.md");
    await writeFile(path, "line A  \nline B\r\n", "utf8");

    run(["plan", "normalize", "--write", "--json"]);
    const after = await readFile(path, "utf8");
    expect(after).toBe("line A  \nline B\n");
  });
});
