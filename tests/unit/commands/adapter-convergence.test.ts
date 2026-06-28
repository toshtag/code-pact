// PR1 (P0 trust hotfix) regressions for adapter convergence + --model pin.
//
// These lock the two failure modes dogfooding surfaced in v1.19.0:
//   1. A verification command whose derived skill name collides with a
//      built-in skill (context/verify/progress) used to clobber the built-in.
//      The derived skill must be deterministically uniquified. Because dynamic
//      names do not grant read authority, later mutation runs report the
//      existing dynamic file as unverifiable until a reserved namespace exists.
//   2. `--model` was a no-op (fingerprint only) while doctor told users to run
//      it to pin a model. It must now persist `model_version` to the profile.
//
// Plus the manifest-repair path: a legacy manifest with duplicate file paths
// (e.g. from a pre-fix generator) must be REPAIRED by `upgrade --write`, not
// abort it — and `upgrade --check` / `doctor` must report rather than crash.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { runInit, runInitCore } from "../../../src/commands/init.ts";
import { runAdapterInstall } from "../../../src/commands/adapter-install.ts";
import { runAdapterUpgrade } from "../../../src/commands/adapter-upgrade.ts";
import { runAdapterDoctor } from "../../../src/commands/adapter-doctor.ts";
import { runDoctor } from "../../../src/commands/doctor.ts";
import {
  readManifest,
  manifestPath,
} from "../../../src/core/adapters/manifest.ts";
import { AgentProfile } from "../../../src/core/schemas/agent-profile.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "code-pact-adapter-convergence-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function profilePath(): string {
  return join(dir, ".code-pact", "agent-profiles", "claude-code.yaml");
}

async function readProfile(): Promise<AgentProfile> {
  return AgentProfile.parse(parseYaml(await readFile(profilePath(), "utf8")));
}

// ---------------------------------------------------------------------------
// Built-in skill name collision → deterministic uniquification + convergence
// ---------------------------------------------------------------------------

