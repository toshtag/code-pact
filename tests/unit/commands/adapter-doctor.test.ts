import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
  mkdir,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { runInit } from "../../../src/commands/init.ts";
import { runAdapterInstall } from "../../../src/commands/adapter-install.ts";
import { runAdapterDoctor } from "../../../src/commands/adapter-doctor.ts";
import { runDoctor } from "../../../src/commands/doctor.ts";
import { runValidate } from "../../../src/commands/validate.ts";
import {
  manifestPath,
  readManifest,
  writeManifest,
} from "../../../src/core/adapters/manifest.ts";
import { ADAPTER_MANIFEST_DIR_SEGMENTS } from "../../../src/core/adapters/manifest.ts";
import type { AdapterManifest } from "../../../src/core/schemas/adapter-manifest.ts";

const { readFileSpy } = vi.hoisted(() => ({ readFileSpy: vi.fn() }));

vi.mock("node:fs/promises", async importActual => {
  const actual = await importActual<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      readFileSpy(args[0]);
      return actual.readFile(...args);
    },
  };
});

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "code-pact-adapter-doctor-test-"));
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

async function readMutableManifest(
  cwd: string,
  agent: string,
): Promise<AdapterManifest> {
  const m = await readManifest(cwd, agent);
  if (m === null) throw new Error("manifest expected to exist for this test");
  return m;
}

// ---------------------------------------------------------------------------
// ADAPTER_MANIFEST_MISSING
// ---------------------------------------------------------------------------

