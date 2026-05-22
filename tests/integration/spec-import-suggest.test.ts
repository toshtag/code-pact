// `spec import --suggest-from` integration tests — v1.8 P18-T4.
//
// Verifies:
//   * Successful extraction → brief_candidates + constitution_candidates emitted
//   * mutex_violation when --from + --suggest-from both passed
//   * missing source → CONFIG_ERROR detail=file_not_found
//   * unsafe path → CONFIG_ERROR detail=unsafe_path
//   * read-only: never writes any file

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

async function readSafely(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

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
    prefix: `code-pact-spec-suggest-${prefix}-`,
  });
  cleanups.push(p.cleanup);
  return p;
}

async function writeFixture(p: Project, rel: string, content: string): Promise<void> {
  const abs = join(p.dir, rel);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, content, "utf8");
}

const SAMPLE_SPEC_MD = [
  "# Spec",
  "",
  "## Problem statement",
  "Teams need a deterministic control plane.",
  "",
  "## Audience",
  "Senior engineers working with AI coding agents.",
  "",
  "## Positioning",
  "Vendor-neutral CLI.",
  "",
  "## Background",
  "Existing tools couple too tightly to specific vendors.",
  "",
  "## Principles",
  "- Bias for additive change.",
  "- Avoid breaking the public contract.",
  "",
  "## Implementation notes",
  "Skipped section content.",
].join("\n");

interface StrictData {
  source_path?: string;
  brief_candidates?: {
    what?: string;
    who?: string;
    differentiator?: string;
  };
  constitution_candidates?: {
    description?: string;
    principles?: string[];
  };
  recognised_sections?: string[];
  skipped_sections?: string[];
  detail?: string;
}

describe("spec import --suggest-from <path>", () => {
  it("emits brief + constitution candidates and lists skipped sections", async () => {
    const p = await freshProject("ok");
    await writeFixture(p, "spec.md", SAMPLE_SPEC_MD);

    const res = p.run(["spec", "import", "--suggest-from", "spec.md", "--json"]);
    expect(res.code).toBe(0);
    const env = JSON.parse(res.stdout) as JsonEnvelope<StrictData>;
    expect(env.ok).toBe(true);
    const data = env.data as StrictData | undefined;
    expect(data?.source_path).toBe("spec.md");
    expect(data?.brief_candidates?.what).toBe("Teams need a deterministic control plane.");
    expect(data?.brief_candidates?.who).toBe("Senior engineers working with AI coding agents.");
    expect(data?.brief_candidates?.differentiator).toBe("Vendor-neutral CLI.");
    expect(data?.constitution_candidates?.description).toBe(
      "Existing tools couple too tightly to specific vendors.",
    );
    expect(data?.constitution_candidates?.principles).toEqual([
      "Bias for additive change.",
      "Avoid breaking the public contract.",
    ]);
    expect(data?.skipped_sections).toContain("Implementation notes");
  });

  it("--from + --suggest-from both passed → mutex_violation", async () => {
    const p = await freshProject("mutex");
    await writeFixture(p, "tasks.md", "### S\n- [ ] T\n");
    await writeFixture(p, "spec.md", "## Problem\nx.");

    const res = p.run([
      "spec", "import", "--from", "tasks.md", "--suggest-from", "spec.md",
      "--phase-id", "PA", "--json",
    ]);
    expect(res.code).toBe(2);
    const env = JSON.parse(res.stdout) as JsonEnvelope<StrictData>;
    expect(env.ok).toBe(false);
    if (!env.ok) {
      expect(env.error.code).toBe("CONFIG_ERROR");
      const data = env.data as StrictData | undefined;
      expect(data?.detail).toBe("mutex_violation");
    }
  });

  it("missing --from without --phase-id → CONFIG_ERROR missing source", async () => {
    const p = await freshProject("missing-from");
    const res = p.run(["spec", "import", "--json"]);
    expect(res.code).toBe(2);
    const env = JSON.parse(res.stdout) as JsonEnvelope<StrictData>;
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error.code).toBe("CONFIG_ERROR");
  });

  it("--from without --phase-id → CONFIG_ERROR detail=missing_phase_id", async () => {
    const p = await freshProject("missing-phase-id");
    await writeFixture(p, "tasks.md", "### S\n- [ ] T\n");
    const res = p.run(["spec", "import", "--from", "tasks.md", "--json"]);
    expect(res.code).toBe(2);
    const env = JSON.parse(res.stdout) as JsonEnvelope<StrictData>;
    if (!env.ok) {
      const data = env.data as StrictData | undefined;
      expect(data?.detail).toBe("missing_phase_id");
    }
  });

  it("--suggest-from with absolute path → CONFIG_ERROR detail=unsafe_path", async () => {
    const p = await freshProject("unsafe");
    const res = p.run(["spec", "import", "--suggest-from", "/etc/passwd", "--json"]);
    expect(res.code).toBe(2);
    const env = JSON.parse(res.stdout) as JsonEnvelope<StrictData>;
    if (!env.ok) {
      const data = env.data as StrictData | undefined;
      expect(data?.detail).toBe("unsafe_path");
    }
  });

  it("--suggest-from with missing file → CONFIG_ERROR detail=file_not_found", async () => {
    const p = await freshProject("missing-file");
    const res = p.run(["spec", "import", "--suggest-from", "nope.md", "--json"]);
    expect(res.code).toBe(2);
    const env = JSON.parse(res.stdout) as JsonEnvelope<StrictData>;
    if (!env.ok) {
      const data = env.data as StrictData | undefined;
      expect(data?.detail).toBe("file_not_found");
    }
  });

  it("read-only: --suggest-from does not modify design/brief.md or design/constitution.md", async () => {
    const p = await freshProject("readonly");
    await writeFixture(p, "spec.md", SAMPLE_SPEC_MD);

    const briefPath = join(p.dir, "design/brief.md");
    const constPath = join(p.dir, "design/constitution.md");
    const briefBefore = await readSafely(briefPath);
    const constBefore = await readSafely(constPath);

    const res = p.run(["spec", "import", "--suggest-from", "spec.md", "--json"]);
    expect(res.code).toBe(0);

    const briefAfter = await readSafely(briefPath);
    const constAfter = await readSafely(constPath);
    expect(briefAfter).toBe(briefBefore);
    expect(constAfter).toBe(constBefore);
  });

  it("--suggest-from ignores --phase-id silently (no error)", async () => {
    const p = await freshProject("ignore-phase-id");
    await writeFixture(p, "spec.md", SAMPLE_SPEC_MD);
    const res = p.run([
      "spec", "import", "--suggest-from", "spec.md", "--phase-id", "PA", "--json",
    ]);
    expect(res.code).toBe(0);
    const env = JSON.parse(res.stdout) as JsonEnvelope<StrictData>;
    expect(env.ok).toBe(true);
  });
});