describe("adapter convergence — verification-command skill collides with a built-in", () => {
  beforeEach(async () => {
    // `pnpm verify` derives the skill name "verify", which collides with the
    // built-in verify.md. (A command like `code-pact verify --phase P1 --task
    // P1-T1` derives "p1-t1" instead — last non-flag token — so we use the
    // package-manager form that actually triggers the collision.)
    await runInitCore({
      cwd: dir,
      locale: "en-US",
      agents: ["claude-code"],
      force: false,
      json: false,
      createSamplePhase: true,
      verifyCommand: "pnpm verify",
    });
  });

  it("keeps the built-in verify.md and emits the derived skill as verify-2.md", async () => {
    await runAdapterInstall({
      cwd: dir,
      agentName: "claude-code",
      force: false,
      locale: "en-US",
    });

    const builtin = await readFile(
      join(dir, ".claude", "skills", "verify.md"),
      "utf8",
    );
    expect(builtin).toContain("Verify task completion criteria"); // built-in SKILL_VERIFY

    const derived = await readFile(
      join(dir, ".claude", "skills", "verify-2.md"),
      "utf8",
    );
    // Final uniquified name is used in BOTH the path and the rendered body.
    expect(derived).toContain("/verify-2");
    expect(derived).toContain("pnpm verify");
    expect(derived).not.toContain("/verify\n"); // not the un-suffixed title
  });

  it("manifest records unique paths (no duplicate verify.md)", async () => {
    await runAdapterInstall({
      cwd: dir,
      agentName: "claude-code",
      force: false,
      locale: "en-US",
    });
    const manifest = await readManifest(dir, "claude-code"); // strict read must not throw
    expect(manifest).not.toBeNull();
    const paths = manifest!.files.map(f => f.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toContain(".claude/skills/verify.md");
    expect(paths).toContain(".claude/skills/verify-2.md");
  });

  it("install → later mutation runs preserve the existing dynamic skill with a warning (no read/hash)", async () => {
    await runAdapterInstall({
      cwd: dir,
      agentName: "claude-code",
      force: false,
      locale: "en-US",
    });

    const check1 = await runAdapterUpgrade({
      cwd: dir,
      agentName: "claude-code",
      mode: "check",
      force: false,
      acceptModified: false,
      locale: "en-US",
    });
    expect(check1.clean).toBe(false);
    expect(
      check1.plan.find(p => p.relPath.endsWith("verify-2.md")),
    ).toMatchObject({
      local: "unverifiable",
      desired: "unverifiable",
      action: "warn",
      reason: "dynamic_file_unverifiable",
    });

    const write = await runAdapterUpgrade({
      cwd: dir,
      agentName: "claude-code",
      mode: "write",
      force: false,
      acceptModified: false,
      locale: "en-US",
    });
    expect(
      write.plan.find(p => p.relPath.endsWith("verify-2.md"))?.action,
    ).toBe("warn");

    const check2 = await runAdapterUpgrade({
      cwd: dir,
      agentName: "claude-code",
      mode: "check",
      force: false,
      acceptModified: false,
      locale: "en-US",
    });
    expect(check2.plan.find(p => p.relPath.endsWith("verify-2.md"))).toEqual(
      check1.plan.find(p => p.relPath.endsWith("verify-2.md")),
    );

    const doctor = await runAdapterDoctor({ cwd: dir, locale: "en-US" });
    const codes = doctor.issues.map(i => i.code);
    expect(codes).not.toContain("ADAPTER_DESIRED_STALE");
    expect(codes).not.toContain("ADAPTER_FILE_DRIFT");
  });
});

// ---------------------------------------------------------------------------
// Legacy duplicate-path manifest repair (also covers generator-version skew)
// ---------------------------------------------------------------------------

describe("adapter convergence — legacy duplicate-path manifest repair", () => {
  beforeEach(async () => {
    await runInit({
      cwd: dir,
      locale: "en-US",
      agents: ["claude-code"],
      force: false,
      json: false,
    });
    await runAdapterInstall({
      cwd: dir,
      agentName: "claude-code",
      force: false,
      locale: "en-US",
    });
  });

  it("upgrade --write repairs a duplicate-path manifest from an older generator without crashing", async () => {
    // Forge a pre-fix manifest: an older generator_version AND a duplicated
    // file entry. Written raw (writeManifest would reject duplicates).
    const current = await readManifest(dir, "claude-code");
    expect(current).not.toBeNull();
    const corrupt = {
      ...current!,
      generator_version: "1.0.0",
      files: [...current!.files, current!.files[0]], // duplicate the first path
    };
    await writeFile(
      manifestPath(dir, "claude-code"),
      stringifyYaml(corrupt),
      "utf8",
    );

    // Strict read rejects the duplicate; the lenient repair read tolerates it.
    await expect(readManifest(dir, "claude-code")).rejects.toThrow();
    await expect(
      readManifest(dir, "claude-code", { tolerantDuplicatePaths: true }),
    ).resolves.not.toBeNull();

    // The repair: upgrade --write must converge, not abort.
    await expect(
      runAdapterUpgrade({
        cwd: dir,
        agentName: "claude-code",
        mode: "write",
        force: false,
        acceptModified: false,
        locale: "en-US",
      }),
    ).resolves.toBeDefined();

    // Repaired manifest is strict-parseable with unique paths and a refreshed version.
    const repaired = await readManifest(dir, "claude-code");
    expect(repaired).not.toBeNull();
    const paths = repaired!.files.map(f => f.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(repaired!.generator_version).not.toBe("1.0.0");
  });

  it("upgrade --check and doctor report rather than crash on a duplicate-path manifest", async () => {
    const current = await readManifest(dir, "claude-code");
    const corrupt = {
      ...current!,
      files: [...current!.files, current!.files[0]],
    };
    await writeFile(
      manifestPath(dir, "claude-code"),
      stringifyYaml(corrupt),
      "utf8",
    );

    // --check is read-only and tolerant: it must not throw a schema error.
    await expect(
      runAdapterUpgrade({
        cwd: dir,
        agentName: "claude-code",
        mode: "check",
        force: false,
        acceptModified: false,
        locale: "en-US",
      }),
    ).resolves.toBeDefined();

    // doctor surfaces the invalid manifest as an issue instead of crashing.
    const adapterDoctor = await runAdapterDoctor({ cwd: dir, locale: "en-US" });
    expect(adapterDoctor.issues.map(i => i.code)).toContain(
      "ADAPTER_MANIFEST_INVALID",
    );
    await expect(runDoctor(dir)).resolves.toBeDefined(); // global doctor must not throw
  });
});

// ---------------------------------------------------------------------------
// --model actually pins the profile
// ---------------------------------------------------------------------------

describe("adapter --model pin", () => {
  beforeEach(async () => {
    await runInit({
      cwd: dir,
      locale: "en-US",
      agents: ["claude-code"],
      force: false,
      json: false,
    });
  });

  it("install --model claude-opus-4-7 persists model_version: opus-4.7 to the profile", async () => {
    expect((await readProfile()).model_version).toBeUndefined();

    await runAdapterInstall({
      cwd: dir,
      agentName: "claude-code",
      force: false,
      locale: "en-US",
      modelVersion: "claude-opus-4-7",
    });

    expect((await readProfile()).model_version).toBe("opus-4.7");
  });

  it("canonical and alias inputs both normalize on pin", async () => {
    await runAdapterInstall({
      cwd: dir,
      agentName: "claude-code",
      force: true,
      locale: "en-US",
      modelVersion: "opus-4.7",
    });
    expect((await readProfile()).model_version).toBe("opus-4.7");

    await runAdapterInstall({
      cwd: dir,
      agentName: "claude-code",
      force: true,
      locale: "en-US",
      modelVersion: "claude-sonnet-4-6",
    });
    expect((await readProfile()).model_version).toBe("sonnet-4.6");
  });

  it("after pinning, global doctor no longer reports ADAPTER_STALE", async () => {
    const before = await runDoctor(dir);
    expect(before.issues.map(i => i.code)).toContain("ADAPTER_STALE");

    await runAdapterInstall({
      cwd: dir,
      agentName: "claude-code",
      force: false,
      locale: "en-US",
      modelVersion: "claude-opus-4-7",
    });

    const after = await runDoctor(dir);
    expect(after.issues.map(i => i.code)).not.toContain("ADAPTER_STALE");
  });

  it("unknown --model rejects with CONFIG_ERROR and leaves the profile unpinned", async () => {
    await expect(
      runAdapterInstall({
        cwd: dir,
        agentName: "claude-code",
        force: false,
        locale: "en-US",
        modelVersion: "gpt-9",
      }),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR" });
    expect((await readProfile()).model_version).toBeUndefined();
  });
});
