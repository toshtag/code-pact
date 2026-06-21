// Per-section coverage for the P10 Task Readiness Schema declared
// sections rendered by `buildContextPack`. The byte-identical
// regression test in tests/integration/pack-byte-identical.test.ts
// locks the v1.0.2 baseline; this file covers the OTHER direction:
// when the new fields ARE declared, the right sections appear in the
// pack with the documented content.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContextPack } from "../../../src/core/pack/index.ts";

let work: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "code-pact-pack-declared-"));
});

afterEach(async () => {
  if (work) await rm(work, { recursive: true, force: true });
});

type FixtureOpts = {
  taskExtras?: Record<string, unknown>;
  decisions?: Record<string, string>;
  extraFiles?: Record<string, string>;
  progressYaml?: string;
};

// Sets up a minimal project tree with one phase and one task. The task
// inherits a v1.0.2-shaped baseline; opts.taskExtras is merged on top
// so each test can declare the P10 optional fields it cares about
// without restating the baseline.
async function setupProject(opts: FixtureOpts = {}): Promise<void> {
  const baselineTask = {
    id: "P1-T1",
    type: "feature",
    ambiguity: "low",
    risk: "low",
    context_size: "small",
    write_surface: "low",
    verification_strength: "medium",
    expected_duration: "short",
    status: "planned",
    description: "Sample task for pack declared-sections tests",
    ...opts.taskExtras,
  };
  await mkdir(join(work, "design", "phases"), { recursive: true });
  await mkdir(join(work, ".code-pact", "state"), { recursive: true });
  await writeFile(
    join(work, "design", "roadmap.yaml"),
    `phases:\n  - id: P1\n    path: design/phases/P1-foundation.yaml\n    weight: 10\n`,
    "utf8",
  );
  await writeFile(
    join(work, "design", "phases", "P1-foundation.yaml"),
    yaml({
      id: "P1",
      name: "Foundation",
      weight: 10,
      confidence: "medium",
      risk: "low",
      status: "planned",
      objective: "Establish the project foundation",
      definition_of_done: ["All tasks done"],
      verification: { commands: ["node --version"] },
      tasks: [baselineTask],
    }),
    "utf8",
  );
  for (const [filename, body] of Object.entries(opts.decisions ?? {})) {
    await mkdir(join(work, "design", "decisions"), { recursive: true });
    await writeFile(join(work, "design", "decisions", filename), body, "utf8");
  }
  for (const [relPath, body] of Object.entries(opts.extraFiles ?? {})) {
    await mkdir(join(work, relPath, ".."), { recursive: true });
    await writeFile(join(work, relPath), body, "utf8");
  }
  await writeFile(
    join(work, ".code-pact", "state", "progress.yaml"),
    opts.progressYaml ?? "events: []\n",
    "utf8",
  );
}

// Minimal YAML emitter for the shapes used in these tests — keeps each
// test self-contained without pulling in the yaml package's options.
function yaml(obj: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  if (obj === null || obj === undefined) return "null";
  if (typeof obj === "string") {
    if (obj.includes("\n") || obj.includes(":")) return JSON.stringify(obj);
    return obj;
  }
  if (typeof obj === "number" || typeof obj === "boolean") return String(obj);
  if (Array.isArray(obj)) {
    if (obj.length === 0) return "[]";
    return obj
      .map((v) => {
        if (typeof v === "object" && v !== null) {
          const inner = yaml(v, indent + 1);
          return `${pad}-\n${inner}`;
        }
        return `${pad}- ${yaml(v, indent + 1)}`;
      })
      .join("\n");
  }
  if (typeof obj === "object") {
    return Object.entries(obj)
      .map(([k, v]) => {
        if (Array.isArray(v) || (typeof v === "object" && v !== null)) {
          const inner = yaml(v, indent + 1);
          return `${pad}${k}:\n${inner}`;
        }
        return `${pad}${k}: ${yaml(v, indent + 1)}`;
      })
      .join("\n");
  }
  return String(obj);
}

