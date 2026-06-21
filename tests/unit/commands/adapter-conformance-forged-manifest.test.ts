import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAdapterConformance } from "../../../src/commands/adapter-conformance.ts";

// SECURITY (Blocker 2 — forged-manifest file-content/SHA oracle). The manifest
// is project-supplied; a hostile repo can list `path: .env` (or any credential
// file) and try to make `adapter conformance` READ it and emit its SHA-256 /
// contract-heading substrings. The ownership guard must refuse the read.

function sha256(content: string): string {
  return createHash("sha256")
    .update(content.replace(/\r\n/g, "\n"), "utf8")
    .digest("hex");
}

const VALID_CONTRACT_BODY = `# CLAUDE.md

## Agent contract

### When to invoke code-pact

code-pact task prepare <task-id> --agent claude-code --json
code-pact task start <task-id> --agent claude-code
code-pact task context <task-id> --agent claude-code
code-pact task complete <task-id> --agent claude-code
code-pact task finalize <task-id> --write --json
code-pact verify --phase <p> --task <task-id>
code-pact recommend --phase <p> --task <task-id> --agent claude-code --json
code-pact validate --json

### What to verify first

- Read \`data.recommendation\`; let \`lifecycleMode\` pick the loop. When the runtime cannot switch model, report the limitation.
- \`record_only\` is a lighter loop, not lighter verification — run verification, then \`task record-done\`.

### How to handle failures

- **blocked dependency** — wait or resume.
- **verification failure** — fix and re-run.
- **adapter drift** — re-upgrade.
- **missing context pack** — task prepare rebuilds it.
`;

const SECRET = "API_TOKEN=top-secret-marker-7c1f";

/**
 * Writes a forged manifest whose `files[]` includes an extra, attacker-chosen
 * `.env` entry (claiming role + a wrong sha256 to provoke the mismatch branch
 * that would emit `actual_sha256`). The instruction entry stays valid so the
 * rest of conformance runs normally.
 */
async function setupForged(dir: string): Promise<void> {
  await mkdir(join(dir, ".code-pact", "adapters"), { recursive: true });
  await writeFile(join(dir, "CLAUDE.md"), VALID_CONTRACT_BODY, "utf8");
  await writeFile(join(dir, ".env"), `${SECRET}\n`, "utf8");
  const yaml = [
    `schema_version: 1`,
    `agent_name: claude-code`,
    `generator_version: 1.11.0`,
    `adapter_schema_version: 1`,
    `generated_at: "2026-05-22T00:00:00+00:00"`,
    `profile_fingerprint:`,
    `  instruction_filename: CLAUDE.md`,
    `  context_dir: .context/claude-code`,
    `files:`,
    `  - path: CLAUDE.md`,
    `    sha256: ${sha256(VALID_CONTRACT_BODY)}`,
    `    managed: true`,
    `    role: instruction`,
    `  - path: .env`,
    `    sha256: "${"0".repeat(64)}"`,
    `    managed: true`,
    `    role: instruction`,
    ``,
  ].join("\n");
  await writeFile(
    join(dir, ".code-pact", "adapters", "claude-code.manifest.yaml"),
    yaml,
    "utf8",
  );
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "code-pact-forged-manifest-"));
});
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("runAdapterConformance — forged manifest .env oracle (security)", () => {
  it("refuses to read a forged .env entry: no actual_sha256, no secret in output", async () => {
    await setupForged(dir);
    const result = await runAdapterConformance({ cwd: dir, agentName: "claude-code" });

    // The forged entry must be reported as an ownership failure, not hashed.
    const unowned = result.checks.find(
      (c) => c.id === "adapter_file_path_unowned" && c.file === ".env",
    );
    expect(unowned?.status).toBe("fail");
    expect(unowned?.severity).toBe("required");

    // No checksum result was produced for .env (the file was never read).
    const envChecksum = result.checks.find(
      (c) => c.id === "file_checksum_match" && c.file === ".env",
    );
    expect(envChecksum).toBeUndefined();

    // The secret content / its sha must never appear anywhere in the result.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("top-secret-marker");
    expect(serialized).not.toContain(sha256(`${SECRET}\n`));

    // No check object carries an actual_sha256 for the forged path.
    for (const c of result.checks) {
      if (c.file === ".env") {
        expect(c.details?.actual_sha256).toBeUndefined();
      }
    }

    // Fail-closed: an unowned required check makes the adapter non-compliant.
    expect(result.compliant).toBe(false);
  });

  it("a forged instruction-role .env never reaches contract-heading inspection", async () => {
    // Manifest whose ONLY instruction entry is .env — the instruction read must
    // be refused before any heading/substring contract check runs on it.
    await mkdir(join(dir, ".code-pact", "adapters"), { recursive: true });
    await writeFile(join(dir, ".env"), `${SECRET}\n`, "utf8");
    const yaml = [
      `schema_version: 1`,
      `agent_name: claude-code`,
      `generator_version: 1.11.0`,
      `adapter_schema_version: 1`,
      `generated_at: "2026-05-22T00:00:00+00:00"`,
      `profile_fingerprint:`,
      `  instruction_filename: CLAUDE.md`,
      `  context_dir: .context/claude-code`,
      `files:`,
      `  - path: .env`,
      `    sha256: "${"0".repeat(64)}"`,
      `    managed: true`,
      `    role: instruction`,
      ``,
    ].join("\n");
    await writeFile(
      join(dir, ".code-pact", "adapters", "claude-code.manifest.yaml"),
      yaml,
      "utf8",
    );

    const result = await runAdapterConformance({ cwd: dir, agentName: "claude-code" });

    const unowned = result.checks.find((c) => c.id === "adapter_file_path_unowned");
    expect(unowned?.status).toBe("fail");
    // No contract-section / axis checks ran (we returned before reading).
    expect(result.checks.find((c) => c.id === "contract_section_present")).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("top-secret-marker");
    expect(result.compliant).toBe(false);
  });
});
