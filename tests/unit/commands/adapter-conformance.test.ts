import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runAdapterConformance } from "../../../src/commands/adapter-conformance.ts";

const VALID_CONTRACT_BODY = `# Some Adapter

> Managed file.

## How to work on a task

Some workflow text.

## Agent contract

The canonical workflow.

### When to invoke code-pact

Per task:

\`\`\`sh
code-pact task prepare <task-id> --agent claude-code --json
code-pact task start    <task-id> --agent claude-code
code-pact task context <task-id> --agent claude-code
code-pact task complete <task-id> --agent claude-code
code-pact task finalize <task-id> --write --json
code-pact verify --phase <p> --task <task-id>
code-pact validate --json
\`\`\`

### What to verify first

- run verify
- check the audit

### How to handle failures

- **blocked dependency** — wait or resume.
- **verification failure** — fix and re-run.
- **adapter drift** — re-upgrade.
- **missing context pack** — task prepare rebuilds it.
`;

function sha256(content: string): string {
  return createHash("sha256")
    .update(content.replace(/\r\n/g, "\n"), "utf8")
    .digest("hex");
}

async function setupAdapter(
  dir: string,
  opts: { instructionContent?: string } = {},
): Promise<void> {
  const instructionContent = opts.instructionContent ?? VALID_CONTRACT_BODY;
  await mkdir(join(dir, ".code-pact", "adapters"), { recursive: true });
  await writeFile(join(dir, "CLAUDE.md"), instructionContent, "utf8");
  const manifest = {
    schema_version: 1,
    agent_name: "claude-code",
    generator_version: "1.11.0",
    adapter_schema_version: 1,
    generated_at: "2026-05-22T00:00:00+00:00",
    profile_fingerprint: {
      instruction_filename: "CLAUDE.md",
      context_dir: ".context/claude-code",
    },
    files: [
      {
        path: "CLAUDE.md",
        sha256: sha256(instructionContent),
        managed: true,
        role: "instruction",
      },
    ],
  };
  // Render as YAML manually (tests/setup.ts may not enable the YAML write lib).
  const yaml = [
    `schema_version: 1`,
    `agent_name: claude-code`,
    `generator_version: 1.11.0`,
    `adapter_schema_version: 1`,
    `generated_at: "${manifest.generated_at}"`,
    `profile_fingerprint:`,
    `  instruction_filename: CLAUDE.md`,
    `  context_dir: .context/claude-code`,
    `files:`,
    `  - path: CLAUDE.md`,
    `    sha256: ${manifest.files[0]!.sha256}`,
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
  dir = await mkdtemp(join(tmpdir(), "code-pact-adapter-conformance-"));
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("runAdapterConformance — happy path", () => {
  it("returns compliant: true when the contract surface is complete", async () => {
    await setupAdapter(dir);
    const result = await runAdapterConformance({
      cwd: dir,
      agentName: "claude-code",
    });
    expect(result.compliant).toBe(true);
    expect(result.agent).toBe("claude-code");
    expect(result.checks.every((c) => c.status === "pass")).toBe(true);
  });

  it("emits both manifest_present and instruction_file_present checks", async () => {
    await setupAdapter(dir);
    const result = await runAdapterConformance({
      cwd: dir,
      agentName: "claude-code",
    });
    const ids = result.checks.map((c) => c.id);
    expect(ids).toContain("manifest_present");
    expect(ids).toContain("instruction_file_present");
  });

  it("emits a file_checksum_match per manifest file", async () => {
    await setupAdapter(dir);
    const result = await runAdapterConformance({
      cwd: dir,
      agentName: "claude-code",
    });
    const checksumChecks = result.checks.filter(
      (c) => c.id === "file_checksum_match",
    );
    // One file in the manifest.
    expect(checksumChecks).toHaveLength(1);
    expect(checksumChecks[0]!.status).toBe("pass");
  });
});

describe("runAdapterConformance — missing manifest", () => {
  it("returns compliant: false and an explanatory check when manifest is absent", async () => {
    // dir is empty — no manifest, no instruction file.
    const result = await runAdapterConformance({
      cwd: dir,
      agentName: "claude-code",
    });
    expect(result.compliant).toBe(false);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]!.id).toBe("manifest_present");
    expect(result.checks[0]!.status).toBe("fail");
  });
});

