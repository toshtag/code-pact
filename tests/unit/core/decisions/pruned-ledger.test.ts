import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readPrunedLedger,
  normalizeRelPath,
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
});