async function buildPack(): Promise<string> {
  const pack = await buildContextPack({
    cwd: work,
    phaseId: "P1",
    taskId: "P1-T1",
    agentName: "claude-code",
  });
  return pack.content;
}

describe("buildContextPack — Depends on section", () => {
  it("omits the section when depends_on is undefined", async () => {
    await setupProject();
    const out = await buildPack();
    expect(out).not.toContain("## Depends on");
  });

  it("renders each dependency id with its derived state from progress.yaml", async () => {
    await setupProject({
      taskExtras: {
        depends_on: ["P1-T2", "P1-T3"],
      },
      progressYaml: `events:
  - task_id: P1-T2
    status: started
    at: "2026-05-19T10:00:00.000Z"
    actor: agent
    agent: claude-code
  - task_id: P1-T3
    status: done
    at: "2026-05-19T11:00:00.000Z"
    actor: agent
    agent: claude-code
    evidence:
      - commands
`,
    });
    const out = await buildPack();
    expect(out).toContain("## Depends on");
    expect(out).toContain("- **P1-T2** — started");
    expect(out).toContain("- **P1-T3** — done");
  });

  it("reports planned when an id has no events yet", async () => {
    await setupProject({
      taskExtras: { depends_on: ["P1-T2"] },
    });
    const out = await buildPack();
    expect(out).toContain("- **P1-T2** — planned");
  });
});

describe("buildContextPack — Declared read surface", () => {
  it("omits the section when reads is undefined", async () => {
    await setupProject();
    const out = await buildPack();
    expect(out).not.toContain("## Declared read surface");
  });

  it("lists each glob and its matched files", async () => {
    await setupProject({
      taskExtras: { reads: ["src/foo.ts", "src/bar/*.ts"] },
      extraFiles: {
        "src/foo.ts": "// foo",
        "src/bar/baz.ts": "// baz",
        "src/bar/qux.ts": "// qux",
      },
    });
    const out = await buildPack();
    expect(out).toContain("## Declared read surface");
    expect(out).toContain("- `src/foo.ts`");
    expect(out).toContain("  - `src/foo.ts`");
    expect(out).toContain("- `src/bar/*.ts`");
    expect(out).toContain("  - `src/bar/baz.ts`");
    expect(out).toContain("  - `src/bar/qux.ts`");
  });

  it("renders a 'no current matches' note when nothing matches", async () => {
    await setupProject({
      taskExtras: { reads: ["src/*.ts"] },
    });
    const out = await buildPack();
    expect(out).toContain("- `src/*.ts`");
    expect(out).toContain("_(no current matches on disk)_");
  });
});

describe("buildContextPack — Declared write surface", () => {
  it("omits the section when writes is undefined", async () => {
    await setupProject();
    const out = await buildPack();
    expect(out).not.toContain("## Declared write surface");
  });

  it("lists each declared glob without doing fs lookup", async () => {
    await setupProject({
      taskExtras: { writes: ["src/new-file.ts", "tests/**/*.test.ts"] },
    });
    const out = await buildPack();
    expect(out).toContain("## Declared write surface");
    expect(out).toContain("- `src/new-file.ts`");
    expect(out).toContain("- `tests/**/*.test.ts`");
  });
});

