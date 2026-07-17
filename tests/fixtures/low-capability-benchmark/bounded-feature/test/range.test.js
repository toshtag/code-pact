import { describe, it } from "node:test";
import assert from "node:assert";
import { range } from "../src/range.js";

describe("range", () => {
  it("produces a simple ascending range", () => {
    assert.deepStrictEqual(range(0, 3), [0, 1, 2]);
  });

  it("supports a custom step", () => {
    assert.deepStrictEqual(range(0, 10, 2), [0, 2, 4, 6, 8]);
  });

  it("supports descending ranges", () => {
    assert.deepStrictEqual(range(3, 0, -1), [3, 2, 1]);
  });
});
