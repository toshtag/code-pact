import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { cmdTaskLock } from "../../../src/cli/commands/task-lock.ts";
import { cmdTask } from "../../../src/cli/commands/task.ts";

// The review-contract checks throw from the core. These tests pin the CLI EDGE:
// every command that can reach them must turn the refusal into the project's
// structured error envelope with exit 2, in JSON and human-readable mode alike.
// Without the mapping the error escapes to the top-level handler in `src/cli.ts`,
// which prints `internal error: ...` and exits 3 with no envelope — a
// machine-unreadable failure for exactly the agents this contract exists to help.
//
// A MISSING contract is deliberately not an error at this stage; the tests below
// assert that it still succeeds, so the deferral is pinned rather than assumed.

let cwd: string;
let originalCwd: string;
let stdout: string[];
let stderr: string[];

beforeEach(async () => {
  originalCwd = process.cwd();
  cwd = await mkdtemp(join(tmpdir(), "code-pact-cli-review-contract-"));
  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation(chunk => {
    stderr.push(String(chunk));
    return true;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.chdir(originalCwd);
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

function git(args: string[]): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

/** A complete, valid boundary contract; every ref is the task's declared write. */
const VALID_CONTRACT: string[] = [
  "    review_contract:",
  "      version: 1",
  "      mode: boundary",
  "      stages:",
  "        - stage: producer",
  "          disposition: in_scope",
  "          claim: The producer emits a stable envelope.",
  "          refs:",
  "            - src/example.ts",
  "        - stage: consumer",
  "          disposition: in_scope",
  "          claim: The consumer validates the envelope.",
  "          refs:",
  "            - src/example.ts",
  "        - stage: runner",
  "          disposition: not_applicable",
  "          rationale: No process is launched.",
  "        - stage: os",
  "          disposition: not_applicable",
  "          rationale: No OS-specific behavior changes.",
  "        - stage: security",
  "          disposition: not_applicable",
  "          rationale: No authority boundary is touched.",
  "      platforms:",
  "        - platform: linux",
  "          disposition: required",
  "          level: integration",
  "          refs:",
  "            - src/example.ts",
  "        - platform: macos",
  "          disposition: not_required",
  "          rationale: No macOS-specific behavior changes.",
  "        - platform: windows",
  "          disposition: not_required",
  "          rationale: No Windows-specific behavior changes.",
  "      evidence:",
  "        - id: envelope-contract",
  "          claim: Producer and consumer agree on the envelope.",
  "          level: integration",
  "          refs:",
  "            - src/example.ts",
];

/** `minimal` on a `feature` task — parses, but the semantics do not hold. */
const INVALID_CONTRACT: string[] = [
  "    review_contract:",
  "      version: 1",
  "      mode: minimal",
  "      rationale: This looks small enough to review quickly.",
];

async function setupProject(
  contract: "valid" | "invalid" | "none",
): Promise<void> {
  await mkdir(join(cwd, "design", "phases"), { recursive: true });
  await mkdir(join(cwd, ".code-pact", "state"), { recursive: true });
  await mkdir(join(cwd, "src"), { recursive: true });

  await writeFile(
    join(cwd, ".code-pact", "project.yaml"),
    [
      "name: test",
      "version: 0.1.0",
      "locale: en-US",
      "default_agent: claude-code",
      "agents:",
      "  - name: claude-code",
      "    profile: agent-profiles/claude-code.yaml",
      "    enabled: true",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(cwd, ".code-pact", "state", "progress.yaml"),
    "events: []\n",
    "utf8",
  );
  await writeFile(
    join(cwd, "design", "roadmap.yaml"),
    "phases:\n  - id: P1\n    path: design/phases/P1-foundation.yaml\n    weight: 10\n",
    "utf8",
  );

  const contractLines =
    contract === "valid"
      ? VALID_CONTRACT
      : contract === "invalid"
        ? INVALID_CONTRACT
        : [];

  await writeFile(
    join(cwd, "design", "phases", "P1-foundation.yaml"),
    [
      "id: P1",
      "name: Foundation",
      "weight: 10",
      "confidence: medium",
      "risk: low",
      "status: planned",
      "objective: Establish the project foundation",
      "definition_of_done:",
      "  - All tasks done",
      "verification:",
      "  commands:",
      "    - node --version",
      "tasks:",
      "  - id: P1-T1",
      "    type: feature",
      "    ambiguity: low",
      "    risk: low",
      "    context_size: small",
      "    write_surface: low",
      "    verification_strength: medium",
      "    expected_duration: short",
      "    status: planned",
      "    description: Test task",
      "    writes:",
      "      - src/example.ts",
      ...contractLines,
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(cwd, "src", "example.ts"),
    "export const x = 1;\n",
    "utf8",
  );

  git(["init", "--quiet"]);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "add", "."]);
  git([
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "--quiet",
    "-m",
    "init",
  ]);
  process.chdir(cwd);
}

function envelope(): {
  ok: boolean;
  error?: { code: string; message: string };
  data?: { task_id?: string; issues?: { details?: { reason?: string } }[] };
} {
  const line = stdout.find(chunk => chunk.trimStart().startsWith("{"));
  expect(line, "expected a JSON envelope on stdout").toBeDefined();
  return JSON.parse(line!);
}

describe("task lock — review contract CLI errors", () => {
  it("maps an invalid contract to TASK_REVIEW_CONTRACT_INVALID with its reasons", async () => {
    await setupProject("invalid");
    const code = await cmdTaskLock(["P1-T1", "--json"], "en-US", false);

    expect(code).toBe(2);
    const out = envelope();
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe("TASK_REVIEW_CONTRACT_INVALID");
    expect(out.data?.issues?.map(i => i.details?.reason)).toContain(
      "minimal_mode_not_allowed",
    );
  });

  it("keeps the human-readable path structured too", async () => {
    await setupProject("invalid");
    const code = await cmdTaskLock(["P1-T1"], "en-US", false);

    expect(code).toBe(2);
    expect(stdout.some(chunk => chunk.trimStart().startsWith("{"))).toBe(false);
    expect([...stdout, ...stderr].join("")).toContain("review_contract");
    expect([...stdout, ...stderr].join("")).not.toContain("internal error");
  });

  it("locks successfully with a valid contract", async () => {
    await setupProject("valid");
    const code = await cmdTaskLock(["P1-T1", "--json"], "en-US", false);

    expect(code).toBe(0);
    expect(envelope().ok).toBe(true);
  });

  it("still locks when the task declares no contract", async () => {
    await setupProject("none");
    const code = await cmdTaskLock(["P1-T1", "--json"], "en-US", false);

    expect(code).toBe(0);
    expect(envelope().ok).toBe(true);
  });
});

describe("task start — review contract CLI errors on the auto-lock path", () => {
  it("maps an invalid contract to TASK_REVIEW_CONTRACT_INVALID with its reasons", async () => {
    await setupProject("invalid");
    const code = await cmdTask(["start", "P1-T1", "--json"], "en-US", false);

    expect(code).toBe(2);
    const out = envelope();
    expect(out.error?.code).toBe("TASK_REVIEW_CONTRACT_INVALID");
    expect(out.data?.issues?.map(i => i.details?.reason)).toContain(
      "minimal_mode_not_allowed",
    );
  });

  it("starts successfully with a valid contract", async () => {
    await setupProject("valid");
    const code = await cmdTask(["start", "P1-T1", "--json"], "en-US", false);

    expect(code).toBe(0);
    expect(envelope().ok).toBe(true);
  });

  it("still starts when the task declares no contract", async () => {
    await setupProject("none");
    const code = await cmdTask(["start", "P1-T1", "--json"], "en-US", false);

    expect(code).toBe(0);
    expect(envelope().ok).toBe(true);
  });
});

describe("task add --review-contract-file", () => {
  async function writeContractFile(
    name: string,
    lines: string[],
  ): Promise<string> {
    // The fragment is the contract itself, so strip the phase-YAML indentation
    // and the `review_contract:` key the inline fixtures carry.
    await writeFile(
      join(cwd, name),
      lines
        .slice(1)
        .map(line => line.replace(/^ {6}/, ""))
        .join("\n") + "\n",
      "utf8",
    );
    return name;
  }

  it("stores a valid contract on the created task", async () => {
    await setupProject("none");
    const file = await writeContractFile("contract.yaml", VALID_CONTRACT);

    const code = await cmdTask(
      [
        "add",
        "P1",
        "--description",
        "A new task",
        "--type",
        "feature",
        "--write",
        "src/example.ts",
        "--review-contract-file",
        file,
        "--json",
      ],
      "en-US",
      false,
    );

    expect(code).toBe(0);
    expect(envelope().ok).toBe(true);

    const { readFile } = await import("node:fs/promises");
    const { parse } = await import("yaml");
    const phase = parse(
      await readFile(join(cwd, "design", "phases", "P1-foundation.yaml"), "utf8"),
    ) as { tasks: { id: string; review_contract?: { mode?: string } }[] };
    const added = phase.tasks.find(t => t.id !== "P1-T1");
    expect(added?.review_contract?.mode).toBe("boundary");
  });

  it("rejects a contract whose semantics do not hold for the task", async () => {
    await setupProject("none");
    const file = await writeContractFile("contract.yaml", INVALID_CONTRACT);

    const code = await cmdTask(
      [
        "add",
        "P1",
        "--description",
        "A new task",
        "--type",
        "feature",
        "--review-contract-file",
        file,
        "--json",
      ],
      "en-US",
      false,
    );

    expect(code).toBe(2);
    const out = envelope();
    expect(out.error?.code).toBe("TASK_REVIEW_CONTRACT_INVALID");
    expect(out.data?.issues?.map(i => i.details?.reason)).toContain(
      "minimal_mode_not_allowed",
    );
  });

  it("rejects a fragment with an unknown key", async () => {
    await setupProject("none");
    await writeFile(
      join(cwd, "contract.yaml"),
      ["version: 1", "mode: minimal", "raitonale: typo", ""].join("\n"),
      "utf8",
    );

    const code = await cmdTask(
      [
        "add",
        "P1",
        "--description",
        "A docs task",
        "--type",
        "docs",
        "--ambiguity",
        "low",
        "--risk",
        "low",
        "--write-surface",
        "low",
        "--review-contract-file",
        "contract.yaml",
        "--json",
      ],
      "en-US",
      false,
    );

    expect(code).toBe(2);
    expect(envelope().error?.code).toBe("TASK_REVIEW_CONTRACT_INVALID");
  });

  it("reports a missing fragment file as CONFIG_ERROR", async () => {
    await setupProject("none");

    const code = await cmdTask(
      [
        "add",
        "P1",
        "--description",
        "A new task",
        "--type",
        "feature",
        "--review-contract-file",
        "absent.yaml",
        "--json",
      ],
      "en-US",
      false,
    );

    expect(code).toBe(2);
    expect(envelope().error?.code).toBe("CONFIG_ERROR");
  });

  it("refuses to combine --review-contract-file with --spec-file", async () => {
    await setupProject("none");
    await writeContractFile("contract.yaml", VALID_CONTRACT);

    const code = await cmdTask(
      [
        "add",
        "P1",
        "--spec-file",
        "spec.yaml",
        "--review-contract-file",
        "contract.yaml",
        "--json",
      ],
      "en-US",
      false,
    );

    expect(code).toBe(2);
    const out = envelope();
    expect(out.error?.code).toBe("CONFIG_ERROR");
    expect(out.error?.message).toContain("--review-contract-file");
  });

  it("accepts a JSON fragment", async () => {
    await setupProject("none");
    await writeFile(
      join(cwd, "contract.json"),
      JSON.stringify({
        version: 1,
        mode: "minimal",
        rationale: "Documentation-only change with no executable boundary.",
      }),
      "utf8",
    );

    const code = await cmdTask(
      [
        "add",
        "P1",
        "--description",
        "A docs task",
        "--type",
        "docs",
        "--ambiguity",
        "low",
        "--risk",
        "low",
        "--write-surface",
        "low",
        "--review-contract-file",
        "contract.json",
        "--json",
      ],
      "en-US",
      false,
    );

    expect(code).toBe(0);
    expect(envelope().ok).toBe(true);
  });
});