describe("buildContextPack — Declared decisions", () => {
  it("omits the section when decision_refs is undefined", async () => {
    await setupProject({
      decisions: { "stability-taxonomy.md": "# Stability taxonomy\n\nbody" },
    });
    const out = await buildPack();
    expect(out).not.toContain("## Declared decisions");
  });

  it("inlines the full body of every referenced decision file", async () => {
    await setupProject({
      taskExtras: {
        decision_refs: ["design/decisions/stability-taxonomy.md"],
      },
      decisions: {
        "stability-taxonomy.md": "# Stability taxonomy\n\nbody of the decision",
      },
    });
    const out = await buildPack();
    expect(out).toContain("## Declared decisions");
    expect(out).toContain("### stability-taxonomy.md");
    expect(out).toContain("body of the decision");
  });

  // Security (Blocker 1): a decision_ref is loaded YAML content read into the
  // pack body, so a traversal value must NOT be read (it would otherwise
  // exfiltrate an arbitrary file into the context pack shown to the agent).
  // The namespace contract (DecisionRefPath) now hard-fails such a value at
  // PHASE LOAD — even earlier and more strongly than the prior load-then-skip:
  // the plan is rejected (CONFIG_ERROR) before any pack body is built, so the
  // secret can never be reached at all.
  it("rejects a decision_ref that escapes the project root at phase load", async () => {
    const secretName = `pack-traversal-secret-9f3a.md`;
    const secretAbs = join(work, "..", secretName);
    await writeFile(secretAbs, "**Status:** accepted\n\nLEAKED-SECRET-MARKER-9f3a", "utf8");
    try {
      await setupProject({ taskExtras: { decision_refs: [`../${secretName}`] } });
      await expect(buildPack()).rejects.toThrow(/malformed|CONFIG_ERROR/i);
    } finally {
      await rm(secretAbs, { force: true });
    }
  });

  it("dedupes content against the existing Related Decisions section", async () => {
    // task_id matches the filename so the existing path WOULD have
    // surfaced this file under Related Decisions. Once declared, it
    // should appear under Declared decisions and NOT be repeated.
    await setupProject({
      taskExtras: {
        decision_refs: ["design/decisions/P1-T1-foo.md"],
        // Make the existing path eligible to pick this file up too.
        context_size: "medium",
      },
      decisions: {
        "P1-T1-foo.md": "# Foo\n\nbody",
      },
    });
    const out = await buildPack();
    // Content appears exactly once under Declared decisions.
    expect(out).toContain("## Declared decisions");
    const declaredIdx = out.indexOf("## Declared decisions");
    const relatedIdx = out.indexOf("## Related Decisions");
    if (relatedIdx !== -1) {
      // If the Related Decisions section still appears, it must not
      // re-emit the same filename.
      const relatedBlock = out.slice(relatedIdx);
      expect(relatedBlock).not.toContain("### P1-T1-foo.md");
    }
    expect(declaredIdx).toBeGreaterThan(-1);
  });
});

describe("buildContextPack — Acceptance references", () => {
  it("omits the section when acceptance_refs is undefined", async () => {
    await setupProject();
    const out = await buildPack();
    expect(out).not.toContain("## Acceptance references");
  });

  it("renders a path list only — no excerpts in P10", async () => {
    await setupProject({
      taskExtras: { acceptance_refs: ["docs/cli-contract.md"] },
      extraFiles: {
        "docs/cli-contract.md": "# Big doc with much content that we do not inline",
      },
    });
    const out = await buildPack();
    expect(out).toContain("## Acceptance references");
    expect(out).toContain("- `docs/cli-contract.md`");
    // The contents of the file must NOT be inlined — P10 ships path
    // list only. Richer rendering is deferred to P11.
    expect(out).not.toContain("Big doc with much content");
  });
});

describe("buildContextPack — section ordering when multiple fields declared", () => {
  it("renders the new sections in the documented order", async () => {
    await setupProject({
      taskExtras: {
        depends_on: ["P1-T2"],
        reads: ["src/foo.ts"],
        writes: ["src/bar.ts"],
        decision_refs: ["design/decisions/x.md"],
        acceptance_refs: ["docs/cli-contract.md"],
      },
      decisions: { "x.md": "# X\n\nbody" },
      extraFiles: {
        "src/foo.ts": "// foo",
        "docs/cli-contract.md": "doc",
      },
    });
    const out = await buildPack();
    const idx = (heading: string): number => out.indexOf(heading);
    const order = [
      "## Depends on",
      "## Declared read surface",
      "## Declared write surface",
      "## Declared decisions",
      "## Acceptance references",
    ];
    const positions = order.map(idx);
    for (const p of positions) expect(p).toBeGreaterThan(-1);
    // Each section appears strictly after the previous one.
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]!).toBeGreaterThan(positions[i - 1]!);
    }
  });
});
