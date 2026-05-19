import { readFile, readdir, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { parse as parseYaml } from "yaml";
import { AgentProfile } from "../core/schemas/agent-profile.ts";
import { ModelProfile } from "../core/schemas/model-profile.ts";
import { adapterRegistry } from "../core/adapters/index.ts";
import { isSupportedAgent } from "../core/agents.ts";
import type { DesiredAdapterFileRole } from "../core/adapters/types.ts";
import {
  assertSafeRelativePath,
  classifyFileState,
  decideAction,
  resolveWithinProject,
  type DesiredFileState,
  type FileAction,
  type LocalFileState,
} from "../core/adapters/file-state.ts";
import {
  computeContentHash,
  readManifest,
  writeManifest,
} from "../core/adapters/manifest.ts";
import type {
  AdapterManifest,
  ManifestFile,
  ProfileFingerprint,
} from "../core/schemas/adapter-manifest.ts";
import { atomicWriteText } from "../io/atomic-text.ts";
import { readPackageVersion } from "../lib/package-version.ts";
import type { Locale } from "../i18n/index.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AdapterUpgradeMode = "check" | "write";

export type AdapterUpgradeOptions = {
  cwd: string;
  agentName: string;
  mode: AdapterUpgradeMode;
  /** Unmanaged-adoption only. NEVER overrides managed-modified. */
  force: boolean;
  /** Required to overwrite managed-modified × stale files. */
  acceptModified: boolean;
  locale: Locale;
  modelVersion?: string;
  /** Role-scoped force: makes --force apply only to skill files. */
  regenSkills?: boolean;
  /** Test seam for the manifest's `generator_version`. Production callers omit. */
  generatorVersionOverride?: string;
};

export type AdapterUpgradePlanEntry = {
  /** Absolute path. */
  path: string;
  /** Project-relative POSIX path. */
  relPath: string;
  role: DesiredAdapterFileRole;
  local: LocalFileState;
  desired: DesiredFileState;
  action: FileAction;
};

export type AdapterUpgradeResult = {
  agentName: string;
  mode: AdapterUpgradeMode;
  manifestPath: string;
  generatorVersion: string;
  /** True iff every plan entry has action `skip`. */
  clean: boolean;
  /** Per-file decisions. For --check these are would-be actions; for --write these are what executed. */
  plan: AdapterUpgradePlanEntry[];
};

// ---------------------------------------------------------------------------
// Loaders (parallel to adapter-install / adapter-doctor; kept local for clarity)
// ---------------------------------------------------------------------------

async function loadAgentProfile(
  cwd: string,
  agentName: string,
): Promise<AgentProfile> {
  const path = join(cwd, ".code-pact", "agent-profiles", `${agentName}.yaml`);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    const err = new Error(
      `Agent profile for "${agentName}" not found at ${path}.`,
    );
    (err as NodeJS.ErrnoException).code = "AGENT_NOT_FOUND";
    throw err;
  }
  return AgentProfile.parse(parseYaml(raw) as unknown);
}

async function loadModelProfiles(cwd: string): Promise<ModelProfile[]> {
  const dir = join(cwd, ".code-pact", "model-profiles");
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const profiles: ModelProfile[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".yaml")) continue;
    const raw = await readFile(join(dir, entry), "utf8");
    try {
      profiles.push(ModelProfile.parse(parseYaml(raw) as unknown));
    } catch {
      // skip malformed
    }
  }
  return profiles;
}

