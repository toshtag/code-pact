import { describe, it } from "node:test";
import assert from "node:assert";
import { greet } from "../src/main.js";

describe("greet", () => {
  it("greets in English", () => {
    assert.strictEqual(greet("World"), "Hello, World!");
  });
});
