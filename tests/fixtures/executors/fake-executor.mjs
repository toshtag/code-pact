#!/usr/bin/env node
import { createHash } from "node:crypto";

const mode = process.env.EXECUTOR_MODE ?? "replace";
const oldText = process.env.EXECUTOR_OLD ?? "hello";
const newText = process.env.EXECUTOR_NEW ?? "hi";

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  input += chunk;
});
process.stdin.on("end", () => {
  try {
    const data = JSON.parse(input);

    if (mode === "blocked") {
      const reason = process.env.EXECUTOR_REASON || "blocked by policy";
      process.stdout.write(JSON.stringify({ kind: "blocked", reason }));
      return;
    }

    if (mode === "timeout") {
      setTimeout(() => {
        process.stdout.write(
          JSON.stringify({ kind: "blocked", reason: "should not arrive" }),
        );
      }, 60_000);
      return;
    }

    if (mode === "nonzero") {
      const message = process.env.EXECUTOR_STDERR || "intentional failure";
      process.stderr.write(message);
      process.exit(1);
    }

    if (mode === "malformed") {
      process.stdout.write("this is not json");
      return;
    }

    if (mode === "extra") {
      process.stdout.write(
        JSON.stringify({ kind: "blocked", reason: "x" }) + " extra stuff",
      );
      return;
    }

    if (mode === "oversized") {
      const huge = "x".repeat(40_000);
      process.stdout.write(JSON.stringify({ kind: "blocked", reason: huge }));
      return;
    }

    if (mode === "invalid_kind") {
      process.stdout.write(
        JSON.stringify({ kind: "repair", reason: "not allowed" }),
      );
      return;
    }

    if (mode === "missing_fields") {
      process.stdout.write(
        JSON.stringify({ kind: "replace_exact", old_text: "only old" }),
      );
      return;
    }

    if (mode === "sha_mismatch") {
      process.stdout.write(
        JSON.stringify({
          kind: "replace_exact",
          expected_file_sha256: "0".repeat(64),
          old_text: oldText,
          new_text: newText,
        }),
      );
      return;
    }

    const content = data.source.content;
    const sha = createHash("sha256")
      .update(Buffer.from(content, "utf8"))
      .digest("hex");

    const output = JSON.stringify({
      kind: "replace_exact",
      expected_file_sha256: sha,
      old_text: oldText,
      new_text: newText,
    });
    process.stdout.write(output);
  } catch (error) {
    process.stderr.write(String(error));
    process.exit(1);
  }
});
