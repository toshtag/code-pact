import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readPrunedLedger,
  normalizeRelPath,
  normalizePrunedDecisionPath,
  serializePrunedRow,
  appendPrunedLedger,
} from "../../../../src/core/decisions/pruned-ledger.ts";

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "code-pact-pruned-"));
  await mkdir(join(cwd, "design", "decisions"), { recursive: true });
});

afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

async function writeLedger(body: string): Promise<void> {
  await writeFile(join(cwd, "design", "decisions", "PRUNED.md"), body, "utf8");
}

describe("normalizeRelPath", () => {
  it("strips ./ and canonicalizes slashes so ledger and ref entries compare equal", () => {
    expect(normalizeRelPath("./design/decisions/foo.md")).toBe(
      "design/decisions/foo.md",
    );
    expect(normalizeRelPath("design/decisions/foo.md")).toBe(
      "design/decisions/foo.md",
    );
    expect(normalizeRelPath("design\\decisions\\foo.md")).toBe(
      "design/decisions/foo.md",
    );
  });
});

describe("readPrunedLedger", () => {
  it("returns an empty set when PRUNED.md is absent", async () => {
    expect((await readPrunedLedger(cwd)).size).toBe(0);
  });

  it("returns an empty set for a header-only ledger (no data rows)", async () => {
    await writeLedger(
      `# Pruned decisions\n\n| Decision | Referenced by | Pruned | Rationale |\n| --- | --- | --- | --- |\n`,
    );
    expect((await readPrunedLedger(cwd)).size).toBe(0);
  });

  it("parses paths from code spans and markdown links, normalized and deduped", async () => {
    await writeLedger(
      `| Decision | Referenced by | Pruned | Rationale |
| --- | --- | --- | --- |
| \`design/decisions/foo-rfc.md\` | P1-T1 | 2026-06-08 | CHANGELOG v1.5 |
| [bar](./design/decisions/bar-rfc.md) | P2-T1 | 2026-06-08 | git abc123 |
| \`design/decisions/foo-rfc.md\` | P1-T9 | 2026-06-09 | dup row |
`,
    );
    const set = await readPrunedLedger(cwd);
    expect(set.has("design/decisions/foo-rfc.md")).toBe(true);
    expect(set.has("design/decisions/bar-rfc.md")).toBe(true);
    // dup collapses; only the two distinct paths
    expect(set.size).toBe(2);
  });

  it("skips the header label and malformed / non-path rows (not a blanket silencer)", async () => {
    await writeLedger(
      `| Decision | Referenced by |
| --- | --- |
| not a path at all | P1-T1 |
| | P2-T1 |
| \`design/decisions/real-rfc.md\` | P3-T1 |
`,
    );
    const set = await readPrunedLedger(cwd);
    expect(set.size).toBe(1);
    expect(set.has("design/decisions/real-rfc.md")).toBe(true);
  });

  it("admits ONLY top-level design/decisions/*.md entries — a ledger is a decision tombstone, not an arbitrary silencer", async () => {
    await writeLedger(
      `| Decision | Pruned |
| --- | --- |
| \`docs/cli-contract.md\` | x |
| \`design/phases/P1.yaml\` | x |
| \`design/decisions/README.md\` | x |
| \`design/decisions/PRUNED.md\` | x |
| \`../outside.md\` | x |
| \`design/decisions/../foo.md\` | x |
| \`design/decisions/nested/foo-rfc.md\` | x |
| \`design/decisions/retired-rfc.md\` | x |
`,
    );
    const set = await readPrunedLedger(cwd);
    // Every non-decision / unsafe / non-md / nested / self entry is dropped;
    // only the genuine top-level pruned decision survives.
    expect([...set]).toEqual(["design/decisions/retired-rfc.md"]);
  });
});

