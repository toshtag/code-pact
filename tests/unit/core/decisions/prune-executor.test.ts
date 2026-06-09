import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile, readFile, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { collectInboundLinks } from "../../../../src/core/decisions/link-collector.ts";
import {
  applyPrune,
  PrunePlanStaleError,
  PruneWriteError,
} from "../../../../src/core/decisions/prune-executor.ts";
import { readPrunedLedger } from "../../../../src/core/decisions/pruned-ledger.ts";
import { unlink } from "node:fs/promises";

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "code-pact-pruneexec-"));
  await mkdir(join(cwd, "design", "decisions"), { recursive: true });
  await writeFile(join(cwd, "design", "decisions", "foo-rfc.md"), "# Foo\n\nbody\n");
});
afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

const TARGET = "design/decisions/foo-rfc.md";
const LEDGER = {
  decision: TARGET,
  phase_task: "P1-T1",
  pruned_date: "2026-06-09",
  rationale_home: "git history",
};

async function write(rel: string, content: string): Promise<void> {
  const abs = join(cwd, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf8");
}
async function read(rel: string): Promise<string> {
  return readFile(join(cwd, rel), "utf8");
}
async function exists(rel: string): Promise<boolean> {
  try {
    await access(join(cwd, rel));
    return true;
  } catch {
    return false;
  }
}

describe("applyPrune — happy path", () => {
  it("deletes the target, delinks a body link, and appends a ledger row (created with header)", async () => {
    await write("docs/x.md", "# X\n\nSee [the decision](../design/decisions/foo-rfc.md) here.\n");
    const { items } = await collectInboundLinks(cwd, TARGET);

    const res = await applyPrune(cwd, { remove_file: TARGET, items, ledger: LEDGER });

    expect(await exists(TARGET)).toBe(false); // record removed
    expect(await read("docs/x.md")).toBe("# X\n\nSee the decision here.\n"); // delinked in place
    expect(res.link_rewrites_applied).toHaveLength(1);
    expect(res.link_rewrites_applied[0]).toMatchObject({
      source_file: "docs/x.md",
      rewrite_action: "delink",
      before: "[the decision](../design/decisions/foo-rfc.md)",
      after: "the decision",
    });
    // ledger created and reads back to the pruned path
    expect(await readPrunedLedger(cwd)).toEqual(new Set([TARGET]));
    const ledger = await read("design/decisions/PRUNED.md");
    expect(ledger).toContain("# Pruned decisions");
    expect(ledger).toContain("| `design/decisions/foo-rfc.md` | P1-T1 | 2026-06-09 | git history |");
    expect(res.ledger_row).toContain("`design/decisions/foo-rfc.md`");
  });

  it("a README index row → tombstone (link removed, row retained), body link → delink", async () => {
    await write(
      "design/decisions/README.md",
      "# Index\n\n| Decision | What |\n| --- | --- |\n| [Foo](foo-rfc.md) | did foo |\n",
    );
    await write("docs/y.md", "See [d](../design/decisions/foo-rfc.md).\n");
    const { items } = await collectInboundLinks(cwd, TARGET);

    await applyPrune(cwd, { remove_file: TARGET, items, ledger: LEDGER });

    const readme = await read("design/decisions/README.md");
    expect(readme).toContain("| ~~Foo~~ (pruned) | did foo |"); // tombstoned in place
    expect(readme).not.toContain("](foo-rfc.md)"); // the link is gone
    expect(await read("docs/y.md")).toBe("See d.\n");
  });

  it("two links to the target on one line are both delinked (applied back-to-front)", async () => {
    await write(
      "docs/m.md",
      "[A](../design/decisions/foo-rfc.md) and [B](../design/decisions/foo-rfc.md).\n",
    );
    const { items } = await collectInboundLinks(cwd, TARGET);
    expect(items).toHaveLength(2);

    await applyPrune(cwd, { remove_file: TARGET, items, ledger: LEDGER });

    expect(await read("docs/m.md")).toBe("A and B.\n");
  });

  it("appends to an EXISTING ledger without duplicating the header", async () => {
    await write(
      "design/decisions/PRUNED.md",
      "# Pruned decisions\n\n| Decision | Phase / Task | Pruned | Rationale home |\n| --- | --- | --- | --- |\n| `design/decisions/bar-rfc.md` | P0-T9 | 2026-01-01 | git history |\n",
    );
    const { items } = await collectInboundLinks(cwd, TARGET);

    await applyPrune(cwd, { remove_file: TARGET, items, ledger: LEDGER });

    const ledger = await read("design/decisions/PRUNED.md");
    expect(ledger.match(/# Pruned decisions/g)).toHaveLength(1); // header not duplicated
    expect(await readPrunedLedger(cwd)).toEqual(
      new Set([TARGET, "design/decisions/bar-rfc.md"]),
    );
  });
});

describe("applyPrune — fail-closed on a stale plan", () => {
  it("a source whose span changed under the plan → PrunePlanStaleError, ZERO writes", async () => {
    await write("docs/x.md", "See [the decision](../design/decisions/foo-rfc.md).\n");
    const { items } = await collectInboundLinks(cwd, TARGET);
    // Mutate the source so the collected (line,column,raw_link) no longer matches.
    await write("docs/x.md", "PREFIX shifts every column. See [the decision](../design/decisions/foo-rfc.md).\n");
    const before = await read("docs/x.md");

    await expect(applyPrune(cwd, { remove_file: TARGET, items, ledger: LEDGER })).rejects.toBeInstanceOf(
      PrunePlanStaleError,
    );

    // Nothing was written: target still present, source untouched, no ledger.
    expect(await exists(TARGET)).toBe(true);
    expect(await read("docs/x.md")).toBe(before);
    expect(await exists("design/decisions/PRUNED.md")).toBe(false);
  });

  it("the stale error carries the expected vs found span", async () => {
    await write("docs/x.md", "See [d](../design/decisions/foo-rfc.md).\n");
    const { items } = await collectInboundLinks(cwd, TARGET);
    await write("docs/x.md", "DIFFERENT.\n");
    const err = await applyPrune(cwd, { remove_file: TARGET, items, ledger: LEDGER }).catch((e) => e);
    expect(err).toBeInstanceOf(PrunePlanStaleError);
    expect((err as PrunePlanStaleError).stale[0]).toMatchObject({
      source_file: "docs/x.md",
      expected: "[d](../design/decisions/foo-rfc.md)",
    });
  });

  it("a link RECLASSIFIED into a code span after collection → stale (byte-match alone would miss it)", async () => {
    // Replace a pre-link char with a backtick (no offset shift) + append a closing
    // backtick: the link's bytes are unchanged at the same span, but it is now
    // inside an inline code span the live collector excludes.
    await write("docs/x.md", "See:X[d](../design/decisions/foo-rfc.md) end\n");
    const { items } = await collectInboundLinks(cwd, TARGET);
    expect(items).toHaveLength(1); // collected while it was a live link
    await write("docs/x.md", "See:`[d](../design/decisions/foo-rfc.md)` end\n");
    const before = await read("docs/x.md");

    await expect(applyPrune(cwd, { remove_file: TARGET, items, ledger: LEDGER })).rejects.toBeInstanceOf(
      PrunePlanStaleError,
    );
    expect(await read("docs/x.md")).toBe(before); // the code span was NOT rewritten
    expect(await exists(TARGET)).toBe(true);
  });

  it("a NEW inbound link added after collection → stale (would otherwise dangle after deletion)", async () => {
    await write("docs/a.md", "See [d](../design/decisions/foo-rfc.md).\n");
    const { items } = await collectInboundLinks(cwd, TARGET);
    // a second doc starts linking the target after the plan was built
    await write("docs/b.md", "Also [e](../design/decisions/foo-rfc.md).\n");

    await expect(applyPrune(cwd, { remove_file: TARGET, items, ledger: LEDGER })).rejects.toBeInstanceOf(
      PrunePlanStaleError,
    );
    expect(await exists(TARGET)).toBe(true); // nothing deleted
    expect(await exists("design/decisions/PRUNED.md")).toBe(false);
  });
});

describe("applyPrune — the target itself going stale (ChatGPT blocker 1)", () => {
  it("the target deleted after the plan was built → PrunePlanStaleError, ZERO writes", async () => {
    await write("docs/x.md", "See [d](../design/decisions/foo-rfc.md).\n");
    const { items } = await collectInboundLinks(cwd, TARGET);
    const docBefore = await read("docs/x.md");
    // The decision record vanishes under us (external op) after the plan is built.
    await unlink(join(cwd, TARGET));

    await expect(applyPrune(cwd, { remove_file: TARGET, items, ledger: LEDGER })).rejects.toBeInstanceOf(
      PrunePlanStaleError,
    );
    // prune adds NO changes: docs byte-identical, no ledger created.
    expect(await read("docs/x.md")).toBe(docBefore);
    expect(await exists("design/decisions/PRUNED.md")).toBe(false);
  });

  it("the target turned into a directory → PrunePlanStaleError, ZERO writes", async () => {
    await write("docs/x.md", "See [d](../design/decisions/foo-rfc.md).\n");
    const { items } = await collectInboundLinks(cwd, TARGET);
    await unlink(join(cwd, TARGET));
    await mkdir(join(cwd, TARGET), { recursive: true });
    await expect(applyPrune(cwd, { remove_file: TARGET, items, ledger: LEDGER })).rejects.toBeInstanceOf(
      PrunePlanStaleError,
    );
    expect(await exists("design/decisions/PRUNED.md")).toBe(false);
  });
});

describe("applyPrune — ledger-first ordering & write failures (ChatGPT blockers 2 & 3)", () => {
  it("ledger write-capability failure → PruneWriteError, inbound docs BYTE-IDENTICAL, target survives", async () => {
    await write("docs/x.md", "See [d](../design/decisions/foo-rfc.md).\n");
    const { items } = await collectInboundLinks(cwd, TARGET);
    const docBefore = await read("docs/x.md");
    // PRUNED.md is a directory (EISDIR, not ENOENT) → the ledger read in preflight fails.
    await mkdir(join(cwd, "design", "decisions", "PRUNED.md"), { recursive: true });

    const err = await applyPrune(cwd, { remove_file: TARGET, items, ledger: LEDGER }).catch((e) => e);
    expect(err).toBeInstanceOf(PruneWriteError);
    expect((err as PruneWriteError).phase).toBe("append_ledger");
    expect((err as PruneWriteError).partial_applied).toBe(false);
    // docs untouched (ledger is attempted before any doc rewrite), record survives.
    expect(await read("docs/x.md")).toBe(docBefore);
    expect(await exists(TARGET)).toBe(true);
  });
});
