import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteText, atomicReplaceExistingText } from "../../../src/io/atomic-text.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "code-pact-atomic-"));
});
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function noTempLeftBehind(): Promise<boolean> {
  const entries = await readdir(dir);
  return !entries.some((e) => e.includes(".tmp-"));
}

describe("atomicWriteText", () => {
  it("creates a file (and missing parents) when absent", async () => {
    const p = join(dir, "sub", "a.txt");
    await atomicWriteText(p, "hello");
    expect(await readFile(p, "utf8")).toBe("hello");
  });

  it("expectedCurrent: replaces when the destination still matches", async () => {
    const p = join(dir, "a.txt");
    await writeFile(p, "v1", "utf8");
    await atomicWriteText(p, "v2", "v1");
    expect(await readFile(p, "utf8")).toBe("v2");
  });

  it("expectedCurrent: refuses (and cleans up) when the destination drifted", async () => {
    const p = join(dir, "a.txt");
    await writeFile(p, "edited-by-someone-else", "utf8");
    await expect(atomicWriteText(p, "v2", "v1")).rejects.toThrow();
    expect(await readFile(p, "utf8")).toBe("edited-by-someone-else"); // not clobbered
    expect(await noTempLeftBehind()).toBe(true);
  });

  it("expectedCurrent='' (expected absent): creates when still absent, refuses if it appeared", async () => {
    const p = join(dir, "a.txt");
    await atomicWriteText(p, "created", ""); // still absent → maps to "" → matches → create
    expect(await readFile(p, "utf8")).toBe("created");

    const q = join(dir, "b.txt");
    await writeFile(q, "appeared", "utf8"); // a file appeared where we expected absence
    await expect(atomicWriteText(q, "v", "")).rejects.toThrow();
    expect(await readFile(q, "utf8")).toBe("appeared");
    expect(await noTempLeftBehind()).toBe(true);
  });
});

describe("atomicReplaceExistingText", () => {
  it("replaces an existing file", async () => {
    const p = join(dir, "a.txt");
    await writeFile(p, "v1", "utf8");
    await atomicReplaceExistingText(p, "v2");
    expect(await readFile(p, "utf8")).toBe("v2");
  });

  it("does NOT create a parent directory (a vanished parent fails)", async () => {
    const p = join(dir, "gone", "a.txt"); // parent does not exist
    await expect(atomicReplaceExistingText(p, "v")).rejects.toThrow();
    expect(await noTempLeftBehind()).toBe(true);
  });

  it("expectedCurrent: refuses (and cleans up) when the destination drifted", async () => {
    const p = join(dir, "a.txt");
    await writeFile(p, "edited", "utf8");
    await expect(atomicReplaceExistingText(p, "v2", "v1")).rejects.toThrow();
    expect(await readFile(p, "utf8")).toBe("edited");
    expect(await noTempLeftBehind()).toBe(true);
  });
});