describe("normalizePrunedDecisionPath", () => {
  it("returns the normalized path for a real pruned decision", () => {
    expect(normalizePrunedDecisionPath("./design/decisions/foo-rfc.md")).toBe(
      "design/decisions/foo-rfc.md",
    );
  });

  it("rejects anything outside design/decisions/, non-.md, the ledger/index, or traversal", () => {
    expect(normalizePrunedDecisionPath("docs/cli-contract.md")).toBeNull();
    expect(normalizePrunedDecisionPath("design/phases/P1.yaml")).toBeNull();
    expect(normalizePrunedDecisionPath("design/decisions/notes.txt")).toBeNull();
    expect(normalizePrunedDecisionPath("design/decisions/README.md")).toBeNull();
    expect(normalizePrunedDecisionPath("design/decisions/PRUNED.md")).toBeNull();
    expect(normalizePrunedDecisionPath("../outside.md")).toBeNull();
    expect(normalizePrunedDecisionPath("design/decisions/../foo.md")).toBeNull();
    expect(normalizePrunedDecisionPath("/abs/design/decisions/x.md")).toBeNull();
    expect(normalizePrunedDecisionPath("design/decisions/nested/foo.md")).toBeNull(); // top-level only
  });

  it("rejects a path with table/code-span-breaking chars (pipe, backtick, CR/LF)", () => {
    // such a name could never round-trip through the ledger's `path` code span
    expect(normalizePrunedDecisionPath("design/decisions/a|b.md")).toBeNull();
    expect(normalizePrunedDecisionPath("design/decisions/a`b.md")).toBeNull();
    expect(normalizePrunedDecisionPath("design/decisions/a\nb.md")).toBeNull();
  });
});

describe("serializePrunedRow", () => {
  it("renders the path as a code span (never a link) and escapes pipes in cells", () => {
    const row = serializePrunedRow({
      decision: "design/decisions/foo-rfc.md",
      phase_task: "P1-T1 | P1-T2",
      pruned_date: "2026-06-09",
      rationale_home: "git history",
    });
    expect(row).toBe("| `design/decisions/foo-rfc.md` | P1-T1 \\| P1-T2 | 2026-06-09 | git history |");
    expect(row).not.toContain("](design"); // not a markdown link
  });

  it("round-trips through readPrunedLedger", async () => {
    const row = serializePrunedRow({
      decision: "design/decisions/foo-rfc.md",
      phase_task: "—",
      pruned_date: "2026-06-09",
      rationale_home: "git history",
    });
    await writeFile(
      join(cwd, "design", "decisions", "PRUNED.md"),
      `| Decision | x |\n| --- | --- |\n${row}\n`,
      "utf8",
    );
    expect([...(await readPrunedLedger(cwd))]).toEqual(["design/decisions/foo-rfc.md"]);
  });
});

describe("appendPrunedLedger", () => {
  const ROW = {
    decision: "design/decisions/foo-rfc.md",
    phase_task: "P1-T1",
    pruned_date: "2026-06-09",
    rationale_home: "git history",
  };

  it("creates PRUNED.md with a header when absent", async () => {
    await appendPrunedLedger(cwd, ROW);
    const text = await readFile(join(cwd, "design", "decisions", "PRUNED.md"), "utf8");
    expect(text).toContain("# Pruned decisions");
    expect([...(await readPrunedLedger(cwd))]).toEqual(["design/decisions/foo-rfc.md"]);
  });

  it("appends to an existing ledger without duplicating the header", async () => {
    await appendPrunedLedger(cwd, ROW);
    await appendPrunedLedger(cwd, { ...ROW, decision: "design/decisions/bar-rfc.md" });
    const text = await readFile(join(cwd, "design", "decisions", "PRUNED.md"), "utf8");
    expect(text.match(/# Pruned decisions/g)).toHaveLength(1);
    expect(await readPrunedLedger(cwd)).toEqual(
      new Set(["design/decisions/foo-rfc.md", "design/decisions/bar-rfc.md"]),
    );
  });

  it("fail-closed: an unreadable (non-ENOENT) ledger is NOT clobbered — throws instead", async () => {
    // PRUNED.md exists but as a DIRECTORY → readFile throws EISDIR (not ENOENT).
    // Must throw rather than overwrite it with a fresh header (data loss).
    await mkdir(join(cwd, "design", "decisions", "PRUNED.md"), { recursive: true });
    await expect(appendPrunedLedger(cwd, ROW)).rejects.toThrow();
  });
});
