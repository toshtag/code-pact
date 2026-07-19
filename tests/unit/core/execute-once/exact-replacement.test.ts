import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  applyExactReplacement,
  type ExactReplacement,
} from "../../../../src/core/execute-once/exact-replacement.ts";

async function withTempProject<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), "code-pact-execute-once-"));
  try {
    return await fn(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function sha256(content: string): string {
  return createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
}

describe("applyExactReplacement", () => {
  it("applies a valid exact replacement atomically", async () => {
    await withTempProject(async cwd => {
      const content = "hello world";
      await mkdir(join(cwd, "src"), { recursive: true });
      await writeFile(join(cwd, "src", "example.ts"), content, "utf8");

      const replacement: ExactReplacement = {
        path: "src/example.ts",
        expected_file_sha256: sha256(content),
        old_text: "world",
        new_text: "planet",
      };

      const result = await applyExactReplacement(cwd, replacement);

      expect(result.kind).toBe("applied");
      if (result.kind === "applied") {
        expect(result.originalContent).toBe(content);
      }

      const written = await readFile(join(cwd, "src", "example.ts"), "utf8");
      expect(written).toBe("hello planet");
    });
  });

  it("rejects stale whole-file sha256", async () => {
    await withTempProject(async cwd => {
      const content = "hello world";
      await mkdir(join(cwd, "src"), { recursive: true });
      await writeFile(join(cwd, "src", "example.ts"), content, "utf8");

      const replacement: ExactReplacement = {
        path: "src/example.ts",
        expected_file_sha256: "0000000000000000000000000000000000000000000000000000000000000000",
        old_text: "world",
        new_text: "planet",
      };

      const result = await applyExactReplacement(cwd, replacement);

      expect(result.kind).toBe("rejected");
      if (result.kind === "rejected") {
        expect(result.reason).toBe("STALE_FILE_SHA");
      }
    });
  });

  it("rejects old_text not found", async () => {
    await withTempProject(async cwd => {
      const content = "hello world";
      await mkdir(join(cwd, "src"), { recursive: true });
      await writeFile(join(cwd, "src", "example.ts"), content, "utf8");

      const replacement: ExactReplacement = {
        path: "src/example.ts",
        expected_file_sha256: sha256(content),
        old_text: "missing",
        new_text: "planet",
      };

      const result = await applyExactReplacement(cwd, replacement);

      expect(result.kind).toBe("rejected");
      if (result.kind === "rejected") {
        expect(result.reason).toBe("OLD_TEXT_NOT_FOUND");
      }
    });
  });

  it("rejects ambiguous old_text", async () => {
    await withTempProject(async cwd => {
      const content = "foo foo foo";
      await mkdir(join(cwd, "src"), { recursive: true });
      await writeFile(join(cwd, "src", "example.ts"), content, "utf8");

      const replacement: ExactReplacement = {
        path: "src/example.ts",
        expected_file_sha256: sha256(content),
        old_text: "foo",
        new_text: "bar",
      };

      const result = await applyExactReplacement(cwd, replacement);

      expect(result.kind).toBe("rejected");
      if (result.kind === "rejected") {
        expect(result.reason).toBe("OLD_TEXT_MULTIPLE_MATCHES");
      }
    });
  });

  it("rejects empty old_text", async () => {
    await withTempProject(async cwd => {
      const content = "hello world";
      await mkdir(join(cwd, "src"), { recursive: true });
      await writeFile(join(cwd, "src", "example.ts"), content, "utf8");

      const replacement: ExactReplacement = {
        path: "src/example.ts",
        expected_file_sha256: sha256(content),
        old_text: "",
        new_text: "planet",
      };

      const result = await applyExactReplacement(cwd, replacement);

      expect(result.kind).toBe("rejected");
      if (result.kind === "rejected") {
        expect(result.reason).toBe("EMPTY_OLD_TEXT");
      }
    });
  });

  it("rejects no-op replacement", async () => {
    await withTempProject(async cwd => {
      const content = "hello world";
      await mkdir(join(cwd, "src"), { recursive: true });
      await writeFile(join(cwd, "src", "example.ts"), content, "utf8");

      const replacement: ExactReplacement = {
        path: "src/example.ts",
        expected_file_sha256: sha256(content),
        old_text: "world",
        new_text: "world",
      };

      const result = await applyExactReplacement(cwd, replacement);

      expect(result.kind).toBe("rejected");
      if (result.kind === "rejected") {
        expect(result.reason).toBe("NO_OP_REPLACEMENT");
      }
    });
  });

  it("rejects scope mismatch", async () => {
    await withTempProject(async cwd => {
      const content = "hello world";
      await mkdir(join(cwd, "src"), { recursive: true });
      await writeFile(join(cwd, "src", "example.ts"), content, "utf8");

      const replacement: ExactReplacement = {
        path: "src/other.ts",
        expected_file_sha256: sha256(content),
        old_text: "world",
        new_text: "planet",
      };

      const result = await applyExactReplacement(
        cwd,
        replacement,
        "src/example.ts",
      );

      expect(result.kind).toBe("rejected");
      if (result.kind === "rejected") {
        expect(result.reason).toBe("SCOPE_MISMATCH");
      }
    });
  });

  it("rejects symlinks", async () => {
    await withTempProject(async cwd => {
      await writeFile(join(cwd, "target.txt"), "hello world", "utf8");
      await symlink("target.txt", join(cwd, "link.txt"));

      const replacement: ExactReplacement = {
        path: "link.txt",
        expected_file_sha256: sha256("hello world"),
        old_text: "world",
        new_text: "planet",
      };

      const result = await applyExactReplacement(cwd, replacement);

      expect(result.kind).toBe("rejected");
      if (result.kind === "rejected") {
        expect(result.reason).toBe("SOURCE_IS_SYMLINK");
      }
    });
  });

  it("rejects oversized new_text", async () => {
    await withTempProject(async cwd => {
      const content = "hello world";
      await mkdir(join(cwd, "src"), { recursive: true });
      await writeFile(join(cwd, "src", "example.ts"), content, "utf8");

      const replacement: ExactReplacement = {
        path: "src/example.ts",
        expected_file_sha256: sha256(content),
        old_text: "world",
        new_text: "x".repeat(8193),
      };

      const result = await applyExactReplacement(cwd, replacement);

      expect(result.kind).toBe("rejected");
      if (result.kind === "rejected") {
        expect(result.reason).toBe("NEW_TEXT_TOO_LARGE");
      }
    });
  });

  it("rejects oversized source", async () => {
    await withTempProject(async cwd => {
      const content = "x".repeat(8193);
      await mkdir(join(cwd, "src"), { recursive: true });
      await writeFile(join(cwd, "src", "example.ts"), content, "utf8");

      const replacement: ExactReplacement = {
        path: "src/example.ts",
        expected_file_sha256: sha256(content),
        old_text: "x",
        new_text: "y",
      };

      const result = await applyExactReplacement(cwd, replacement);

      expect(result.kind).toBe("rejected");
      if (result.kind === "rejected") {
        expect(result.reason).toBe("SOURCE_TOO_LARGE");
      }
    });
  });
});
