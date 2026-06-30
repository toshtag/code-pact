import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Step 2b characterization — the pack decision loaders are OPTIONAL context
// sources: they degrade to [] / skip on ANY read error, NOT just ENOENT. After
// routing them onto the fail-closed live read seam (readLiveDecisionDir /
// readLiveDecisionFile, which THROW on a non-ENOENT error), the loaders must
// keep that degrade-on-any-error contract via their own call-site catch. These
// tests pin exactly that — the leniency lives at the call site, not in the seam.
//
// The non-ENOENT case is produced by mocking ONLY readdir for the
// design/decisions path (synthetic EACCES) — deterministic and OS-independent.
// NOT a real chmod/permission-denied dir (flaky across runners / Windows).
// A *file* at design/decisions is ENOTDIR → treated as absent → [] regardless,
// so it would NOT exercise the non-ENOENT catch; the mock is required.

// A toggle so individual tests opt into the synthetic non-ENOENT failure: the
// mock is module-level (hoisted), but the temp-dir setup (mkdir/writeFile/rm)
// and the positive-control reads must use the real impl, so default OFF.
const fail = { readdir: false, readFile: false };

vi.mock("node:fs/promises", async (importActual) => {
  const actual = await importActual<typeof import("node:fs/promises")>();
  const eacces = () =>
    Promise.reject(Object.assign(new Error("permission denied"), { code: "EACCES" }));
  const inDecisions = (p: unknown) => /design[\\/]decisions/.test(String(p));
  return {
    ...actual,
    readdir: vi.fn((...args: Parameters<typeof actual.readdir>) => {
      if (fail.readdir && inDecisions(args[0])) return eacces();
      return (actual.readdir as (...a: unknown[]) => unknown)(...(args as unknown[]));
    }),
    readFile: vi.fn((...args: Parameters<typeof actual.readFile>) => {
      if (fail.readFile && inDecisions(args[0])) return eacces();
      return (actual.readFile as (...a: unknown[]) => unknown)(...(args as unknown[]));
    }),
  };
});

import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadDecisions,
  loadDeclaredDecisions,
} from "../../../../src/core/pack/loaders.ts";
import { readLiveDecisionFile } from "../../../../src/core/decisions/adr.ts";

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "code-pact-loaders-err-"));
  await mkdir(join(cwd, "design", "decisions"), { recursive: true });
});

afterEach(async () => {
  fail.readdir = false;
  fail.readFile = false;
  vi.restoreAllMocks();
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

describe("loadDecisions — optional-source degradation (non-ENOENT)", () => {
  it("returns [] when the directory LISTING throws a non-ENOENT error (EACCES)", async () => {
    // A decision file exists; only the listing fails. The fail-closed seam would
    // throw, but the loader's call-site catch degrades to [] — preserving the
    // pre-2b try{readdir}catch{return []} contract.
    await writeFile(
      join(cwd, "design", "decisions", "P1-T1-rfc.md"),
      "# Decision\n\nbody",
    );
    fail.readdir = true;
    const docs = await loadDecisions(cwd, "P1-T1", true);
    expect(docs).toEqual([]);
  });

  it("skips an entry whose per-file READ throws a non-ENOENT error (EACCES), no throw", async () => {
    // Listing succeeds; the per-file read fails non-ENOENT. The seam throws; the
    // loader's per-entry catch skips it. (Old readWithinProject returned null → skip.)
    await writeFile(
      join(cwd, "design", "decisions", "P1-T1-rfc.md"),
      "# Decision\n\nbody",
    );
    fail.readFile = true;
    const docs = await loadDecisions(cwd, "P1-T1", true);
    expect(docs).toEqual([]);
  });
});

describe("readLiveDecisionFile — fail-closed seam (the contract the loaders catch)", () => {
  it("returns unreadable on a non-ENOENT read error (EACCES) rather than throwing raw errno", async () => {
    // This is the fail-closed behavior the gate relies on and the pack loaders
    // must wrap. ENOENT/ENOTDIR → missing (covered elsewhere); any other error
    // must propagate, NOT be swallowed into a missing/ok result.
    await writeFile(
      join(cwd, "design", "decisions", "a.md"),
      "**Status:** accepted\n",
    );
    fail.readFile = true;
    await expect(readLiveDecisionFile(cwd, "design/decisions/a.md")).resolves.toEqual({
      kind: "unreadable",
      errorCode: "EACCES",
    });
  });
});

describe("loadDeclaredDecisions — skip (no throw) on each non-ok read outcome", () => {
  it("skips a missing ref without throwing", async () => {
    const docs = await loadDeclaredDecisions(cwd, ["design/decisions/nope.md"]);
    expect(docs).toEqual([]);
  });

  it("skips an unsafe (symlink-escape) ref without throwing", async () => {
    // A symlink in design/decisions/ pointing outside the project root must be
    // treated as unsafe by the seam → skipped, never read into the pack body.
    const outside = await mkdtemp(join(tmpdir(), "code-pact-outside-"));
    try {
      await writeFile(join(outside, "target.md"), "secret body");
      await symlink(
        join(outside, "target.md"),
        join(cwd, "design", "decisions", "escape.md"),
      );
      const docs = await loadDeclaredDecisions(cwd, ["design/decisions/escape.md"]);
      expect(docs).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("skips a ref whose READ throws a non-ENOENT error (EACCES), no throw", async () => {
    // The file exists and the ref is safe, but the read itself fails non-ENOENT.
    // The seam throws; loadDeclaredDecisions' per-ref catch skips it (old
    // readWithinProject swallowed any read error to null → skip).
    await writeFile(
      join(cwd, "design", "decisions", "P1-T1-rfc.md"),
      "---\nstatus: accepted\n---\n\nbody text",
    );
    fail.readFile = true;
    const docs = await loadDeclaredDecisions(cwd, ["design/decisions/P1-T1-rfc.md"]);
    expect(docs).toEqual([]);
  });

  it("loads a present, safe ref (the positive control)", async () => {
    await writeFile(
      join(cwd, "design", "decisions", "P1-T1-rfc.md"),
      "---\nstatus: accepted\n---\n\nbody text",
    );
    const docs = await loadDeclaredDecisions(cwd, ["design/decisions/P1-T1-rfc.md"]);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.filename).toBe("design/decisions/P1-T1-rfc.md");
    expect(docs[0]!.body).toContain("body text");
  });
});
