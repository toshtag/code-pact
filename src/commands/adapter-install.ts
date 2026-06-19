import { readFile, readdir, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { parse as parseYaml } from "yaml";
import { AgentProfile } from "../core/schemas/agent-profile.ts";
import { ModelProfile } from "../core/schemas/model-profile.ts";
import { adapterRegistry } from "../core/adapters/index.ts";
import { isSupportedAgent } from "../core/agents.ts";
import { resolveAgentProfilePath } from "../core/agent-profile-path.ts";
import type { DesiredAdapterFileRole } from "../core/adapters/types.ts";
import {
  assertSafeRelativePath,
  classifyFileState,
  decideAction,
  resolveWithinProject,
  type FileAction,
} from "../core/adapters/file-state.ts";
import {
  computeContentHash,
  readManifest,
  writeManifest,
} from "../core/adapters/manifest.ts";
import { dedupeDesiredFiles } from "../core/adapters/desired.ts";
import { resolveAndPinModelVersion } from "../core/adapters/model-version.ts";
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

export type AdapterInstallOptions = {
  cwd: string;
  agentName: string;
  force: boolean;
  locale: Locale;
  modelVersion?: string;
  regenSkills?: boolean;
  /**
   * Test seam for the manifest's `generator_version` field. Production
   * callers omit this and the value is read from package.json. Always
   * present in the result.
   */
  generatorVersionOverride?: string;
};

export type AdapterInstallFile = {
  /** Absolute path. */
  path: string;
  /** Project-relative POSIX path (what gets recorded in the manifest). */
  relPath: string;
  role: DesiredAdapterFileRole;
  action: FileAction;
};

export type AdapterInstallResult = {
  agentName: string;
  manifestPath: string;
  generatorVersion: string;
  /** Absolute paths of files written (action: write | replace_unmanaged). */
  created: string[];
  /** Absolute paths of files left alone (action: skip). */
  skipped: string[];
  /** Absolute paths of files adopted into the manifest without write (action: adopt). */
  adopted: string[];
  /**
   * Absolute paths of managed files whose on-disk content matches NEITHER the
   * manifest hash NOR the current generator output (managed-modified × stale).
   * Install does not overwrite them (possible local edit) but surfaces them so
   * a hostile-repo divergence is never silently passed over (action: refuse).
   * Overwrite with `adapter upgrade --write --accept-modified`.
   */
  refused: string[];
  files: AdapterInstallFile[];
};

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

async function loadAgentProfile(
  cwd: string,
  agentName: string,
): Promise<AgentProfile> {
  const path = await resolveAgentProfilePath(cwd, agentName);
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
      // skip malformed profiles
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
// Install
// ---------------------------------------------------------------------------

/**
 * Generates the adapter for `agentName` and writes a manifest.
 * `--force` only adopts / replaces UNMANAGED files. It never overwrites a
 * managed-MODIFIED file (one whose disk content diverges from its manifest
 * hash). It DOES re-render a managed-clean file whose content is stale relative
 * to the current generator output — that file is verbatim generator output, so
 * refreshing it destroys no edits and prevents a project-shipped (possibly
 * forged) manifest from preserving stale generated content.
 *
 * A managed file whose disk content matches NEITHER the manifest hash NOR the
 * generator output (managed-modified × stale) is **refused** (`refused[]`): not
 * overwritten (it could be a genuine local edit), but not silently skipped
 * either — the divergence is surfaced (the command layer warns + exits
 * non-zero) so a hostile-repo file is never passed over in silence. To
 * force-overwrite a managed-modified file, callers must use
 * `adapter upgrade --write --accept-modified`.
 *
 * On every invocation, regardless of whether the manifest existed before,
 * a fresh manifest is written reflecting the current desired file set and
 * the recorded sha256 hashes. Files that were in the previous manifest
 * but are no longer emitted by the generator (e.g. a verification command
 * was removed from the roadmap) drop out of the new manifest — they
 * remain on disk for the user to remove and `adapter doctor` will
 * surface them as unmanaged.
 */
export async function runAdapterInstall(
  opts: AdapterInstallOptions,
): Promise<AdapterInstallResult> {
  const {
    cwd,
    agentName,
    force,
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

  const [profile, modelProfiles] = await Promise.all([
    loadAgentProfile(cwd, agentName),
    loadModelProfiles(cwd),
  ]);

  // Validate `--model` and pin it to the agent profile BEFORE any other
  // filesystem mutation. An unknown value throws CONFIG_ERROR here, before
  // a single directory or file is written.
  const resolvedModelVersion = await resolveAndPinModelVersion({
    cwd,
    agentName,
    profile,
    modelVersionInput: modelVersion,
  });

  const descriptor = adapterRegistry[agentName];
  const desiredFiles = dedupeDesiredFiles(
    await descriptor.generateDesiredFiles({
      cwd,
      profile,
      modelProfiles,
      locale,
      modelVersion: resolvedModelVersion,
    }),
  );

  // Tolerant read: a legacy manifest with duplicate paths is repairable here —
  // we regenerate a unique manifest below — so it must not abort the install.
  const existingManifest = await readManifest(cwd, agentName, {
    tolerantDuplicatePaths: true,
  });
  const existingByPath = new Map<string, ManifestFile>(
    (existingManifest?.files ?? []).map((f) => [f.path, f]),
  );

  // Directory placeholders: every adapter gets its
  // context_dir, Claude additionally gets its hook_dir.
  await mkdir(join(cwd, profile.context_dir), { recursive: true });
  if (profile.hook_dir) {
    await mkdir(join(cwd, profile.hook_dir), { recursive: true });
  }

  const created: string[] = [];
  const skipped: string[] = [];
  const adopted: string[] = [];
  const refused: string[] = [];
  const fileResults: AdapterInstallFile[] = [];
  const newManifestFiles: ManifestFile[] = [];

  for (const desired of desiredFiles) {
    assertSafeRelativePath(desired.path);
    const absPath = await resolveWithinProject(cwd, desired.path);

    const desiredHash = computeContentHash(desired.content);
    const diskContent = await readFileMaybe(absPath);
    const diskHash =
      diskContent === null ? null : computeContentHash(diskContent);
    const manifestHash = existingByPath.get(desired.path)?.sha256 ?? null;

    const cls = classifyFileState({ manifestHash, diskHash, desiredHash });
    // `--regen-skills` is a role-scoped force: it makes `--force` apply only
    // to skill files. It still cannot override managed-modified (handled
    // by decideAction below).
    const effectiveForce = force || (regenSkills && desired.role === "skill");
    const action = decideAction({
      local: cls.local,
      desired: cls.desired,
      mode: "install",
      force: effectiveForce,
      acceptModified: false,
    });

    fileResults.push({
      path: absPath,
      relPath: desired.path,
      role: desired.role,
      action,
    });

    let recordedHash: string | null = null;

    if (action === "write" || action === "replace_unmanaged" || action === "update") {
      // `update` arises for managed-clean × stale: the file is verbatim (older)
      // generator output, safe to refresh to current desired content. This also
      // self-heals a forged manifest that matched shipped-stale instructions.
      await mkdir(dirname(absPath), { recursive: true });
      await atomicWriteText(absPath, desired.content);
      recordedHash = desiredHash;
      created.push(absPath);
    } else if (action === "adopt") {
      // Disk content already matches desired; just record in the manifest.
      recordedHash = desiredHash;
      adopted.push(absPath);
    } else if (action === "skip") {
      skipped.push(absPath);
      // Preserve existing manifest entry for managed files we did not touch.
      // For unmanaged-without-force, we don't record (file isn't ours yet).
      if (manifestHash !== null) {
        recordedHash = manifestHash;
      }
    } else if (action === "refuse") {
      // managed-modified × stale: divergent from BOTH the manifest and the
      // generator. Do not overwrite (possible local edit) but surface it (the
      // command layer warns + exits non-zero). Keep tracking it so it stays
      // visible rather than re-classifying as an unmanaged surprise next run.
      refused.push(absPath);
      if (manifestHash !== null) {
        recordedHash = manifestHash;
      }
    }
    // Other actions (update_manifest / warn) are not reachable in install mode
    // per the action matrix.

    if (recordedHash !== null) {
      newManifestFiles.push({
        path: desired.path,
        sha256: recordedHash,
        managed: true,
        role: desired.role,
      });
    }
  }

  const generatorVersion =
    generatorVersionOverride ?? (await readPackageVersion());
  const resolvedModel = resolvedModelVersion;

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
    manifestPath: writtenManifestPath,
    generatorVersion,
    created,
    skipped,
    adopted,
    refused,
    files: fileResults,
  };
}
