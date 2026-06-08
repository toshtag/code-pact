import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readPrunedLedger,
  normalizeRelPath,
  normalizePrunedDecisionPath,
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
});
