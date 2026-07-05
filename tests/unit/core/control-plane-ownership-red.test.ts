import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  symlink,
  readFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { runInit } from "../../../src/commands/init.ts";
import { runAdapterInstall } from "../../../src/commands/adapter-install.ts";
import { runDoctor } from "../../../src/commands/doctor.ts";
import { runValidate } from "../../../src/commands/validate.ts";
import { loadProject } from "../../../src/core/project.ts";
import { resolveProjectConfigPath } from "../../../src/core/project-config-path.ts";

// ---------------------------------------------------------------------------
// Red tests: these MUST fail on the current HEAD and pass after the fixes.
//
// Tests:
//   2.1 project.yaml in-project symlink → loadProject rejects, target not read
//   2.2 doctor instruction existence oracle → .env not probed
//   2.2b doctor/validate refuse agent profile paths outside agent-profiles/**
//   2.2c profile identity mismatch cannot bypass adapter contract checks
//   2.3 hook_dir oracle → .env not stat'd
//   2.5 model profile directory symlink → CONFIG_ERROR, not empty array
// ---------------------------------------------------------------------------

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "code-pact-cp-ownership-red-"));
  await runInit({
    cwd: dir,
    locale: "en-US",
    agents: ["claude-code"],
    force: false,
    json: false,
  });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 2.1 project.yaml in-project symlink
// ---------------------------------------------------------------------------

describe("2.1 project.yaml in-project symlink is rejected by loadProject", () => {
  it("loadProject throws CONFIG_ERROR when project.yaml is an in-project symlink", async () => {
    // Create a private target with a schema-valid project.yaml containing a marker.
    const privateDir = join(dir, ".local");
    await mkdir(privateDir, { recursive: true });
    const originalRaw = await readFile(
      join(dir, ".code-pact", "project.yaml"),
      "utf8",
    );
    const original = parseYaml(originalRaw) as Record<string, unknown>;
    // Add a marker to distinguish the symlink target from the real project.yaml.
    const targetContent = stringifyYaml({
      ...original,
      name: "PRIVATE-SYMLINK-MARKER",
    });
    await writeFile(
      join(privateDir, "private-project.yaml"),
      targetContent,
      "utf8",
    );

    // Replace project.yaml with an in-project symlink.
    await rm(join(dir, ".code-pact", "project.yaml"));
    await symlink(
      join(privateDir, "private-project.yaml"),
      join(dir, ".code-pact", "project.yaml"),
    );

    // loadProject must reject — the symlink target stays inside the project
    // (containment passes) but ownership does not.
    await expect(loadProject(dir)).rejects.toMatchObject({
      code: "CONFIG_ERROR",
    });
  });

  it("resolveProjectConfigPath rejects the in-project symlink with PATH_NOT_OWNED", async () => {
    const privateDir = join(dir, ".local");
    await mkdir(privateDir, { recursive: true });
    await writeFile(
      join(privateDir, "private-project.yaml"),
      "name: test\n",
      "utf8",
    );
    await rm(join(dir, ".code-pact", "project.yaml"));
    await symlink(
      join(privateDir, "private-project.yaml"),
      join(dir, ".code-pact", "project.yaml"),
    );

    await expect(resolveProjectConfigPath(dir)).rejects.toMatchObject({
      code: "PATH_NOT_OWNED",
    });
  });
});

// ---------------------------------------------------------------------------
// 2.2 doctor instruction existence oracle
// ---------------------------------------------------------------------------

