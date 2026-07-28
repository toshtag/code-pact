import { describe, it, expect } from "vitest";
import { extractPackRecord } from "../../../scripts/npm-pack-json.mjs";

const NAME = "code-pact";
const VERSION = "2.8.0";
const FILENAME = "code-pact-2.8.0.tgz";

const expected = { expectedName: NAME, expectedVersion: VERSION };

/**
 * Minimal record preserving the fields both npm majors emit. Reduced from the
 * payloads measured on 2026-07-28 with npm 11.16.0 and npm 12.0.0 against this
 * package; the omitted fields (id, size, shasum, integrity, files, …) are
 * identical across both and are not read by the parser.
 */
function record(overrides: Record<string, unknown> = {}) {
  return {
    id: `${NAME}@${VERSION}`,
    name: NAME,
    version: VERSION,
    filename: FILENAME,
    ...overrides,
  };
}

/** npm 11: an array of one record per packed package. */
function npm11Payload(overrides?: Record<string, unknown>) {
  return [record(overrides)];
}

/** npm 12: an object keyed by package name. */
function npm12Payload(overrides?: Record<string, unknown>) {
  return { [NAME]: record(overrides) };
}

describe("extractPackRecord — accepted npm payload shapes", () => {
  it("reads the npm 11 array shape", () => {
    expect(extractPackRecord(npm11Payload(), expected)).toEqual({
      name: NAME,
      version: VERSION,
      filename: FILENAME,
    });
  });

  it("reads the npm 12 object shape", () => {
    expect(extractPackRecord(npm12Payload(), expected)).toEqual({
      name: NAME,
      version: VERSION,
      filename: FILENAME,
    });
  });

  it("returns the same canonical record for both shapes", () => {
    expect(extractPackRecord(npm11Payload(), expected)).toEqual(
      extractPackRecord(npm12Payload(), expected),
    );
  });

  it("ignores fields it does not read", () => {
    const noisy = npm12Payload({ integrity: "sha512-…", entryCount: 4 });
    expect(extractPackRecord(noisy, expected)).toEqual({
      name: NAME,
      version: VERSION,
      filename: FILENAME,
    });
  });
});

describe("extractPackRecord — unrecognized containers", () => {
  it("refuses null", () => {
    expect(() => extractPackRecord(null, expected)).toThrow(/supported npm 11 array shape/);
  });

  it("refuses a scalar", () => {
    expect(() => extractPackRecord("code-pact-2.8.0.tgz", expected)).toThrow(
      /supported npm 11 array shape/,
    );
  });

  it("refuses an empty array", () => {
    expect(() => extractPackRecord([], expected)).toThrow(/holds 0 record/);
  });

  it("refuses multiple array records", () => {
    expect(() =>
      extractPackRecord([record(), record()], expected),
    ).toThrow(/holds 2 record/);
  });

  it("refuses an empty object", () => {
    expect(() => extractPackRecord({}, expected)).toThrow(/holds 0 record/);
  });

  it("refuses multiple object records", () => {
    expect(() =>
      extractPackRecord({ [NAME]: record(), other: record() }, expected),
    ).toThrow(/holds 2 record/);
  });

  it("refuses an object keyed by a different package", () => {
    expect(() =>
      extractPackRecord({ "other-pkg": record() }, expected),
    ).toThrow(/keyed by "other-pkg"/);
  });

  it("does not fall back to index 0 for an unknown container", () => {
    // An object that happens to carry a numeric key must not be read as an
    // array; an unrecognized shape is refused, never guessed.
    expect(() => extractPackRecord({ 0: record() }, expected)).toThrow(
      /keyed by "0"/,
    );
  });

  it("refuses a record that is not an object", () => {
    expect(() => extractPackRecord([FILENAME], expected)).toThrow(
      /record is not an object/,
    );
  });

  it("refuses a nested array record", () => {
    expect(() => extractPackRecord([[record()]], expected)).toThrow(
      /record is not an object/,
    );
  });
});

