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
  await writeFile(join(cwd, "design", "decisions", "foo-rfc.md"), TARGET_CONTENT);
});
afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

const TARGET = "design/decisions/foo-rfc.md";
const TARGET_CONTENT = "# Foo\n\nbody\n";
const LEDGER = {
  decision: TARGET,
  phase_task: "P1-T1",
  pruned_date: "2026-06-09",
  rationale_home: "git history",
};
/** The standard executor input for the fixture target (verdict computed from TARGET_CONTENT). */
function input(items: Awaited<ReturnType<typeof collectInboundLinks>>["items"]) {
  return { remove_file: TARGET, items, ledger: LEDGER, expected_target_content: TARGET_CONTENT };
}

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

    const res = await applyPrune(cwd, input(items));

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

    await applyPrune(cwd, input(items));

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

    await applyPrune(cwd, input(items));

    expect(await read("docs/m.md")).toBe("A and B.\n");
  });

  it("appends to an EXISTING ledger without duplicating the header", async () => {
    await write(
      "design/decisions/PRUNED.md",
      "# Pruned decisions\n\n| Decision | Phase / Task | Pruned | Rationale home |\n| --- | --- | --- | --- |\n| `design/decisions/bar-rfc.md` | P0-T9 | 2026-01-01 | git history |\n",
    );
    const { items } = await collectInboundLinks(cwd, TARGET);

    await applyPrune(cwd, input(items));

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

    await expect(applyPrune(cwd, input(items))).rejects.toBeInstanceOf(
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
    const err = await applyPrune(cwd, input(items)).catch((e) => e);
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

    await expect(applyPrune(cwd, input(items))).rejects.toBeInstanceOf(
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

    await expect(applyPrune(cwd, input(items))).rejects.toBeInstanceOf(
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

    await expect(applyPrune(cwd, input(items))).rejects.toBeInstanceOf(
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
    await expect(applyPrune(cwd, input(items))).rejects.toBeInstanceOf(
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

    const err = await applyPrune(cwd, input(items)).catch((e) => e);
    expect(err).toBeInstanceOf(PruneWriteError);
    expect((err as PruneWriteError).phase).toBe("append_ledger");
    expect((err as PruneWriteError).partial_applied).toBe(false);
    // docs untouched (ledger is attempted before any doc rewrite), record survives.
    expect(await read("docs/x.md")).toBe(docBefore);
    expect(await exists(TARGET)).toBe(true);
  });
});

describe("applyPrune — concurrent edit / removal during commit (ChatGPT round 3)", () => {
  it("a source edited AFTER preflight is NOT clobbered → write_failed(rewrite_links), edit survives", async () => {
    await write("docs/x.md", "See [d](../design/decisions/foo-rfc.md).\n");
    const { items } = await collectInboundLinks(cwd, TARGET);
    const userEdit = "USER EDIT after preflight — must not be clobbered.\n";

    // The hook fires just before the write-time re-read, simulating an editor /
    // git checkout touching the same doc between preflight and the rewrite.
    const err = await applyPrune(
      cwd,
      input(items),
      { beforeSourceWrite: async () => { await write("docs/x.md", userEdit); } },
    ).catch((e) => e);

    expect(err).toBeInstanceOf(PruneWriteError);
    expect((err as PruneWriteError).phase).toBe("rewrite_links");
    expect((err as PruneWriteError).partial_applied).toBe(true);
    expect((err as PruneWriteError).detail).toContain("source changed after preflight");
    // The concurrent edit survived — stale rewritten content never overwrote it.
    expect(await read("docs/x.md")).toBe(userEdit);
    expect(await exists(TARGET)).toBe(true); // record not deleted
    expect(await readPrunedLedger(cwd)).toEqual(new Set([TARGET])); // ledger committed first
  });

  it("the record removed before the delete step → write_failed(delete_record), reported honestly", async () => {
    await write("docs/x.md", "See [d](../design/decisions/foo-rfc.md).\n");
    const { items } = await collectInboundLinks(cwd, TARGET);

    const err = await applyPrune(
      cwd,
      input(items),
      { beforeDelete: async () => { await unlink(join(cwd, TARGET)); } },
    ).catch((e) => e);

    expect(err).toBeInstanceOf(PruneWriteError);
    expect((err as PruneWriteError).phase).toBe("delete_record");
    expect((err as PruneWriteError).partial_applied).toBe(true);
    expect((err as PruneWriteError).detail).toContain("disappeared before unlink");
    // ledger + link rewrites were committed before the (failed) delete.
    expect(await readPrunedLedger(cwd)).toEqual(new Set([TARGET]));
    expect(await read("docs/x.md")).toBe("See d.\n");
  });
});

describe("applyPrune — ledger drift & retry idempotency (ChatGPT round 4)", () => {
  it("PRUNED.md edited between preflight and the ledger write is NOT clobbered → write_failed(append_ledger)", async () => {
    await write("docs/x.md", "See [d](../design/decisions/foo-rfc.md).\n");
    const { items } = await collectInboundLinks(cwd, TARGET);
    // an existing ledger (for an unrelated decision) the prune would append to
    await write(
      "design/decisions/PRUNED.md",
      "# Pruned decisions\n\n| Decision | x |\n| --- | --- |\n| `design/decisions/bar-rfc.md` | P0 | 2026-01-01 | git |\n",
    );
    const docBefore = await read("docs/x.md");
    const edited = "# Pruned decisions\n\nMANUAL EDIT — keep me.\n";

    const err = await applyPrune(
      cwd,
      input(items),
      { beforeLedgerWrite: async () => { await write("design/decisions/PRUNED.md", edited); } },
    ).catch((e) => e);

    expect(err).toBeInstanceOf(PruneWriteError);
    expect((err as PruneWriteError).phase).toBe("append_ledger");
    expect((err as PruneWriteError).partial_applied).toBe(false);
    // the manual ledger edit survived; docs + record untouched (ledger is first).
    expect(await read("design/decisions/PRUNED.md")).toBe(edited);
    expect(await read("docs/x.md")).toBe(docBefore);
    expect(await exists(TARGET)).toBe(true);
  });

  it("ledger ABSENT at preflight but a (even empty) file APPEARS before commit → write_failed(append_ledger)", async () => {
    await write("docs/x.md", "See [d](../design/decisions/foo-rfc.md).\n");
    const { items } = await collectInboundLinks(cwd, TARGET);
    const docBefore = await read("docs/x.md"); // PRUNED.md absent at preflight

    const err = await applyPrune(
      cwd,
      input(items),
      { beforeLedgerWrite: async () => { await write("design/decisions/PRUNED.md", ""); } }, // empty file appears
    ).catch((e) => e);

    expect(err).toBeInstanceOf(PruneWriteError);
    expect((err as PruneWriteError).phase).toBe("append_ledger");
    expect((err as PruneWriteError).partial_applied).toBe(false);
    // the appeared file is not clobbered; docs + record untouched
    expect(await read("design/decisions/PRUNED.md")).toBe("");
    expect(await read("docs/x.md")).toBe(docBefore);
    expect(await exists(TARGET)).toBe(true);
  });

  it("re-running on a decision already in the ledger does NOT duplicate the tombstone (ledger_action: already_recorded)", async () => {
    await write("docs/x.md", "See [d](../design/decisions/foo-rfc.md).\n");
    const { items } = await collectInboundLinks(cwd, TARGET);
    // foo is ALREADY recorded (a prior partial-failure prune wrote the row)
    await write(
      "design/decisions/PRUNED.md",
      "# Pruned decisions\n\n| Decision | x |\n| --- | --- |\n| `design/decisions/foo-rfc.md` | P1-T1 | 2026-06-09 | git history |\n",
    );

    const res = await applyPrune(cwd, input(items));
    expect(res.ledger_action).toBe("already_recorded"); // honest: nothing appended

    const ledger = await read("design/decisions/PRUNED.md");
    expect(ledger.match(/foo-rfc\.md/g)).toHaveLength(1); // not duplicated
    expect(await readPrunedLedger(cwd)).toEqual(new Set([TARGET]));
    // the rest of the prune still ran
    expect(await read("docs/x.md")).toBe("See d.\n");
    expect(await exists(TARGET)).toBe(false);
  });

  it("already-recorded, but the tombstone row REMOVED before commit → write_failed(append_ledger), zero further writes", async () => {
    await write("docs/x.md", "See [d](../design/decisions/foo-rfc.md).\n");
    const { items } = await collectInboundLinks(cwd, TARGET);
    await write(
      "design/decisions/PRUNED.md",
      "# Pruned decisions\n\n| Decision | x |\n| --- | --- |\n| `design/decisions/foo-rfc.md` | P1-T1 | 2026-06-09 | git history |\n",
    );
    const docBefore = await read("docs/x.md");
    const wiped = "# Pruned decisions\n\n(no rows)\n";

    // The hook fires before the commit-time ledger re-read — even on the
    // already_recorded path — so a row deleted now is detected.
    const err = await applyPrune(
      cwd,
      input(items),
      { beforeLedgerWrite: async () => { await write("design/decisions/PRUNED.md", wiped); } },
    ).catch((e) => e);

    expect(err).toBeInstanceOf(PruneWriteError);
    expect((err as PruneWriteError).phase).toBe("append_ledger");
    expect((err as PruneWriteError).partial_applied).toBe(false);
    // no tombstone-less delete: record survives, docs byte-identical
    expect(await exists(TARGET)).toBe(true);
    expect(await read("docs/x.md")).toBe(docBefore);
  });
});

describe("applyPrune — honest partial_applied & ledger_row (ChatGPT round 6)", () => {
  const RECORDED =
    "# Pruned decisions\n\n| Decision | Phase | Pruned | Rationale |\n| --- | --- | --- | --- |\n| `design/decisions/foo-rfc.md` | P0-T9 | 2026-01-01 | manual |\n";

  it("already-recorded + a source edited before its write → rewrite_links, partial_applied FALSE", async () => {
    await write("docs/x.md", "See [d](../design/decisions/foo-rfc.md).\n");
    const { items } = await collectInboundLinks(cwd, TARGET);
    await write("design/decisions/PRUNED.md", RECORDED); // ledger already has foo
    const userEdit = "USER EDIT.\n";

    const err = await applyPrune(
      cwd,
      input(items),
      { beforeSourceWrite: async () => { await write("docs/x.md", userEdit); } },
    ).catch((e) => e);

    expect(err).toBeInstanceOf(PruneWriteError);
    expect((err as PruneWriteError).phase).toBe("rewrite_links");
    // ledger was already recorded (no append) AND no source rewritten yet → nothing mutated this run
    expect((err as PruneWriteError).partial_applied).toBe(false);
    expect(await read("docs/x.md")).toBe(userEdit);
    expect(await exists(TARGET)).toBe(true);
  });

  it("appended + a source edited before its write → rewrite_links, partial_applied TRUE (ledger landed this run)", async () => {
    await write("docs/x.md", "See [d](../design/decisions/foo-rfc.md).\n");
    const { items } = await collectInboundLinks(cwd, TARGET); // no pre-existing ledger → appended

    const err = await applyPrune(
      cwd,
      input(items),
      { beforeSourceWrite: async () => { await write("docs/x.md", "EDIT.\n"); } },
    ).catch((e) => e);

    expect(err).toBeInstanceOf(PruneWriteError);
    expect((err as PruneWriteError).phase).toBe("rewrite_links");
    expect((err as PruneWriteError).partial_applied).toBe(true); // the ledger row was appended this run
    expect(await readPrunedLedger(cwd)).toEqual(new Set([TARGET]));
  });

  it("already-recorded + no inbound links + record vanishes before delete → delete_record, partial_applied FALSE", async () => {
    const { items } = await collectInboundLinks(cwd, TARGET); // no docs link
    expect(items).toEqual([]);
    await write("design/decisions/PRUNED.md", RECORDED);

    const err = await applyPrune(
      cwd,
      input(items),
      { beforeDelete: async () => { await unlink(join(cwd, TARGET)); } },
    ).catch((e) => e);

    expect(err).toBeInstanceOf(PruneWriteError);
    expect((err as PruneWriteError).phase).toBe("delete_record");
    expect((err as PruneWriteError).partial_applied).toBe(false); // nothing mutated this run
  });

  it("already_recorded → ledger_row is the EXISTING row, not the freshly-generated one", async () => {
    await write("docs/x.md", "See [d](../design/decisions/foo-rfc.md).\n");
    const { items } = await collectInboundLinks(cwd, TARGET);
    await write("design/decisions/PRUNED.md", RECORDED);

    const res = await applyPrune(cwd, input(items));
    expect(res.ledger_action).toBe("already_recorded");
    expect(res.ledger_row).toContain("P0-T9"); // the existing row's phase
    expect(res.ledger_row).toContain("2026-01-01"); // the existing row's date
    expect(res.ledger_row).not.toContain("P1-T1"); // NOT the freshly-generated row
  });

  it("already_recorded row edited (still present) before commit → ledger_row is the CURRENT row", async () => {
    await write("docs/x.md", "See [d](../design/decisions/foo-rfc.md).\n");
    const { items } = await collectInboundLinks(cwd, TARGET);
    await write("design/decisions/PRUNED.md", RECORDED);
    const editedRow =
      "# Pruned decisions\n\n| Decision | x |\n| --- | --- |\n| `design/decisions/foo-rfc.md` | P9-T9 | 2099-12-31 | edited |\n";

    const res = await applyPrune(cwd, input(items), {
      beforeLedgerWrite: async () => { await write("design/decisions/PRUNED.md", editedRow); },
    });
    expect(res.ledger_action).toBe("already_recorded");
    expect(res.ledger_row).toContain("P9-T9"); // the CURRENT (hand-edited) row
    expect(res.ledger_row).toContain("2099-12-31");
    expect(res.ledger_row).not.toContain("P0-T9"); // not the preflight copy
  });
});

describe("applyPrune — target content drift (ChatGPT round 7, data-safety)", () => {
  it("target edited IN PLACE since the verdict → PrunePlanStaleError, ZERO writes", async () => {
    await write("docs/x.md", "See [d](../design/decisions/foo-rfc.md).\n");
    const { items } = await collectInboundLinks(cwd, TARGET);
    const docBefore = await read("docs/x.md");
    // same inode (writeFile truncates), but the record's content changed
    // (e.g. accepted → proposed) — the verdict no longer holds.
    await write(TARGET, "# Foo\n\n**Status:** proposed\n");

    await expect(applyPrune(cwd, input(items))).rejects.toBeInstanceOf(PrunePlanStaleError);
    expect(await read("docs/x.md")).toBe(docBefore); // docs untouched
    expect(await exists("design/decisions/PRUNED.md")).toBe(false); // no ledger
    expect(await exists(TARGET)).toBe(true); // record NOT deleted
  });

  it("target content edited just before the delete → WRITE_FAILED delete_record, record survives", async () => {
    await write("docs/x.md", "See [d](../design/decisions/foo-rfc.md).\n");
    const { items } = await collectInboundLinks(cwd, TARGET);

    const err = await applyPrune(cwd, input(items), {
      beforeDelete: async () => { await write(TARGET, "# Foo\n\n**Status:** proposed\n"); },
    }).catch((e) => e);

    expect(err).toBeInstanceOf(PruneWriteError);
    expect((err as PruneWriteError).phase).toBe("delete_record");
    expect((err as PruneWriteError).partial_applied).toBe(true); // ledger + docs landed this run
    expect(await exists(TARGET)).toBe(true); // not deleted
    expect(await read(TARGET)).toContain("proposed"); // the in-place edit survives
  });
});