describe("2.2 doctor does not probe arbitrary instruction_filename paths", () => {
  it("doctor result is identical whether .env exists or not when instruction_filename is .env", async () => {
    // Point the agent profile at .env.
    const profilePath = join(
      dir,
      ".code-pact",
      "agent-profiles",
      "claude-code.yaml",
    );
    const raw = await readFile(profilePath, "utf8");
    await writeFile(
      profilePath,
      raw.replace(
        "instruction_filename: CLAUDE.md",
        "instruction_filename: .env",
      ),
      "utf8",
    );

    // Run doctor without .env.
    const resultWithoutEnv = await runDoctor(dir);

    // Create .env.
    await writeFile(join(dir, ".env"), "SECRET=deadbeef\n", "utf8");

    // Run doctor with .env.
    const resultWithEnv = await runDoctor(dir);

    // The ADAPTER_MISSING issue must not differ — the existence of .env
    // must not be observable through the doctor result.
    const withoutMissing = resultWithoutEnv.issues.filter(
      i => i.code === "ADAPTER_MISSING",
    );
    const withMissing = resultWithEnv.issues.filter(
      i => i.code === "ADAPTER_MISSING",
    );
    expect(withMissing).toEqual(withoutMissing);

    // A profile contract violation issue should be present in both cases.
    const withoutContract = resultWithoutEnv.issues.filter(
      i =>
        i.code === "ADAPTER_PROFILE_CONTRACT_VIOLATION" ||
        i.code === "SCHEMA_ERROR",
    );
    const withContract = resultWithEnv.issues.filter(
      i =>
        i.code === "ADAPTER_PROFILE_CONTRACT_VIOLATION" ||
        i.code === "SCHEMA_ERROR",
    );
    expect(withContract.length).toBeGreaterThan(0);
    expect(withContract).toEqual(withoutContract);
  });

  it("unsupported agent doctor/validate result is identical whether .env exists or not", async () => {
    const projectPath = join(dir, ".code-pact", "project.yaml");
    await writeFile(
      projectPath,
      [
        "name: test-project",
        "version: 0.1.0",
        "locale: en-US",
        "default_agent: private-probe",
        "agents:",
        "  - name: private-probe",
        "    profile: agent-profiles/private-probe.yaml",
        "    enabled: true",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(dir, ".code-pact", "agent-profiles", "private-probe.yaml"),
      [
        "name: private-probe",
        "instruction_filename: .env",
        "context_dir: .context/private-probe",
        "model_map: {}",
        "",
      ].join("\n"),
      "utf8",
    );

    const doctorWithoutEnv = await runDoctor(dir);
    const validateWithoutEnv = await runValidate({ cwd: dir });
    await writeFile(join(dir, ".env"), "SECRET=unsupported-oracle\n", "utf8");
    const doctorWithEnv = await runDoctor(dir);
    const validateWithEnv = await runValidate({ cwd: dir });

    expect(doctorWithEnv.issues).toEqual(doctorWithoutEnv.issues);
    expect(validateWithEnv.issues).toEqual(validateWithoutEnv.issues);
    expect(doctorWithEnv.issues.map(i => i.code)).toContain("ADAPTER_UNVERIFIABLE");
    expect(doctorWithEnv.issues.map(i => i.code)).not.toContain("ADAPTER_MISSING");
    expect(JSON.stringify(doctorWithEnv)).not.toContain("unsupported-oracle");
    expect(JSON.stringify(validateWithEnv)).not.toContain("unsupported-oracle");
  });
});

describe("2.2b doctor and validate enforce agent profile namespace ownership", () => {
  async function pointProjectProfileAt(relPath: string): Promise<void> {
    const projectPath = join(dir, ".code-pact", "project.yaml");
    const project = await readFile(projectPath, "utf8");
    await writeFile(
      projectPath,
      project.replace("profile: agent-profiles/claude-code.yaml", `profile: ${relPath}`),
      "utf8",
    );
  }

  it("doctor refuses .code-pact/state as an agent profile and does not leak model_map content", async () => {
    await mkdir(join(dir, ".code-pact", "state"), { recursive: true });
    await writeFile(
      join(dir, ".code-pact", "state", "private-agent-profile.yaml"),
      [
        "name: claude-code",
        "instruction_filename: CLAUDE.md",
        "context_dir: .context/claude-code",
        "skill_dir: .claude/skills",
        "hook_dir: .claude/hooks",
        "model_map:",
        "  highest_reasoning: PRIVATE-DOCTOR-MARKER",
        "",
      ].join("\n"),
      "utf8",
    );
    await pointProjectProfileAt("state/private-agent-profile.yaml");

    const result = await runDoctor(dir);
    expect(result.issues.map(i => i.code)).toContain("SCHEMA_ERROR");
    expect(JSON.stringify(result)).not.toContain("PRIVATE-DOCTOR-MARKER");
  });

  it("validate uses the same profile namespace boundary as doctor", async () => {
    await mkdir(join(dir, ".code-pact", "state"), { recursive: true });
    await writeFile(
      join(dir, ".code-pact", "state", "private-agent-profile.yaml"),
      [
        "name: claude-code",
        "instruction_filename: CLAUDE.md",
        "context_dir: .context/claude-code",
        "model_map:",
        "  highest_reasoning: PRIVATE-VALIDATE-MARKER",
        "",
      ].join("\n"),
      "utf8",
    );
    await pointProjectProfileAt("state/private-agent-profile.yaml");

    const result = await runValidate({ cwd: dir });
    expect(result.issues.map(i => i.code)).toContain("SCHEMA_ERROR");
    expect(JSON.stringify(result)).not.toContain("PRIVATE-VALIDATE-MARKER");
  });
});

describe("2.2c profile identity mismatch cannot reintroduce instruction_filename oracle", () => {
  it("doctor result does not reveal whether .env exists when profile.name is forged", async () => {
    const profilePath = join(
      dir,
      ".code-pact",
      "agent-profiles",
      "claude-code.yaml",
    );
    await writeFile(
      profilePath,
      [
        "name: attacker",
        "instruction_filename: .env",
        "context_dir: .context/attacker",
        "model_map: {}",
        "",
      ].join("\n"),
      "utf8",
    );

    const resultWithoutEnv = await runDoctor(dir);
    await writeFile(join(dir, ".env"), "SECRET=identity-bypass\n", "utf8");
    const resultWithEnv = await runDoctor(dir);

    expect(resultWithoutEnv.issues.map(i => i.code)).toContain(
      "ADAPTER_PROFILE_INVALID",
    );
    expect(resultWithEnv.issues.map(i => i.code)).toContain(
      "ADAPTER_PROFILE_INVALID",
    );
    expect(
      resultWithoutEnv.issues.filter(i => i.code === "ADAPTER_MISSING"),
    ).toEqual([]);
    expect(resultWithEnv.issues.filter(i => i.code === "ADAPTER_MISSING")).toEqual(
      [],
    );
    expect(JSON.stringify(resultWithEnv)).not.toContain("identity-bypass");
  });
});

// ---------------------------------------------------------------------------
// 2.3 hook_dir oracle
// ---------------------------------------------------------------------------

describe("2.3 hook_dir pointing at .env does not stat .env", () => {
  it("install rejects with CONFIG_ERROR without stat'ing .env", async () => {
    const profilePath = join(
      dir,
      ".code-pact",
      "agent-profiles",
      "claude-code.yaml",
    );
    const raw = await readFile(profilePath, "utf8");
    // Add hook_dir: .env to the profile.
    const profile = parseYaml(raw) as Record<string, unknown>;
    profile.hook_dir = ".env";
    await writeFile(profilePath, stringifyYaml(profile), "utf8");

    // Create .env so we can detect if it was stat'd.
    await writeFile(join(dir, ".env"), "SECRET=deadbeef\n", "utf8");

    // Install must reject with CONFIG_ERROR (profile contract violation).
    await expect(
      runAdapterInstall({
        cwd: dir,
        agentName: "claude-code",
        force: false,
        locale: "en-US",
        generatorVersionOverride: "test",
      }),
    ).rejects.toThrow();

    // The .env file must not have been modified or read.
    const envContent = await readFile(join(dir, ".env"), "utf8");
    expect(envContent).toBe("SECRET=deadbeef\n");
  });
});

// ---------------------------------------------------------------------------
// 2.5 model profile directory symlink
// ---------------------------------------------------------------------------

describe("2.5 model profile directory symlink is not silently degraded", () => {
  it("install throws CONFIG_ERROR when model-profiles is an in-project symlink", async () => {
    // Create a private directory with a model profile.
    const privateDir = join(dir, ".local", "private-model-profiles");
    await mkdir(privateDir, { recursive: true });
    await writeFile(
      join(privateDir, "test.yaml"),
      stringifyYaml({
        name: "test",
        model: "claude-sonnet-4-6",
        context_window: 200000,
        max_output_tokens: 8192,
      }),
      "utf8",
    );

    // Replace .code-pact/model-profiles with a symlink.
    await rm(join(dir, ".code-pact", "model-profiles"), {
      recursive: true,
      force: true,
    });
    await symlink(privateDir, join(dir, ".code-pact", "model-profiles"), "dir");

    // Install must throw CONFIG_ERROR, not silently degrade to empty profiles.
    await expect(
      runAdapterInstall({
        cwd: dir,
        agentName: "claude-code",
        force: false,
        locale: "en-US",
        generatorVersionOverride: "test",
      }),
    ).rejects.toMatchObject({
      code: "CONFIG_ERROR",
    });
  });
});