describe("runAdapterConformance — required CLI surface mentions", () => {
  it("fails when a lifecycle surface is missing", async () => {
    const body = VALID_CONTRACT_BODY.replace(
      /code-pact task prepare.*\n/g,
      "",
    );
    await setupAdapter(dir, { instructionContent: body });
    const result = await runAdapterConformance({
      cwd: dir,
      agentName: "claude-code",
    });
    const surfaceCheck = result.checks.find(
      (c) => c.id === "required_cli_surface_mentions",
    );
    expect(surfaceCheck?.status).toBe("fail");
    expect(
      (surfaceCheck?.details?.missing_lifecycle as string[]) ?? [],
    ).toContain("code-pact task prepare");
  });

  it("fails when a diagnostic surface is missing", async () => {
    const body = VALID_CONTRACT_BODY.replace(/code-pact validate.*\n/g, "");
    await setupAdapter(dir, { instructionContent: body });
    const result = await runAdapterConformance({
      cwd: dir,
      agentName: "claude-code",
    });
    const surfaceCheck = result.checks.find(
      (c) => c.id === "required_cli_surface_mentions",
    );
    expect(surfaceCheck?.status).toBe("fail");
    expect(
      (surfaceCheck?.details?.missing_diagnostic as string[]) ?? [],
    ).toContain("code-pact validate");
  });
});

describe("runAdapterConformance — required failure guidance", () => {
  it("fails when a required failure keyword is missing", async () => {
    const body = VALID_CONTRACT_BODY.replace(/blocked dependency/g, "blocked deps");
    await setupAdapter(dir, { instructionContent: body });
    const result = await runAdapterConformance({
      cwd: dir,
      agentName: "claude-code",
    });
    const guidanceCheck = result.checks.find(
      (c) => c.id === "required_failure_guidance",
    );
    expect(guidanceCheck?.status).toBe("fail");
    expect(
      (guidanceCheck?.details?.missing as string[]) ?? [],
    ).toContain("blocked dependency");
  });
});

describe("runAdapterConformance — agent contract section + axes", () => {
  it("fails when the `## Agent contract` heading is missing", async () => {
    const body = VALID_CONTRACT_BODY.replace(
      "## Agent contract",
      "## DRIFTED contract",
    );
    await setupAdapter(dir, { instructionContent: body });
    const result = await runAdapterConformance({
      cwd: dir,
      agentName: "claude-code",
    });
    expect(result.compliant).toBe(false);
    const sectionCheck = result.checks.find(
      (c) => c.id === "contract_section_present",
    );
    expect(sectionCheck?.status).toBe("fail");
  });

  it("fails when an axis sub-heading is missing", async () => {
    const body = VALID_CONTRACT_BODY.replace(
      "### How to handle failures",
      "### Different failure heading",
    );
    await setupAdapter(dir, { instructionContent: body });
    const result = await runAdapterConformance({
      cwd: dir,
      agentName: "claude-code",
    });
    expect(result.compliant).toBe(false);
    const axisCheck = result.checks.find(
      (c) => c.id === "axis_how_to_handle",
    );
    expect(axisCheck?.status).toBe("fail");
  });
});

describe("runAdapterConformance — checksum drift", () => {
  it("fails the per-file checksum check when on-disk content diverges", async () => {
    await setupAdapter(dir);
    // Append bytes after setup, leaving manifest's recorded sha256
    // pointing at the original content.
    await writeFile(
      join(dir, "CLAUDE.md"),
      VALID_CONTRACT_BODY + "\n<!-- tampered -->\n",
      "utf8",
    );
    const result = await runAdapterConformance({
      cwd: dir,
      agentName: "claude-code",
    });
    expect(result.compliant).toBe(false);
    const checksumCheck = result.checks.find(
      (c) => c.id === "file_checksum_match",
    );
    expect(checksumCheck?.status).toBe("fail");
    const details = checksumCheck?.details as
      | { expected_sha256?: string; actual_sha256?: string }
      | undefined;
    expect(details?.expected_sha256).toBeDefined();
    expect(details?.actual_sha256).toBeDefined();
    expect(details?.expected_sha256).not.toBe(details?.actual_sha256);
  });
});
