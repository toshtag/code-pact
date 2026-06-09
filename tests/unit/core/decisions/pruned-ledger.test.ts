import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readPrunedLedger,
  parsePrunedLedger,
  normalizeRelPath,
  normalizePrunedDecisionPath,
  serializePrunedRow,
  buildAppendedLedger,
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

describe("buildAppendedLedger (compute the next ledger content — no write)", () => {
  const ROW = {
    decision: "design/decisions/foo-rfc.md",
    phase_task: "P1-T1",
    pruned_date: "2026-06-09",
    rationale_home: "git history",
  };

  it("absent ledger → content carries the header + row; existing_content empty; not already recorded", async () => {
    const p = await buildAppendedLedger(cwd, ROW);
    expect(p.content).toContain("# Pruned decisions");
    expect(p.content).toContain("`design/decisions/foo-rfc.md`");
    expect(p.existing_content).toBe("");
    expect(p.existed).toBe(false); // PRUNED.md absent at prepare time
    expect(p.already_recorded).toBe(false);
    expect(p.normalized_decision).toBe("design/decisions/foo-rfc.md");
  });

  it("existing ledger for a different decision → appends without duplicating the header", async () => {
    await writeFile(
      join(cwd, "design", "decisions", "PRUNED.md"),
      "# Pruned decisions\n\n| Decision | x |\n| --- | --- |\n| `design/decisions/bar-rfc.md` | P0 | 2026-01-01 | git |\n",
      "utf8",
    );
    const p = await buildAppendedLedger(cwd, ROW);
    expect(p.content.match(/# Pruned decisions/g)).toHaveLength(1);
    expect(parsePrunedLedger(p.content)).toEqual(
      new Set(["design/decisions/bar-rfc.md", "design/decisions/foo-rfc.md"]),
    );
    expect(p.already_recorded).toBe(false);
  });

  it("decision already recorded → already_recorded, content left byte-identical (idempotent)", async () => {
    const existing =
      "# Pruned decisions\n\n| Decision | x |\n| --- | --- |\n| `design/decisions/foo-rfc.md` | P1-T1 | 2026-06-09 | git history |\n";
    await writeFile(join(cwd, "design", "decisions", "PRUNED.md"), existing, "utf8");
    const p = await buildAppendedLedger(cwd, ROW);
    expect(p.already_recorded).toBe(true);
    expect(p.content).toBe(existing); // no duplicate row
  });

  it("fail-closed: an unreadable (non-ENOENT) ledger throws rather than being treated as empty", async () => {
    // PRUNED.md exists but as a DIRECTORY → readFile throws EISDIR (not ENOENT).
    await mkdir(join(cwd, "design", "decisions", "PRUNED.md"), { recursive: true });
    await expect(buildAppendedLedger(cwd, ROW)).rejects.toThrow();
  });
});