describe("extractPackRecord — incomplete or mismatched records", () => {
  it("refuses a missing name", () => {
    expect(() =>
      extractPackRecord([{ version: VERSION, filename: FILENAME }], expected),
    ).toThrow(/no name/);
  });

  it("refuses a missing version", () => {
    expect(() =>
      extractPackRecord([{ name: NAME, filename: FILENAME }], expected),
    ).toThrow(/no version/);
  });

  it("refuses a missing filename", () => {
    expect(() =>
      extractPackRecord([{ name: NAME, version: VERSION }], expected),
    ).toThrow(/no filename/);
  });

  it("refuses a non-string filename", () => {
    expect(() =>
      extractPackRecord(npm11Payload({ filename: 42 }), expected),
    ).toThrow(/no filename/);
  });

  it("refuses a name mismatch", () => {
    expect(() =>
      extractPackRecord(npm11Payload({ name: "other-pkg" }), expected),
    ).toThrow(/for package "other-pkg"/);
  });

  it("refuses a version mismatch", () => {
    expect(() =>
      extractPackRecord(npm11Payload({ version: "9.9.9" }), expected),
    ).toThrow(/for version "9.9.9"/);
  });

  // The declared type requires both, matching the runtime. These two probe the
  // runtime guard from outside that type rather than weakening it, so a caller
  // reaching this branch through untyped JS still fails closed.
  const callUnchecked = extractPackRecord as unknown as (
    payload: unknown,
    expected: Record<string, unknown>,
  ) => unknown;

  it("requires expectedName", () => {
    expect(() =>
      callUnchecked(npm11Payload(), { expectedVersion: VERSION }),
    ).toThrow(/expectedName is required/);
  });

  it("requires expectedVersion", () => {
    expect(() =>
      callUnchecked(npm11Payload(), { expectedName: NAME }),
    ).toThrow(/expectedVersion is required/);
  });
});

describe("extractPackRecord — unsafe filenames", () => {
  it("refuses an absolute POSIX path", () => {
    expect(() =>
      extractPackRecord(npm11Payload({ filename: `/tmp/${FILENAME}` }), expected),
    ).toThrow(/absolute path/);
  });

  it("refuses a Windows drive-qualified path", () => {
    expect(() =>
      extractPackRecord(
        npm11Payload({ filename: `C:\\tmp\\${FILENAME}` }),
        expected,
      ),
    ).toThrow(/absolute path/);
  });

  it("refuses a traversal segment", () => {
    expect(() =>
      extractPackRecord(npm11Payload({ filename: `../${FILENAME}` }), expected),
    ).toThrow(/path traversal segment/);
  });

  it("refuses a backslash traversal segment", () => {
    expect(() =>
      extractPackRecord(npm11Payload({ filename: `..\\${FILENAME}` }), expected),
    ).toThrow(/path traversal segment/);
  });

  it("refuses a nested path", () => {
    expect(() =>
      extractPackRecord(npm11Payload({ filename: `dist/${FILENAME}` }), expected),
    ).toThrow(/nested path/);
  });

  it("refuses a non-tgz filename", () => {
    expect(() =>
      extractPackRecord(npm11Payload({ filename: "code-pact-2.8.0.zip" }), expected),
    ).toThrow(/not a \.tgz tarball/);
  });

  it("refuses a leading option prefix", () => {
    expect(() =>
      extractPackRecord(npm11Payload({ filename: "--help.tgz" }), expected),
    ).toThrow(/option prefix/);
  });

  it("refuses a short option prefix", () => {
    expect(() =>
      extractPackRecord(npm11Payload({ filename: "-T.tgz" }), expected),
    ).toThrow(/option prefix/);
  });

  it("refuses a NUL byte", () => {
    expect(() =>
      extractPackRecord(npm11Payload({ filename: `${FILENAME}\0` }), expected),
    ).toThrow(/NUL byte/);
  });
});
