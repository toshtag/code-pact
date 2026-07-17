import { describe, it } from "node:test";
import assert from "node:assert";
import { format } from "../src/formatter.js";

describe("format", () => {
  it("trims and capitalizes", () => {
    assert.strictEqual(format("  world  "), "World");
  });

  it("capitalizes a plain word", () => {
    assert.strictEqual(format("hello"), "Hello");
  });

  it("only capitalizes the first letter", () => {
    assert.strictEqual(format("  test CASE  "), "Test CASE");
  });
});
