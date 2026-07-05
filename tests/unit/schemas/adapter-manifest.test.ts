import { describe, it, expect } from "vitest";
import {
  AdapterManifest,
  ManifestFile,
  RelativePosixPath,
} from "../../../src/core/schemas/adapter-manifest.ts";

const VALID_FILE: unknown = {
  path: "CLAUDE.md",
  sha256: "a".repeat(64),
  managed: true,
  role: "instruction",
};

const VALID_MANIFEST: unknown = {
  schema_version: 1,
  agent_name: "claude-code",
  generator_version: "0.9.0-alpha.0",
  adapter_schema_version: 1,
  generated_at: "2026-05-19T12:00:00+00:00",
  profile_fingerprint: {
    instruction_filename: "CLAUDE.md",
    context_dir: ".context/claude-code",
    skill_dir: ".claude/skills",
    hook_dir: ".claude/hooks",
  },
  files: [VALID_FILE],
};

describe("RelativePosixPath", () => {
  it("accepts a simple filename", () => {
    expect(RelativePosixPath.parse("CLAUDE.md")).toBe("CLAUDE.md");
  });

  it("accepts a nested POSIX path", () => {
    expect(RelativePosixPath.parse(".claude/skills/context.md")).toBe(
      ".claude/skills/context.md",
    );
  });

  it("rejects an empty string", () => {
    expect(() => RelativePosixPath.parse("")).toThrow();
  });

  it("rejects an absolute path", () => {
    expect(() => RelativePosixPath.parse("/etc/passwd")).toThrow();
  });

  it("rejects a tilde-prefixed path", () => {
    expect(() => RelativePosixPath.parse("~/secrets")).toThrow();
  });

  it("rejects a path with backslash separators", () => {
    expect(() => RelativePosixPath.parse("foo\\bar")).toThrow();
  });

  it("rejects a Windows drive-letter path", () => {
    expect(() => RelativePosixPath.parse("C:/foo")).toThrow();
  });

  it("rejects a path containing `..`", () => {
    expect(() => RelativePosixPath.parse("../etc/passwd")).toThrow();
  });

  it("rejects an embedded `..` segment", () => {
    expect(() => RelativePosixPath.parse("foo/../bar")).toThrow();
  });

  it("rejects a single-dot segment", () => {
    expect(() => RelativePosixPath.parse("./foo")).toThrow();
  });

  it("rejects a double-slash (empty segment)", () => {
    expect(() => RelativePosixPath.parse("foo//bar")).toThrow();
  });

  it("rejects a trailing slash", () => {
    expect(() => RelativePosixPath.parse("foo/")).toThrow();
  });
});

describe("ManifestFile", () => {
  it("accepts a valid file entry", () => {
    const f = ManifestFile.parse(VALID_FILE);
    expect(f.path).toBe("CLAUDE.md");
    expect(f.role).toBe("instruction");
  });

  it("rejects sha256 that is not 64 lowercase hex characters", () => {
    expect(() =>
      ManifestFile.parse({ ...(VALID_FILE as object), sha256: "short" }),
    ).toThrow();
    expect(() =>
      ManifestFile.parse({ ...(VALID_FILE as object), sha256: "A".repeat(64) }),
    ).toThrow();
    expect(() =>
      ManifestFile.parse({ ...(VALID_FILE as object), sha256: "g".repeat(64) }),
    ).toThrow();
  });

  it("rejects unknown role", () => {
    expect(() =>
      ManifestFile.parse({ ...(VALID_FILE as object), role: "config" }),
    ).toThrow();
  });

  it("rejects extra fields under .strict()", () => {
    expect(() =>
      ManifestFile.parse({ ...(VALID_FILE as object), extra: "x" }),
    ).toThrow();
  });

  it("rejects a path with `..`", () => {
    expect(() =>
      ManifestFile.parse({ ...(VALID_FILE as object), path: "../etc/passwd" }),
    ).toThrow();
  });
});

