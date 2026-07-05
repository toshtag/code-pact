// `spec import` integration tests — v1.8 P18-T3.
//
// Verifies:
//   * dry-run default emits success envelope with phase_yaml + kind=would_import
//   * --write persists design/phases/<id>-imported.yaml
//   * collision without --force returns CONFIG_ERROR with detail=phase_yaml_exists
//   * --force overwrites
//   * missing --from / --phase-id → CONFIG_ERROR
//   * unsafe path → CONFIG_ERROR detail=unsafe_path
//   * non-existent file → CONFIG_ERROR detail=file_not_found
//   * input with no Heading 3 → CONFIG_ERROR detail=no_sections_parsed
//   * invalid phase-id → CONFIG_ERROR detail=phase_id_invalid

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
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
    prefix: `code-pact-spec-import-${prefix}-`,
  });
  cleanups.push(p.cleanup);
  return p;
}

async function writeFixture(p: Project, rel: string, content: string): Promise<void> {
  const abs = join(p.dir, rel);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, content, "utf8");
}

const SAMPLE_TASKS_MD = [
  "# Project tasks",
  "",
  "Some intro prose.",
  "",
  "### Setup",
  "",
  "- [ ] Install dependencies",
  "- [ ] Configure environment",
  "",
  "### Implementation",
  "",
  "- [ ] Build the parser",
  "- [x] Write the migration (already done)",
  "- [ ] Wire CLI command",
  "",
].join("\n");

interface StrictData {
  kind?: "would_import" | "imported";
  sections_imported?: number;
  tasks_imported?: number;
  skipped_lines?: number;
  output_path?: string | null;
  phase_yaml?: string;
  warnings?: string[];
  detail?: string;
  source_path?: string | null;
  phase_id?: string | null;
}

