// P29-T2: contract regression for the `task prepare` commands dictionary.
//
// The v1.11+ single per-task entry point `task prepare` returns a
// `commands` dictionary the agent is meant to run verbatim. A v1.13.3
// review found `commands.finalize` was emitted as
// `code-pact task finalize <id> --agent <agent>`, which the finalize
// parser rejects with CONFIG_ERROR "Unknown option '--agent'". The bug
// survived because the only test pinned the broken string as expected
// and nothing ran the emitted commands through the parser.
//
// This test closes that gap with two layers:
//
//   1. parser contract — every command `task prepare --json` emits is
//      run verbatim through the built CLI; none may produce an
//      "Unknown option" failure (the strict parseArgs message, emitted
//      in both JSON and human mode). This layer fails on the --agent bug.
//   2. lifecycle — the emitted commands actually drive
//      start → complete → finalize, and the finalize command reaches a
//      finalize outcome rather than CONFIG_ERROR.
//
// Test policy mirrors e2e-workflow.test.ts: deterministic verify command
// (`node --version`), single temp project per scenario, no network, no
// sleeps.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import {
  createTempProject,
  ensureCliBuilt,
  expectJsonOk,
} from "../helpers/cli.ts";

beforeAll(() => {
  ensureCliBuilt();
}, 60_000);

/** Turn a `code-pact <args...>` command string into argv for the built CLI. */
function toArgv(command: string): string[] {
  const parts = command.trim().split(/\s+/);
  if (parts[0] === "code-pact") parts.shift();
  return parts;
}

/** Add phase P1 (deterministic verify) + a single planned task P1-T1. */
async function setupTask(project: Awaited<ReturnType<typeof createTempProject>>): Promise<void> {
  const add = project.run([
    "phase", "add",
    "--id", "P1",
    "--name", "Foundation",
    "--objective", "Foundation phase for the prepare-commands contract test",
    "--weight", "10",
    "--verify-command", "node --version",
    "--json",
  ]);
  expectJsonOk(add);

  const phasePath = join(project.dir, "design", "phases", "P1-foundation.yaml");
  const doc = parseYaml(await readFile(phasePath, "utf8")) as Record<string, unknown>;
  doc.tasks = [
    {
      id: "P1-T1",
      type: "feature",
      ambiguity: "low",
      risk: "low",
      context_size: "small",
      write_surface: "low",
      verification_strength: "weak",
      expected_duration: "short",
      status: "planned",
      description: "prepare-commands contract test task",
    },
  ];
  await writeFile(phasePath, stringifyYaml(doc), "utf8");
}

type Commands = {
  context: string;
  start: string;
  verify: string;
  complete: string;
  finalize: string;
};

function prepareCommands(
  project: Awaited<ReturnType<typeof createTempProject>>,
): Commands {
  const res = project.run([
    "task", "prepare", "P1-T1", "--agent", "claude-code", "--json",
  ]);
  const env = expectJsonOk<{ commands: Commands }>(res);
  return env.data.commands;
}

describe("task prepare — emitted commands are accepted by the CLI parser", () => {
  let project: Awaited<ReturnType<typeof createTempProject>>;

  beforeEach(async () => {
    project = await createTempProject({ prefix: "code-pact-prepare-cmd-" });
    await setupTask(project);
  });

  afterEach(async () => {
    await project.cleanup();
  });

  it("no emitted command uses an unsupported flag (regression: finalize --agent)", () => {
    const commands = prepareCommands(project);

    for (const [name, command] of Object.entries(commands)) {
      const res = project.run(toArgv(command));
      const combined = `${res.stdout}\n${res.stderr}`;
      // "Unknown option" is Node's strict parseArgs message, emitted in
      // both JSON envelopes and human stderr. State-dependent failures
      // (TASK_FINALIZE_NOT_ELIGIBLE, VERIFICATION_FAILED, ...) are fine —
      // we only fail on an unsupported flag.
      expect(
        combined.includes("Unknown option"),
        `commands.${name} ("${command}") was rejected by the parser:\n${combined}`,
      ).toBe(false);
    }
  });

  it("commands.finalize carries no --agent flag (finalize takes none)", () => {
    const commands = prepareCommands(project);
    expect(commands.finalize).not.toContain("--agent");
  });

  it("emitted commands drive start → complete → finalize end-to-end", () => {
    const commands = prepareCommands(project);

    expectJsonOk(project.run([...toArgv(commands.start), "--json"]));
    expectJsonOk(project.run([...toArgv(commands.complete), "--json"]));

    // commands.finalize already includes --write --json.
    const fin = project.run(toArgv(commands.finalize));
    const env = expectJsonOk<{ kind: string }>(fin);
    expect(["would_finalize", "finalized", "already_finalized"]).toContain(env.data.kind);
  });
});