async function readFileMaybe(absPath: string): Promise<string | null> {
  try {
    return await readFile(absPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function buildFingerprint(
  profile: AgentProfile,
  resolvedModel: string | undefined,
): ProfileFingerprint {
  const fp: ProfileFingerprint = {
    instruction_filename: profile.instruction_filename,
    context_dir: profile.context_dir,
  };
  if (profile.skill_dir) fp.skill_dir = profile.skill_dir;
  if (profile.hook_dir) fp.hook_dir = profile.hook_dir;
  if (resolvedModel) fp.resolved_model = resolvedModel;
  return fp;
}

// ---------------------------------------------------------------------------
// Upgrade
// ---------------------------------------------------------------------------

/**
 * Upgrades or checks an installed adapter. Requires that the manifest
 * already exists at `.code-pact/adapters/<agent>.manifest.yaml` — use
 * `adapter install <agent>` first for fresh projects. Throws
 * `MANIFEST_NOT_FOUND` when the manifest is absent so callers can map
 * to a clear CLI error.
 *
 * **mode: "check"** is fully read-only — never writes to disk. Returns
 * the action the corresponding `--write` would take for each file, with
 * the caveat that `unmanaged` rows always return `warn` (regardless of
 * `--force`) and `managed-modified × stale` always returns `refuse`
 * (regardless of `--accept-modified`). This lets the user confirm what
 * the destructive flags WOULD do before re-running with `--write`.
 *
 * **mode: "write"** executes the action matrix. The new manifest reflects
 * the post-write state: files written / adopted have their hash refreshed,
 * skipped managed files preserve their existing hash, refused entries are
 * preserved unchanged, and orphans (manifest entries no longer emitted by
 * the generator) drop out. Files on disk that are no longer in the new
 * manifest stay where they are — `adapter doctor` will surface them as
 * `ADAPTER_UNMANAGED_FILE` if they fall under the adapter's `ownedPathGlobs`.
 */
export async function runAdapterUpgrade(
  opts: AdapterUpgradeOptions,
): Promise<AdapterUpgradeResult> {
  const {
    cwd,
    agentName,
    mode,
    force,
    acceptModified,
    locale,
    modelVersion,
    regenSkills = false,
    generatorVersionOverride,
  } = opts;

  if (!isSupportedAgent(agentName)) {
    const err = new Error(`No adapter implementation for agent "${agentName}".`);
    (err as NodeJS.ErrnoException).code = "AGENT_NOT_FOUND";
    throw err;
  }

  const existingManifest = await readManifest(cwd, agentName);
  if (existingManifest === null) {
    const err = new Error(
      `No manifest at .code-pact/adapters/${agentName}.manifest.yaml — run "code-pact adapter install ${agentName}" first.`,
    );
    (err as NodeJS.ErrnoException).code = "MANIFEST_NOT_FOUND";
    throw err;
  }

  const [profile, modelProfiles] = await Promise.all([
    loadAgentProfile(cwd, agentName),
    loadModelProfiles(cwd),
  ]);

  const descriptor = adapterRegistry[agentName];
  const desiredFiles = await descriptor.generateDesiredFiles({
    cwd,
    profile,
    modelProfiles,
    locale,
    modelVersion,
  });

  const existingByPath = new Map<string, ManifestFile>(
    existingManifest.files.map((f) => [f.path, f]),
  );

  // For --write only: ensure directory placeholders exist before any write.
  if (mode === "write") {
    await mkdir(join(cwd, profile.context_dir), { recursive: true });
    if (profile.hook_dir) {
      await mkdir(join(cwd, profile.hook_dir), { recursive: true });
    }
  }

  const plan: AdapterUpgradePlanEntry[] = [];
  const newManifestFiles: ManifestFile[] = [];

  for (const desired of desiredFiles) {
    assertSafeRelativePath(desired.path);
    const absPath = await resolveWithinProject(cwd, desired.path);

    const desiredHash = computeContentHash(desired.content);
    const diskContent = await readFileMaybe(absPath);
    const diskHash =
      diskContent === null ? null : computeContentHash(diskContent);
    const manifestEntry = existingByPath.get(desired.path);
    const manifestHash = manifestEntry?.sha256 ?? null;

    const cls = classifyFileState({ manifestHash, diskHash, desiredHash });
    const effectiveForce = force || (regenSkills && desired.role === "skill");
    const action = decideAction({
      local: cls.local,
      desired: cls.desired,
      mode: mode === "check" ? "upgrade-check" : "upgrade-write",
      force: effectiveForce,
      acceptModified,
    });

    plan.push({
      path: absPath,
      relPath: desired.path,
      role: desired.role,
      local: cls.local,
      desired: cls.desired,
      action,
    });

    if (mode === "check") {
      // Read-only — no I/O, no manifest changes. We still need to decide
      // what hash WOULD go into the new manifest, but we don't write it.
      continue;
    }

    // ---- --write: execute action ----
    let recordedHash: string | null = null;

    if (action === "write" || action === "replace_unmanaged" || action === "update") {
      await mkdir(dirname(absPath), { recursive: true });
      await atomicWriteText(absPath, desired.content);
      recordedHash = desiredHash;
    } else if (action === "adopt") {
      // Disk matches desired; record manifest entry only.
      recordedHash = desiredHash;
    } else if (action === "update_manifest") {
      // Disk content already matches desired; refresh manifest hash only.
      recordedHash = desiredHash;
    } else if (action === "skip") {
      // Preserve existing manifest entry for managed files we did not touch.
      // For unmanaged-without-force, we don't record (file isn't ours).
      if (manifestHash !== null) {
        recordedHash = manifestHash;
      }
    } else if (action === "refuse") {
      // Preserve the existing manifest entry so the file stays tracked.
      // The disk content remains the user's local modification.
      if (manifestHash !== null) {
        recordedHash = manifestHash;
      }
    }
    // action === "warn" is only used by --check for unmanaged rows;
    // --write should never produce it (decideAction returns skip/adopt/
    // replace_unmanaged instead). Defensive no-op.

    if (recordedHash !== null) {
      newManifestFiles.push({
        path: desired.path,
        sha256: recordedHash,
        managed: true,
        role: desired.role,
      });
    }
  }

  const clean = plan.every((p) => p.action === "skip");

  // Build the result + (for --write) write the manifest.
  const generatorVersion =
    generatorVersionOverride ?? (await readPackageVersion());
  const resolvedModel = modelVersion ?? profile.model_version;

  if (mode === "check") {
    return {
      agentName,
      mode,
      manifestPath: join(cwd, ".code-pact", "adapters", `${agentName}.manifest.yaml`),
      generatorVersion: existingManifest.generator_version,
      clean,
      plan,
    };
  }

  // --write: persist the new manifest.
  const manifest: AdapterManifest = {
    schema_version: 1,
    agent_name: agentName,
    generator_version: generatorVersion,
    adapter_schema_version: descriptor.adapterSchemaVersion,
    generated_at: new Date().toISOString(),
    profile_fingerprint: buildFingerprint(profile, resolvedModel),
    files: newManifestFiles,
  };
  const writtenManifestPath = await writeManifest(cwd, agentName, manifest);

  return {
    agentName,
    mode,
    manifestPath: writtenManifestPath,
    generatorVersion,
    clean,
    plan,
  };
}