describe("spec import --from <path> --phase-id <id>", () => {
  it("dry-run default returns would_import envelope with phase_yaml", async () => {
    const p = await freshProject("dryrun");
    await writeFixture(p, "tasks.md", SAMPLE_TASKS_MD);

    const res = p.run(["spec", "import", "--from", "tasks.md", "--phase-id", "PX", "--json"]);
    expect(res.code).toBe(0);
    const env = JSON.parse(res.stdout) as JsonEnvelope<StrictData>;
    expect(env.ok).toBe(true);
    const data = env.data as StrictData | undefined;
    expect(data?.kind).toBe("would_import");
    expect(data?.sections_imported).toBe(2);
    expect(data?.tasks_imported).toBe(4);
    expect(data?.output_path).toBeNull();
    expect(data?.phase_yaml).toContain("id: PX");
    expect(data?.phase_yaml).toContain("description: \"[Setup] Install dependencies\"");
  });

  it("--write persists design/phases/<id>-imported.yaml", async () => {
    const p = await freshProject("write");
    await writeFixture(p, "tasks.md", SAMPLE_TASKS_MD);

    const res = p.run(["spec", "import", "--from", "tasks.md", "--phase-id", "PY", "--write", "--json"]);
    expect(res.code).toBe(0);
    const env = JSON.parse(res.stdout) as JsonEnvelope<StrictData>;
    expect(env.ok).toBe(true);
    const data = env.data as StrictData | undefined;
    expect(data?.kind).toBe("imported");
    expect(data?.output_path).toBe("design/phases/PY-imported.yaml");

    const written = await readFile(join(p.dir, "design/phases/PY-imported.yaml"), "utf8");
    expect(written).toContain("id: PY");
    expect(written).toContain("[Implementation] Wire CLI command");
  });

  it("collision without --force returns CONFIG_ERROR detail=phase_yaml_exists", async () => {
    const p = await freshProject("collision");
    await writeFixture(p, "tasks.md", SAMPLE_TASKS_MD);
    await writeFixture(p, "design/phases/PZ-imported.yaml", "existing: true\n");

    const res = p.run(["spec", "import", "--from", "tasks.md", "--phase-id", "PZ", "--write", "--json"]);
    expect(res.code).toBe(2);
    const env = JSON.parse(res.stdout) as JsonEnvelope<StrictData>;
    expect(env.ok).toBe(false);
    if (!env.ok) {
      expect(env.error.code).toBe("CONFIG_ERROR");
      const data = env.data as StrictData | undefined;
      expect(data?.detail).toBe("phase_yaml_exists");
    }
  });

  it("--force overwrites existing imported file", async () => {
    const p = await freshProject("force");
    await writeFixture(p, "tasks.md", SAMPLE_TASKS_MD);
    await writeFixture(p, "design/phases/PW-imported.yaml", "old: content\n");

    const res = p.run([
      "spec", "import", "--from", "tasks.md", "--phase-id", "PW", "--write", "--force", "--json",
    ]);
    expect(res.code).toBe(0);
    const written = await readFile(join(p.dir, "design/phases/PW-imported.yaml"), "utf8");
    expect(written).toContain("id: PW");
    expect(written).not.toContain("old: content");
  });

  it("missing --from returns CONFIG_ERROR", async () => {
    const p = await freshProject("no-from");
    const res = p.run(["spec", "import", "--phase-id", "PA", "--json"]);
    expect(res.code).toBe(2);
    const env = JSON.parse(res.stdout) as JsonEnvelope<StrictData>;
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error.code).toBe("CONFIG_ERROR");
  });

  it("missing --phase-id returns CONFIG_ERROR", async () => {
    const p = await freshProject("no-phase-id");
    await writeFixture(p, "tasks.md", SAMPLE_TASKS_MD);
    const res = p.run(["spec", "import", "--from", "tasks.md", "--json"]);
    expect(res.code).toBe(2);
    const env = JSON.parse(res.stdout) as JsonEnvelope<StrictData>;
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error.code).toBe("CONFIG_ERROR");
  });

  it("absolute path rejected with detail=unsafe_path", async () => {
    const p = await freshProject("unsafe-path");
    const res = p.run(["spec", "import", "--from", "/etc/passwd", "--phase-id", "PA", "--json"]);
    expect(res.code).toBe(2);
    const env = JSON.parse(res.stdout) as JsonEnvelope<StrictData>;
    expect(env.ok).toBe(false);
    if (!env.ok) {
      expect(env.error.code).toBe("CONFIG_ERROR");
      const data = env.data as StrictData | undefined;
      expect(data?.detail).toBe("unsafe_path");
    }
  });

  it("missing source file → CONFIG_ERROR detail=file_not_found", async () => {
    const p = await freshProject("missing-file");
    const res = p.run(["spec", "import", "--from", "no-such.md", "--phase-id", "PA", "--json"]);
    expect(res.code).toBe(2);
    const env = JSON.parse(res.stdout) as JsonEnvelope<StrictData>;
    const data = env.data as StrictData | undefined;
    expect(data?.detail).toBe("file_not_found");
  });

  it("no sections → CONFIG_ERROR detail=no_sections_parsed", async () => {
    const p = await freshProject("no-sections");
    await writeFixture(p, "empty.md", "Just prose, no sections.\n");
    const res = p.run(["spec", "import", "--from", "empty.md", "--phase-id", "PA", "--json"]);
    expect(res.code).toBe(2);
    const env = JSON.parse(res.stdout) as JsonEnvelope<StrictData>;
    const data = env.data as StrictData | undefined;
    expect(data?.detail).toBe("no_sections_parsed");
  });

  it("invalid phase-id (starts with digit) → CONFIG_ERROR detail=phase_id_invalid", async () => {
    const p = await freshProject("bad-id");
    await writeFixture(p, "tasks.md", SAMPLE_TASKS_MD);
    const res = p.run(["spec", "import", "--from", "tasks.md", "--phase-id", "1bad", "--json"]);
    expect(res.code).toBe(2);
    const env = JSON.parse(res.stdout) as JsonEnvelope<StrictData>;
    const data = env.data as StrictData | undefined;
    expect(data?.detail).toBe("phase_id_invalid");
  });

  it("dry-run does not write any file", async () => {
    const p = await freshProject("no-write");
    await writeFixture(p, "tasks.md", SAMPLE_TASKS_MD);
    const res = p.run(["spec", "import", "--from", "tasks.md", "--phase-id", "PN", "--json"]);
    expect(res.code).toBe(0);
    let exists = false;
    try {
      await stat(join(p.dir, "design/phases/PN-imported.yaml"));
      exists = true;
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });
});