describe("AdapterManifest", () => {
  it("accepts a valid manifest", () => {
    const m = AdapterManifest.parse(VALID_MANIFEST);
    expect(m.schema_version).toBe(1);
    expect(m.agent_name).toBe("claude-code");
    expect(m.files).toHaveLength(1);
  });

  it("accepts an empty files array", () => {
    const m = AdapterManifest.parse({ ...(VALID_MANIFEST as object), files: [] });
    expect(m.files).toEqual([]);
  });

  it("accepts a fingerprint without optional fields", () => {
    const minimal = {
      ...(VALID_MANIFEST as object),
      profile_fingerprint: {
        instruction_filename: "AGENTS.md",
        context_dir: ".context/codex",
      },
    };
    const m = AdapterManifest.parse(minimal);
    expect(m.profile_fingerprint.skill_dir).toBeUndefined();
    expect(m.profile_fingerprint.hook_dir).toBeUndefined();
    expect(m.profile_fingerprint.resolved_model).toBeUndefined();
  });

  it("accepts a fingerprint with resolved_model", () => {
    const withModel = {
      ...(VALID_MANIFEST as object),
      profile_fingerprint: {
        instruction_filename: "CLAUDE.md",
        context_dir: ".context/claude-code",
        skill_dir: ".claude/skills",
        hook_dir: ".claude/hooks",
        resolved_model: "opus-4.7",
      },
    };
    const m = AdapterManifest.parse(withModel);
    expect(m.profile_fingerprint.resolved_model).toBe("opus-4.7");
  });

  it("rejects schema_version other than 1", () => {
    expect(() =>
      AdapterManifest.parse({ ...(VALID_MANIFEST as object), schema_version: 2 }),
    ).toThrow();
    expect(() =>
      AdapterManifest.parse({ ...(VALID_MANIFEST as object), schema_version: 0 }),
    ).toThrow();
  });

  it("rejects negative adapter_schema_version", () => {
    expect(() =>
      AdapterManifest.parse({
        ...(VALID_MANIFEST as object),
        adapter_schema_version: -1,
      }),
    ).toThrow();
  });

  it("rejects non-integer adapter_schema_version", () => {
    expect(() =>
      AdapterManifest.parse({
        ...(VALID_MANIFEST as object),
        adapter_schema_version: 1.5,
      }),
    ).toThrow();
  });

  it("rejects a malformed generated_at timestamp", () => {
    expect(() =>
      AdapterManifest.parse({
        ...(VALID_MANIFEST as object),
        generated_at: "yesterday",
      }),
    ).toThrow();
  });

  it("rejects missing required top-level fields", () => {
    const { agent_name: _, ...rest } = VALID_MANIFEST as Record<string, unknown>;
    expect(() => AdapterManifest.parse(rest)).toThrow();
  });

  it("rejects extra top-level fields under .strict()", () => {
    expect(() =>
      AdapterManifest.parse({ ...(VALID_MANIFEST as object), extra: "x" }),
    ).toThrow();
  });

  it("rejects extra fingerprint fields under .strict()", () => {
    expect(() =>
      AdapterManifest.parse({
        ...(VALID_MANIFEST as object),
        profile_fingerprint: {
          instruction_filename: "CLAUDE.md",
          context_dir: ".context/claude-code",
          unexpected: "x",
        },
      }),
    ).toThrow();
  });

  it("rejects an absolute path inside files[]", () => {
    expect(() =>
      AdapterManifest.parse({
        ...(VALID_MANIFEST as object),
        files: [{ ...(VALID_FILE as object), path: "/etc/passwd" }],
      }),
    ).toThrow();
  });

  it("rejects a `..` path inside files[]", () => {
    expect(() =>
      AdapterManifest.parse({
        ...(VALID_MANIFEST as object),
        files: [{ ...(VALID_FILE as object), path: "../etc/passwd" }],
      }),
    ).toThrow();
  });
});
