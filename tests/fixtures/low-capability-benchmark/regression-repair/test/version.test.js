import { describe, it } from "node:test";
import assert from "node:assert";
import { parseVersion } from "../src/version.js";

describe("parseVersion", () => {
  it("parses a major.minor version", () => {
    assert.deepStrictEqual(parseVersion("2.7.0"), { major: 2, minor: 7 });
  });

  it("parses a major-only version", () => {
    assert.deepStrictEqual(parseVersion("3"), { major: 3, minor: 0 });
  });
});