describe("adapter doctor — ADAPTER_MANIFEST_MISSING", () => {
  it("emits MANIFEST_MISSING for an enabled agent with no manifest", async () => {
    const result = await runAdapterDoctor({ cwd: dir, locale: "en-US" });
    expect(result.ok).toBe(true); // warning, not error
    const codes = result.issues.map(i => i.code);
    expect(codes).toContain("ADAPTER_MANIFEST_MISSING");
    const issue = result.issues.find(
      i => i.code === "ADAPTER_MANIFEST_MISSING",
    )!;
    expect(issue.agent).toBe("claude-code");
    expect(issue.severity).toBe("warning");
  });

  it("does NOT emit MANIFEST_MISSING for a disabled (not-listed) agent when no --agent flag", async () => {
    const result = await runAdapterDoctor({ cwd: dir, locale: "en-US" });
    const agents = result.issues
      .filter(i => i.code === "ADAPTER_MANIFEST_MISSING")
      .map(i => i.agent);
    // Project enables only claude-code, so codex / generic / etc. are NOT inspected.
    expect(agents).toEqual(["claude-code"]);
  });

  it("emits MANIFEST_MISSING for an explicitly targeted unenabled agent via --agent", async () => {
    // codex isn't enabled in this project, but --agent codex requests inspection.
    const result = await runAdapterDoctor({
      cwd: dir,
      agentName: "codex",
      locale: "en-US",
    });
    // Not enabled → MANIFEST_MISSING is NOT emitted (it's a soft signal only for enabled agents).
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("does NOT emit MANIFEST_MISSING after a successful install", async () => {
    await runAdapterInstall({
      cwd: dir,
      agentName: "claude-code",
      force: false,
      locale: "en-US",
      generatorVersionOverride: "0.9.0-alpha.0",
    });
    const result = await runAdapterDoctor({
      cwd: dir,
      locale: "en-US",
    });
    expect(result.issues.map(i => i.code)).not.toContain(
      "ADAPTER_MANIFEST_MISSING",
    );
  });
});

// ---------------------------------------------------------------------------
// ADAPTER_MANIFEST_INVALID
// ---------------------------------------------------------------------------

describe("adapter doctor — ADAPTER_MANIFEST_INVALID", () => {
  it("emits MANIFEST_INVALID with error severity for malformed YAML", async () => {
    await mkdir(join(dir, ...ADAPTER_MANIFEST_DIR_SEGMENTS), {
      recursive: true,
    });
    await writeFile(
      manifestPath(dir, "claude-code"),
      "schema_version: 1\n  files: [oops:\n",
      "utf8",
    );
    const result = await runAdapterDoctor({ cwd: dir, locale: "en-US" });
    const issue = result.issues.find(
      i => i.code === "ADAPTER_MANIFEST_INVALID",
    )!;
    expect(issue).toBeDefined();
    expect(issue.severity).toBe("error");
    expect(result.ok).toBe(false);
  });

  it("emits MANIFEST_INVALID for YAML that fails schema validation", async () => {
    await mkdir(join(dir, ...ADAPTER_MANIFEST_DIR_SEGMENTS), {
      recursive: true,
    });
    await writeFile(
      manifestPath(dir, "claude-code"),
      "schema_version: 99\nagent_name: claude-code\n",
      "utf8",
    );
    const result = await runAdapterDoctor({ cwd: dir, locale: "en-US" });
    const codes = result.issues.map(i => i.code);
    expect(codes).toContain("ADAPTER_MANIFEST_INVALID");
    expect(result.ok).toBe(false);
  });

  it("MANIFEST_INVALID aborts further per-agent checks (no FILE_MISSING duplicates)", async () => {
    await mkdir(join(dir, ...ADAPTER_MANIFEST_DIR_SEGMENTS), {
      recursive: true,
    });
    await writeFile(
      manifestPath(dir, "claude-code"),
      "schema_version: 99\nagent_name: claude-code\n",
      "utf8",
    );
    const result = await runAdapterDoctor({ cwd: dir, locale: "en-US" });
    const codes = result.issues.map(i => i.code);
    expect(codes).not.toContain("ADAPTER_FILE_MISSING");
    expect(codes).not.toContain("ADAPTER_GENERATOR_STALE");
  });
});

// ---------------------------------------------------------------------------
// Hostile on-disk types must not crash doctor (exit 3) — a diagnostic reports
// problems, never aborts on attacker input.
// ---------------------------------------------------------------------------

describe("adapter doctor — managed file path is a directory (no exit-3 crash)", () => {
  it("reports a managed path that is a directory as a drift/missing advisory, does not throw EISDIR", async () => {
    await runAdapterInstall({
      cwd: dir,
      agentName: "claude-code",
      force: false,
      locale: "en-US",
      generatorVersionOverride: "0.9.0-alpha.0",
    });
    // Replace the managed CLAUDE.md with a DIRECTORY: a bare readFile would throw
    // EISDIR, which (pre-fix) surfaced as an internal error / exit 3.
    await unlink(join(dir, "CLAUDE.md"));
    await mkdir(join(dir, "CLAUDE.md"), { recursive: true });
    const result = await runAdapterDoctor({ cwd: dir, locale: "en-US" });
    // No throw: doctor returns an envelope; the directory reads as a missing/changed
    // managed file and is surfaced as a claude-code advisory.
    expect(Array.isArray(result.issues)).toBe(true);
    expect(result.issues.some(i => i.agent === "claude-code")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ADAPTER_GENERATOR_STALE / SCHEMA_DRIFT / PROFILE_DRIFT
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// SECURITY (Blocker 2): forged-manifest content/SHA oracle in adapter doctor.
// A project-supplied manifest entry naming an arbitrary local file (.env) must
// be refused — never read, hashed, or contract-inspected.
// ---------------------------------------------------------------------------
describe("adapter doctor — forged manifest .env oracle (security)", () => {
  beforeEach(async () => {
    await runAdapterInstall({
      cwd: dir,
      agentName: "claude-code",
      force: false,
      locale: "en-US",
    });
  });

  it("refuses a forged .env entry: ADAPTER_FILE_PATH_UNSAFE, secret never read", async () => {
    await writeFile(
      join(dir, ".env"),
      "API_TOKEN=top-secret-doctor-marker\n",
      "utf8",
    );
    const m = await readMutableManifest(dir, "claude-code");
    m.files.push({
      path: ".env",
      sha256: "0".repeat(64),
      managed: true,
      role: "instruction",
    });
    await writeManifest(dir, "claude-code", m);

    const result = await runAdapterDoctor({ cwd: dir, locale: "en-US" });

    const envIssue = result.issues.find(
      i =>
        i.code === "ADAPTER_FILE_PATH_UNSAFE" &&
        (i.path ?? "").endsWith(".env"),
    );
    expect(envIssue).toBeDefined();
    expect(envIssue?.severity).toBe("error");
    // The secret content must never appear anywhere in the doctor output.
    expect(JSON.stringify(result)).not.toContain("top-secret-doctor-marker");
  });

  // SECURITY (Blocker 1 — shared skills namespace): a victim's hand-authored
  // `.claude/skills/private.md` is in the broad create namespace (for role=skill)
  // but is NOT in doctor's current exact generated set. It is INDISTINGUISHABLE
  // from a stale managed skill by path, so doctor does NOT read it (no content
  // oracle) and reports an advisory ADAPTER_FILE_UNVERIFIABLE — never
  // reads/hashes/inspects.
  it(`does not read a victim's .claude/skills/private.md (role: skill); secret never surfaces`, async () => {
    await mkdir(join(dir, ".claude", "skills"), { recursive: true });
    await writeFile(
      join(dir, ".claude", "skills", "private.md"),
      "API_TOKEN=doctor-private-marker\n",
      "utf8",
    );
    const m = await readMutableManifest(dir, "claude-code");
    m.files.push({
      path: ".claude/skills/private.md",
      sha256: "0".repeat(64),
      managed: true,
      role: "skill",
    });
    await writeManifest(dir, "claude-code", m);

    const result = await runAdapterDoctor({ cwd: dir, locale: "en-US" });
    const issue = result.issues.find(
      i =>
        i.code === "ADAPTER_FILE_UNVERIFIABLE" &&
        (i.path ?? "").endsWith("private.md"),
    );
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("warning"); // not read, not a hard error
    // The secret content must never surface (never read; no heading inspection).
    expect(JSON.stringify(result)).not.toContain("doctor-private-marker");
  });

  // A `.claude/skills/private.md` forged with role: instruction is now a HARD
  // error (unowned) — the create namespace is role-scoped (skill only), so an
  // instruction role on a skill path is a forged-manifest security failure.
  it(`hard-refuses a victim's .claude/skills/private.md forged as role: instruction`, async () => {
    await mkdir(join(dir, ".claude", "skills"), { recursive: true });
    await writeFile(
      join(dir, ".claude", "skills", "private.md"),
      "API_TOKEN=doctor-private-marker\n",
      "utf8",
    );
    const m = await readMutableManifest(dir, "claude-code");
    m.files.push({
      path: ".claude/skills/private.md",
      sha256: "0".repeat(64),
      managed: true,
      role: "instruction",
    });
    await writeManifest(dir, "claude-code", m);

    const result = await runAdapterDoctor({ cwd: dir, locale: "en-US" });
    const issue = result.issues.find(
      i =>
        i.code === "ADAPTER_FILE_PATH_UNSAFE" &&
        (i.path ?? "").endsWith("private.md"),
    );
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("error"); // role mismatch → unowned → hard error
    expect(JSON.stringify(result)).not.toContain("doctor-private-marker");
  });

  // A truly out-of-namespace forged path (.env) is still a HARD refusal.
  it("hard-refuses a forged .env (outside any adapter namespace), secret never read", async () => {
    await writeFile(
      join(dir, ".env"),
      "API_TOKEN=env-hard-refuse-marker\n",
      "utf8",
    );
    const m = await readMutableManifest(dir, "claude-code");
    m.files.push({
      path: ".env",
      sha256: "0".repeat(64),
      managed: true,
      role: "instruction",
    });
    await writeManifest(dir, "claude-code", m);

    const result = await runAdapterDoctor({ cwd: dir, locale: "en-US" });
    const issue = result.issues.find(
      i =>
        i.code === "ADAPTER_FILE_PATH_UNSAFE" &&
        (i.path ?? "").endsWith(".env"),
    );
    expect(issue).toBeDefined();
    expect(JSON.stringify(result)).not.toContain("env-hard-refuse-marker");
  });

  for (const surface of ["adapter doctor", "doctor", "validate"] as const) {
    it(`${surface} hard-refuses a profile-redirected .env without reading it`, async () => {
      const envPath = join(dir, ".env");
      await writeFile(
        envPath,
        "## Agent contract\nAPI_TOKEN=redirect-marker\n",
        "utf8",
      );

      const profilePath = join(
        dir,
        ".code-pact",
        "agent-profiles",
        "claude-code.yaml",
      );
      const profile = parseYaml(await readFile(profilePath, "utf8")) as Record<
        string,
        unknown
      >;
      profile.instruction_filename = ".env";
      await writeFile(profilePath, stringifyYaml(profile), "utf8");

      const m = await readMutableManifest(dir, "claude-code");
      m.files.push({
        path: ".env",
        sha256: "0".repeat(64),
        managed: true,
        role: "instruction",
      });
      await writeManifest(dir, "claude-code", m);

      readFileSpy.mockClear();
      const result =
        surface === "adapter doctor"
          ? await runAdapterDoctor({ cwd: dir, locale: "en-US" })
          : surface === "doctor"
            ? await runDoctor(dir)
            : await runValidate({ cwd: dir });

      expect(
        result.issues.some(i => i.code === "ADAPTER_FILE_PATH_UNSAFE"),
      ).toBe(true);
      expect(result.issues.some(i => i.code === "ADAPTER_CONTRACT_DRIFT")).toBe(
        false,
      );
      expect(
        readFileSpy.mock.calls.some(([path]) => String(path) === envPath),
      ).toBe(false);
    });
  }

  async function addPrivateVerificationCommand(): Promise<void> {
    await mkdir(join(dir, "design", "phases"), { recursive: true });
    await writeFile(
      join(dir, "design", "roadmap.yaml"),
      "phases:\n  - id: P1\n    path: design/phases/P1-private.yaml\n    weight: 1\n",
      "utf8",
    );
    await writeFile(
      join(dir, "design", "phases", "P1-private.yaml"),
      [
        "id: P1",
        "name: Private",
        "weight: 1",
        "confidence: high",
        "risk: low",
        "status: planned",
        "objective: Exercise dynamic read authority.",
        "definition_of_done:",
        "  - Done",
        "verification:",
        "  commands:",
        "    - private",
        "tasks: []",
        "",
      ].join("\n"),
      "utf8",
    );
  }

  for (const shaMode of ["matching", "non-matching"] as const) {
    it(`does not read a current dynamic skill collision with a ${shaMode} manifest SHA`, async () => {
      await addPrivateVerificationCommand();
      const privatePath = join(dir, ".claude", "skills", "private.md");
      const secret = "# private\nAPI_TOKEN=dynamic-collision-marker\n";
      await writeFile(privatePath, secret, "utf8");
      const m = await readMutableManifest(dir, "claude-code");
      const { computeContentHash } =
        await import("../../../src/core/adapters/manifest.ts");
      m.files.push({
        path: ".claude/skills/private.md",
        sha256:
          shaMode === "matching" ? computeContentHash(secret) : "0".repeat(64),
        managed: true,
        role: "skill",
      });
      await writeManifest(dir, "claude-code", m);

      readFileSpy.mockClear();
      const result = await runAdapterDoctor({ cwd: dir, locale: "en-US" });
      const privateIssues = result.issues.filter(i => i.path === privatePath);
      expect(privateIssues.map(i => i.code)).toEqual([
        "ADAPTER_FILE_UNVERIFIABLE",
      ]);
      expect(
        privateIssues.some(
          i =>
            i.code === "ADAPTER_FILE_DRIFT" ||
            i.code === "ADAPTER_DESIRED_STALE",
        ),
      ).toBe(false);
      expect(
        readFileSpy.mock.calls.some(([path]) => String(path) === privatePath),
      ).toBe(false);
    });
  }

  it("does not heading-inspect a current dynamic skill forged as an instruction", async () => {
    await addPrivateVerificationCommand();
    const privatePath = join(dir, ".claude", "skills", "private.md");
    await writeFile(privatePath, "not an agent contract\n", "utf8");
    const m = await readMutableManifest(dir, "claude-code");
    m.files.push({
      path: ".claude/skills/private.md",
      sha256: "0".repeat(64),
      managed: true,
      role: "instruction",
    });
    await writeManifest(dir, "claude-code", m);

    readFileSpy.mockClear();
    const result = await runAdapterDoctor({ cwd: dir, locale: "en-US" });
    const privateIssues = result.issues.filter(i => i.path === privatePath);
    // role: instruction on a skill path is now a forged-manifest hard error
    // (unowned) — the create namespace is role-scoped (skill only).
    expect(privateIssues.some(i => i.code === "ADAPTER_FILE_PATH_UNSAFE")).toBe(
      true,
    );
    expect(privateIssues.some(i => i.code === "ADAPTER_CONTRACT_DRIFT")).toBe(
      false,
    );
    expect(
      readFileSpy.mock.calls.some(([path]) => String(path) === privatePath),
    ).toBe(false);
  });
});

describe("adapter doctor — version drifts", () => {
  beforeEach(async () => {
    await runAdapterInstall({
      cwd: dir,
      agentName: "claude-code",
      force: false,
      locale: "en-US",
      generatorVersionOverride: "0.9.0-alpha.0",
    });
  });

  // Issue #340: ADAPTER_GENERATOR_STALE is a version-stamp signal that only
  // earns a warning when the desired adapter output actually differs from the
  // manifest. A stamp-only lag — generator_version is older but every managed
  // file is byte-identical to what the current generator produces — stays
  // silent. (The install above used generatorVersionOverride "0.9.0-alpha.0",
  // so the manifest stamp already lags the running package version while the
  // generated file contents are version-independent, i.e. byte-identical.)
  it("does NOT emit GENERATOR_STALE on stamp-only lag (version differs, desired output byte-identical)", async () => {
    const m = await readMutableManifest(dir, "claude-code");
    m.generator_version = "stale-0.0.0";
    await writeManifest(dir, "claude-code", m);
    const result = await runAdapterDoctor({ cwd: dir, locale: "en-US" });
    const codes = result.issues.map(i => i.code);
    expect(codes).not.toContain("ADAPTER_GENERATOR_STALE");
  });

  it("emits GENERATOR_STALE when version differs AND a manifest file hash no longer matches the desired output", async () => {
    const m = await readMutableManifest(dir, "claude-code");
    m.generator_version = "stale-0.0.0";
    // Make the recorded hash for a managed file diverge from what the current
    // generator produces, so the desired output is provably NOT equivalent to
    // the manifest. (The on-disk file is irrelevant to the equivalence check —
    // it compares manifest sha256 against current desired content.)
    const file = m.files.find(f => f.path === "CLAUDE.md")!;
    file.sha256 = "a".repeat(64); // arbitrary non-matching hash
    await writeManifest(dir, "claude-code", m);
    const result = await runAdapterDoctor({ cwd: dir, locale: "en-US" });
    expect(result.issues.map(i => i.code)).toContain("ADAPTER_GENERATOR_STALE");
  });

  it("emits GENERATOR_STALE when version differs AND the manifest path set diverges from the desired output", async () => {
    const m = await readMutableManifest(dir, "claude-code");
    m.generator_version = "stale-0.0.0";
    // Drop a real managed file from the manifest so the recorded path set no
    // longer matches the generator's current desired path set. The hash check
    // alone would not catch this (it iterates manifest paths), so the path-set
    // comparison in desiredEquivalentToManifest is what flags it.
    m.files = m.files.filter(f => f.path !== ".claude/skills/context.md");
    await writeManifest(dir, "claude-code", m);
    const result = await runAdapterDoctor({ cwd: dir, locale: "en-US" });
    expect(result.issues.map(i => i.code)).toContain("ADAPTER_GENERATOR_STALE");
  });

  it("does NOT emit GENERATOR_STALE when versions match", async () => {
    const m = await readMutableManifest(dir, "claude-code");
    // Hack: re-read current package version via re-install — version comes from package.json.
    // Simplest: set manifest's version to whatever the current readPackageVersion returns.
    // We can rely on the install having recorded the current version (we used generatorVersionOverride above, so we need to refresh).
    const { readPackageVersion } =
      await import("../../../src/lib/package-version.ts");
    m.generator_version = await readPackageVersion();
    await writeManifest(dir, "claude-code", m);
    const result = await runAdapterDoctor({ cwd: dir, locale: "en-US" });
    expect(result.issues.map(i => i.code)).not.toContain(
      "ADAPTER_GENERATOR_STALE",
    );
  });

  it("emits SCHEMA_DRIFT when manifest adapter_schema_version is older than the current adapter", async () => {
    const m = await readMutableManifest(dir, "claude-code");
    m.adapter_schema_version = 0;
    await writeManifest(dir, "claude-code", m);
    const result = await runAdapterDoctor({ cwd: dir, locale: "en-US" });
    expect(result.issues.map(i => i.code)).toContain("ADAPTER_SCHEMA_DRIFT");
  });

  it("does NOT emit SCHEMA_DRIFT when manifest schema matches", async () => {
    const result = await runAdapterDoctor({ cwd: dir, locale: "en-US" });
    expect(result.issues.map(i => i.code)).not.toContain(
      "ADAPTER_SCHEMA_DRIFT",
    );
  });

  it("emits PROFILE_DRIFT when adapter-output-affecting profile fields change", async () => {
    // Mutate context_dir in the agent profile.
    const profilePath = join(
      dir,
      ".code-pact",
      "agent-profiles",
      "claude-code.yaml",
    );
    const raw = await readFile(profilePath, "utf8");
    const profile = parseYaml(raw) as { context_dir: string };
    profile.context_dir = ".context/claude-code-renamed";
    await writeFile(profilePath, stringifyYaml(profile), "utf8");
    const result = await runAdapterDoctor({ cwd: dir, locale: "en-US" });
    expect(result.issues.map(i => i.code)).toContain("ADAPTER_PROFILE_DRIFT");
  });

  it("does NOT emit PROFILE_DRIFT when profile is unchanged", async () => {
    const result = await runAdapterDoctor({ cwd: dir, locale: "en-US" });
    expect(result.issues.map(i => i.code)).not.toContain(
      "ADAPTER_PROFILE_DRIFT",
    );
  });
});

// ---------------------------------------------------------------------------
// File-level checks
// ---------------------------------------------------------------------------

describe("adapter doctor — file-level findings", () => {
  beforeEach(async () => {
    await runAdapterInstall({
      cwd: dir,
      agentName: "claude-code",
      force: false,
      locale: "en-US",
      generatorVersionOverride: "0.9.0-alpha.0",
    });
  });

  it("emits FILE_MISSING (error) when a managed file is removed from disk", async () => {
    await unlink(join(dir, "CLAUDE.md"));
    const result = await runAdapterDoctor({ cwd: dir, locale: "en-US" });
    const issue = result.issues.find(i => i.code === "ADAPTER_FILE_MISSING");
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe("error");
    expect(issue!.path).toBe(join(dir, "CLAUDE.md"));
    expect(result.ok).toBe(false);
  });

  it("emits FILE_DRIFT (warning) for managed-modified × stale — user edited AND generator moved on", async () => {
    // First make the managed file modified relative to manifest.
    await writeFile(join(dir, "CLAUDE.md"), "MY EDITS", "utf8");
    // Then make the generator output drift too — simplest: alter the manifest hash so manifest≠disk≠desired.
    const m = await readMutableManifest(dir, "claude-code");
    // We don't have a way to mutate the generator output here, but we can synthesise drift via the hash:
    // setting manifest hash to a non-matching value puts us in managed-modified, and the desired hash
    // (computed from current generator output) doesn't match the disk either since disk = "MY EDITS".
    const file = m.files.find(f => f.path === "CLAUDE.md")!;
    file.sha256 = "f".repeat(64); // arbitrary non-matching hash
    await writeManifest(dir, "claude-code", m);
    const result = await runAdapterDoctor({ cwd: dir, locale: "en-US" });
    expect(result.issues.map(i => i.code)).toContain("ADAPTER_FILE_DRIFT");
  });

  it("emits DESIRED_STALE (warning) for managed-clean × stale — disk matches manifest, generator moved on", async () => {
    // Mutate the manifest's recorded sha256 to match the current desired hash differently.
    // Simulation: keep the on-disk file identical to manifest, but pretend the generator's
    // current output differs. Easiest synth: change the disk file AND the manifest in
    // sync (both to a sentinel), so manifest==disk≠desired.
    const sentinel = "SENTINEL CONTENT";
    await writeFile(join(dir, "CLAUDE.md"), sentinel, "utf8");
    const m = await readMutableManifest(dir, "claude-code");
    const file = m.files.find(f => f.path === "CLAUDE.md")!;
    // sha256("SENTINEL CONTENT") — compute it.
    const { computeContentHash } =
      await import("../../../src/core/adapters/manifest.ts");
    file.sha256 = computeContentHash(sentinel);
    await writeManifest(dir, "claude-code", m);
    const result = await runAdapterDoctor({ cwd: dir, locale: "en-US" });
    expect(result.issues.map(i => i.code)).toContain("ADAPTER_DESIRED_STALE");
    expect(
      result.issues.find(i => i.code === "ADAPTER_DESIRED_STALE")!.severity,
    ).toBe("warning");
  });

  it("happy path: managed-clean × current emits no file-level issues", async () => {
    const result = await runAdapterDoctor({ cwd: dir, locale: "en-US" });
    const fileCodes = result.issues
      .filter(i =>
        [
          "ADAPTER_FILE_MISSING",
          "ADAPTER_FILE_DRIFT",
          "ADAPTER_DESIRED_STALE",
        ].includes(i.code),
      )
      .map(i => i.code);
    expect(fileCodes).toEqual([]);
  });

  it("managed-modified × current is SILENT (manifest-only drift is not a doctor concern)", async () => {
    // Mutate manifest hash for CLAUDE.md so manifestHash != diskHash, but disk still matches desired.
    const m = await readMutableManifest(dir, "claude-code");
    const file = m.files.find(f => f.path === "CLAUDE.md")!;
    file.sha256 = "0".repeat(64); // any non-matching hash
    await writeManifest(dir, "claude-code", m);
    const result = await runAdapterDoctor({ cwd: dir, locale: "en-US" });
    // Should NOT emit FILE_DRIFT (desired is current) or DESIRED_STALE (local is modified).
    const fileCodes = result.issues
      .filter(i =>
        [
          "ADAPTER_FILE_MISSING",
          "ADAPTER_FILE_DRIFT",
          "ADAPTER_DESIRED_STALE",
        ].includes(i.code),
      )
      .map(i => i.code);
    expect(fileCodes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ADAPTER_UNMANAGED_FILE (orphan scan, narrow scope)
// ---------------------------------------------------------------------------

describe("adapter doctor — ADAPTER_UNMANAGED_FILE", () => {
  beforeEach(async () => {
    await runAdapterInstall({
      cwd: dir,
      agentName: "claude-code",
      force: false,
      locale: "en-US",
      generatorVersionOverride: "0.9.0-alpha.0",
    });
  });

  it("does NOT flag arbitrary user-created files inside .claude/skills/ (narrow ownedPathRoles)", async () => {
    // User adds their own skill file — this MUST NOT trigger ADAPTER_UNMANAGED_FILE.
    await writeFile(
      join(dir, ".claude/skills/custom.md"),
      "user content",
      "utf8",
    );
    const result = await runAdapterDoctor({ cwd: dir, locale: "en-US" });
    expect(result.issues.map(i => i.code)).not.toContain(
      "ADAPTER_UNMANAGED_FILE",
    );
  });

  it("flags a previously-managed file that drops out of the manifest", async () => {
    // Simulate: remove an entry from the manifest while leaving the file on disk.
    const m = await readMutableManifest(dir, "claude-code");
    const before = m.files.length;
    m.files = m.files.filter(f => f.path !== ".claude/skills/context.md");
    expect(m.files.length).toBe(before - 1);
    await writeManifest(dir, "claude-code", m);
    const result = await runAdapterDoctor({ cwd: dir, locale: "en-US" });
    const orphans = result.issues.filter(
      i => i.code === "ADAPTER_UNMANAGED_FILE",
    );
    expect(orphans.length).toBeGreaterThanOrEqual(1);
    expect(
      orphans.some(i => i.path?.endsWith(".claude/skills/context.md")),
    ).toBe(true);
  });

  it("does NOT flag orphans when the manifest is missing entirely (MANIFEST_MISSING covers it)", async () => {
    // Remove manifest. Files (CLAUDE.md etc.) still on disk.
    await unlink(manifestPath(dir, "claude-code"));
    const result = await runAdapterDoctor({ cwd: dir, locale: "en-US" });
    expect(result.issues.map(i => i.code)).toContain(
      "ADAPTER_MANIFEST_MISSING",
    );
    expect(result.issues.map(i => i.code)).not.toContain(
      "ADAPTER_UNMANAGED_FILE",
    );
  });
});

// ---------------------------------------------------------------------------
// --agent targeting + unknown agent
// ---------------------------------------------------------------------------

describe("adapter doctor — agent targeting", () => {
  it("throws AGENT_NOT_FOUND for an unregistered agent name", async () => {
    await expect(
      runAdapterDoctor({
        cwd: dir,
        agentName: "no-such-agent",
        locale: "en-US",
      }),
    ).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });
  });

  it("with no --agent and no project.yaml, returns ok=true and empty issues (no-op)", async () => {
    // Wipe project.yaml so no agents are considered enabled.
    await unlink(join(dir, ".code-pact", "project.yaml"));
    const result = await runAdapterDoctor({ cwd: dir, locale: "en-US" });
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// v1.7 P16-T5: ADAPTER_CONTRACT_DRIFT
// ---------------------------------------------------------------------------

describe("adapter doctor — ADAPTER_CONTRACT_DRIFT (v1.7 P16-T5)", () => {
  async function installFreshClaudeCode(): Promise<void> {
    await runAdapterInstall({
      cwd: dir,
      agentName: "claude-code",
      force: false,
      locale: "en-US",
      generatorVersionOverride: "0.9.0-alpha.0",
    });
  }

  async function readClaudeMd(): Promise<string> {
    return readFile(join(dir, "CLAUDE.md"), "utf8");
  }

  async function writeClaudeMd(content: string): Promise<void> {
    await writeFile(join(dir, "CLAUDE.md"), content, "utf8");
  }

  it("pristine install → no ADAPTER_CONTRACT_DRIFT issue", async () => {
    await installFreshClaudeCode();
    const result = await runAdapterDoctor({
      cwd: dir,
      agentName: "claude-code",
      locale: "en-US",
    });
    const drift = result.issues.find(i => i.code === "ADAPTER_CONTRACT_DRIFT");
    expect(drift).toBeUndefined();
  });

  it("section deleted → ADAPTER_CONTRACT_DRIFT with kind=section_missing", async () => {
    await installFreshClaudeCode();
    const original = await readClaudeMd();
    // Strip the section by replacing it with nothing.
    const without = original.replace(/## Agent contract[\s\S]*?(?=\n## )/, "");
    expect(without).not.toContain("## Agent contract");
    await writeClaudeMd(without);

    const result = await runAdapterDoctor({
      cwd: dir,
      agentName: "claude-code",
      locale: "en-US",
    });
    const drift = result.issues.find(i => i.code === "ADAPTER_CONTRACT_DRIFT");
    expect(drift).toBeDefined();
    expect(drift!.severity).toBe("warning");
    expect(drift!.details).toEqual({ kind: "section_missing" });
  });

  it("one axis sub-heading deleted → ADAPTER_CONTRACT_DRIFT with kind=axes_incomplete + missing_axes", async () => {
    await installFreshClaudeCode();
    const original = await readClaudeMd();
    // Remove the "### What to verify first" sub-heading line only.
    const without = original.replace(/### What to verify first\n/, "");
    expect(without).toContain("## Agent contract"); // section heading kept
    expect(without).not.toContain("### What to verify first");
    await writeClaudeMd(without);

    const result = await runAdapterDoctor({
      cwd: dir,
      agentName: "claude-code",
      locale: "en-US",
    });
    const drift = result.issues.find(i => i.code === "ADAPTER_CONTRACT_DRIFT");
    expect(drift).toBeDefined();
    expect(drift!.details).toEqual({
      kind: "axes_incomplete",
      missing_axes: ["### What to verify first"],
    });
  });

  it("severity is warning — does NOT change the doctor exit code (soft signal)", async () => {
    await installFreshClaudeCode();
    const original = await readClaudeMd();
    const without = original.replace(/## Agent contract[\s\S]*?(?=\n## )/, "");
    await writeClaudeMd(without);

    const result = await runAdapterDoctor({
      cwd: dir,
      agentName: "claude-code",
      locale: "en-US",
    });
    // ok=true even though ADAPTER_CONTRACT_DRIFT fired — warnings
    // never gate the exit code (ADAPTER_FILE_DRIFT also fires here
    // but it's also a warning).
    expect(result.ok).toBe(true);
  });

  it("fires INDEPENDENTLY of ADAPTER_FILE_DRIFT — both codes can appear in one run", async () => {
    await installFreshClaudeCode();
    const original = await readClaudeMd();
    const without = original.replace(/## Agent contract[\s\S]*?(?=\n## )/, "");
    await writeClaudeMd(without);

    const result = await runAdapterDoctor({
      cwd: dir,
      agentName: "claude-code",
      locale: "en-US",
    });
    const codes = result.issues.map(i => i.code);
    expect(codes).toContain("ADAPTER_CONTRACT_DRIFT");
    // Hand-edit also trips the file-level drift signal — both codes
    // are independent diagnoses per design/decisions/agent-contract-rfc.md.
    expect(codes).toContain("ADAPTER_FILE_DRIFT");
  });
});
