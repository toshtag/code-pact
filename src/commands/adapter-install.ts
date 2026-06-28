import { readFile, readdir, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { AgentProfile } from "../core/schemas/agent-profile.ts";
import { ModelProfile } from "../core/schemas/model-profile.ts";
import { adapterRegistry } from "../core/adapters/index.ts";
import { isSupportedAgent } from "../core/agents.ts";
import { resolveAgentProfilePath } from "../core/agent-profile-path.ts";
import type { DesiredAdapterFileRole } from "../core/adapters/types.ts";
import {
  assertAdapterWritePathsContained,
  assertSafeRelativePath,
  authorizedPathExists,
  classifyFileState,
  decideAction,
  readAuthorizedRegularFileMaybe,
  type FileAction,
} from "../core/adapters/file-state.ts";
import { resolveWithinProject } from "../core/path-safety.ts";
import { authorizeAdapterMutationPath } from "../core/adapters/manifest-file-ownership.ts";
import {
  computeContentHash,
  manifestPath,
  manifestRelPath,
  readManifest,
  writeManifest,
} from "../core/adapters/manifest.ts";
import { dedupeDesiredFiles } from "../core/adapters/desired.ts";
import {
  resolveAndPinModelVersion,
  validateModelVersionInput,
} from "../core/adapters/model-version.ts";
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

/**
 * Why a file was `refuse`d — so the CLI can give CORRECT remediation. Only
 * `managed_modified` is resolvable with `--accept-modified`; the security
 * refusals are NOT (re-running with that flag refuses again).
 */
export type RefuseReason =
  | "managed_modified" // a local edit diverging from BOTH manifest and generator
  | "unowned_generated_path" // generated path outside the trusted owned set
  | "symlink_traversal"; // the path reaches its real target through a symlink

export type AdapterInstallWarningReason = "dynamic_file_unverifiable"; // existing dynamic file preserved without read/hash

export type AdapterInstallFile = {
  /** Absolute path. */
  path: string;
  /** Project-relative POSIX path (what gets recorded in the manifest). */
  relPath: string;
  role: DesiredAdapterFileRole;
  action: FileAction;
  /** Set when `action === "refuse"` or `action === "warn"`; drives the CLI's remediation message. */
  reason?: RefuseReason | AdapterInstallWarningReason;
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
  /**
   * Absolute paths of existing dynamic files that were preserved without
   * reading or hashing (action: warn, reason: dynamic_file_unverifiable).
   * Their bytes cannot be verified because the shared namespace does not
   * prove ownership.
   */
  preserved: string[];
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
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      const e = new Error(
        `Agent profile for "${agentName}" not found at ${path}.`,
      );
      (e as NodeJS.ErrnoException).code = "AGENT_NOT_FOUND";
      throw e;
    }
    // A non-ENOENT read failure (the profile path is a directory → EISDIR, an
    // intermediate is a file → ENOTDIR, EACCES, …) is a CONFIG problem, not a
    // missing agent — surface it structured, not as an uncoded exit 3.
    const e = new Error(
      `Agent profile for "${agentName}" at ${path} cannot be read: ${(err as Error).message}`,
    );
    (e as NodeJS.ErrnoException).code = "CONFIG_ERROR";
    throw e;
  }
  // Parse + schema-validate INSIDE a try: a project-controlled (adversarial)
  // profile with malformed YAML or a schema violation maps to CONFIG_ERROR, not
  // an uncoded throw that the CLI renders as an internal error / exit 3.
  try {
    return AgentProfile.parse(parseYaml(raw) as unknown);
  } catch (err) {
    const e = new Error(
      `Agent profile for "${agentName}" at ${path} is malformed (YAML or schema): ${(err as Error).message}`,
    );
    (e as NodeJS.ErrnoException).code = "CONFIG_ERROR";
    throw e;
  }
}

async function loadModelProfiles(cwd: string): Promise<ModelProfile[]> {
  let entries: string[];
  try {
    // Contain the DIRECTORY before enumerating it: a symlinked-outside
    // `.code-pact/model-profiles` must not even be `readdir`'d (out-of-project
    // enumeration / large-dir DoS). Optional source → an unsafe/missing dir is [].
    const dir = await resolveWithinProject(cwd, ".code-pact/model-profiles");
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const profiles: ModelProfile[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".yaml")) continue;
    try {
      // Contain the read (resolveWithinProject): a symlinked `.code-pact/model-
      // profiles` (or a per-file symlink) cannot read an out-of-project file.
      // All inside the try so an UNREADABLE entry (a `*.yaml` directory → EISDIR,
      // or an escaping symlink) is skipped like a malformed one, never an uncoded
      // errno that crashes the command (exit 3). Best-effort source.
      const abs = await resolveWithinProject(
        cwd,
        [".code-pact", "model-profiles", entry].join("/"),
      );
      const raw = await readFile(abs, "utf8");
      profiles.push(ModelProfile.parse(parseYaml(raw) as unknown));
    } catch {
      // skip unreadable / malformed / out-of-project profiles
    }
  }
  return profiles;
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
    const err = new Error(
      `No adapter implementation for agent "${agentName}".`,
    );
    (err as NodeJS.ErrnoException).code = "AGENT_NOT_FOUND";
    throw err;
  }

  const [profile, modelProfiles] = await Promise.all([
    loadAgentProfile(cwd, agentName),
    loadModelProfiles(cwd),
  ]);

  // Validate `--model` (PURE — no filesystem access) up front, so an unknown
  // value is a clean CONFIG_ERROR before anything is read or written.
  validateModelVersionInput(modelVersion);

  // Read the existing manifest BEFORE persisting the `--model` pin. A
  // fail-closed manifest state (a `.code-pact/adapters` symlink escape, or a
  // malformed/schema-invalid manifest) must abort the install HERE, before any
  // persistent side effect — otherwise a doomed `--model` install would still
  // have rewritten the agent profile's `model_version`. Tolerant read: a legacy
  // manifest with duplicate paths is repairable here (we regenerate below).
  const existingManifest = await readManifest(cwd, agentName, {
    tolerantDuplicatePaths: true,
  });
  const existingByPath = new Map<string, ManifestFile>(
    (existingManifest?.files ?? []).map(f => [f.path, f]),
  );

  // Effective model version for GENERATION, computed WITHOUT persisting it. The
  // `--model` pin is a profile write (a persistent side effect) and is deferred
  // until after the path-safety preflight below, so a doomed install never
  // strands a pinned `model_version`. (Matches `resolveAndPinModelVersion`'s own
  // resolution: normalized `--model`, else the profile's existing pin.)
  const resolvedModelVersion =
    validateModelVersionInput(modelVersion) ?? profile.model_version;

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

  // Write PREFLIGHT — fail closed BEFORE any persistent side effect. The manifest
  // read above already covered `.code-pact/adapters`; this checks the placeholder
  // dirs and manifest path with the strict no-symlink resolver. Generated-file
  // targets are authorized separately below before any target stat/read/hash.
  // Either phase aborts before the model pin or any generated-file write.
  const resolvedPreflight = await assertAdapterWritePathsContained(cwd, [
    { path: profile.context_dir, kind: "directory" },
    ...(profile.hook_dir
      ? [{ path: profile.hook_dir, kind: "directory" as const }]
      : []),
    { path: manifestRelPath(agentName), kind: "file" },
  ]);
  const contextDirAbs = resolvedPreflight.find(
    p => p.kind === "directory" && p.path === profile.context_dir,
  )!.absPath;
  const hookDirAbs = profile.hook_dir
    ? resolvedPreflight.find(
        p => p.kind === "directory" && p.path === profile.hook_dir,
      )!.absPath
    : undefined;
  const manifestAbs = resolvedPreflight.find(
    p => p.kind === "file" && p.path === manifestRelPath(agentName),
  )!.absPath;

  const created: string[] = [];
  const skipped: string[] = [];
  const adopted: string[] = [];
  const refused: string[] = [];
  const preserved: string[] = [];
  const fileResults: AdapterInstallFile[] = [];
  const newManifestFiles: ManifestFile[] = [];
  const plannedFiles: Array<{
    desired: (typeof desiredFiles)[number];
    absPath: string;
    action: FileAction;
    desiredHash: string;
  }> = [];

  for (const desired of desiredFiles) {
    assertSafeRelativePath(desired.path);
    const desiredHash = computeContentHash(desired.content);
    const manifestEntry = existingByPath.get(desired.path);
    const manifestHash = manifestEntry?.sha256 ?? null;
    const authority = await authorizeAdapterMutationPath(
      cwd,
      descriptor,
      desired.path,
      {
        expectedRole: desired.role,
        declaredRole: manifestEntry?.role,
        allowDynamicWrite: true,
      },
    );
    const absPath =
      authority.kind === "owned" || authority.kind === "dynamic_write"
        ? authority.absPath
        : join(cwd, desired.path);

    let action: FileAction;
    let refuseReason: RefuseReason | undefined;
    let warningReason: AdapterInstallWarningReason | undefined;
    if (authority.kind === "unowned") {
      action = "refuse";
      refuseReason = "unowned_generated_path";
    } else if (authority.kind === "unsafe") {
      action = "refuse";
      refuseReason = "symlink_traversal";
    } else if (authority.kind === "dynamic_write") {
      // Dynamic paths may be CREATED, but an existing target is never read or
      // hashed: the shared namespace cannot prove ownership of existing bytes.
      // An existing dynamic file is preserved (warn) — not refused — so the
      // rest of the install can proceed (static writes, model pin, manifest).
      if (await authorizedPathExists(absPath, desired.path)) {
        action = "warn";
        warningReason = "dynamic_file_unverifiable";
        preserved.push(absPath);
      } else {
        action = "write";
      }
    } else {
      const diskContent = await readAuthorizedRegularFileMaybe(
        absPath,
        desired.path,
      );
      const diskHash =
        diskContent === null ? null : computeContentHash(diskContent);
      const cls = classifyFileState({ manifestHash, diskHash, desiredHash });
      // `--regen-skills` is a role-scoped force: it makes `--force` apply only
      // to skill files. It still cannot override managed-modified.
      action = decideAction({
        local: cls.local,
        desired: cls.desired,
        mode: "install",
        force: force || (regenSkills && desired.role === "skill"),
        acceptModified: false,
      });
      if (action === "refuse") refuseReason = "managed_modified";
    }

    fileResults.push({
      path: absPath,
      relPath: desired.path,
      role: desired.role,
      action,
      ...(refuseReason ? { reason: refuseReason } : {}),
      ...(warningReason ? { reason: warningReason } : {}),
    });

    plannedFiles.push({ desired, absPath, action, desiredHash });

    let recordedHash: string | null = null;

    if (
      action === "write" ||
      action === "replace_unmanaged" ||
      action === "update"
    ) {
      recordedHash = desiredHash;
    } else if (action === "adopt") {
      recordedHash = desiredHash;
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
    } else if (action === "warn") {
      // Existing dynamic file preserved without read/hash. Keep the existing
      // manifest entry unchanged; do not adopt or update the hash.
      if (manifestEntry !== undefined) {
        newManifestFiles.push(manifestEntry);
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

  if (refused.length > 0) {
    return {
      agentName,
      manifestPath: existingManifest
        ? manifestPath(cwd, agentName)
        : manifestPath(cwd, agentName),
      generatorVersion,
      created: [],
      skipped,
      adopted: [],
      refused,
      preserved,
      files: fileResults,
    };
  }

  await resolveAndPinModelVersion({
    cwd,
    agentName,
    profile,
    modelVersionInput: modelVersion,
  });

  await mkdir(contextDirAbs, { recursive: true });
  if (hookDirAbs) {
    await mkdir(hookDirAbs, { recursive: true });
  }

  for (const planned of plannedFiles) {
    if (
      planned.action === "write" ||
      planned.action === "replace_unmanaged" ||
      planned.action === "update"
    ) {
      await mkdir(dirname(planned.absPath), { recursive: true });
      await atomicWriteText(planned.absPath, planned.desired.content);
      created.push(planned.absPath);
    } else if (planned.action === "adopt") {
      adopted.push(planned.absPath);
    }
  }

  const manifest: AdapterManifest = {
    schema_version: 1,
    agent_name: agentName,
    generator_version: generatorVersion,
    adapter_schema_version: descriptor.adapterSchemaVersion,
    generated_at: new Date().toISOString(),
    profile_fingerprint: buildFingerprint(profile, resolvedModel),
    files: newManifestFiles,
  };

  const writtenManifestPath = await writeManifest(cwd, agentName, manifest, {
    preResolvedOwnedPath: manifestAbs,
  });

  return {
    agentName,
    manifestPath: writtenManifestPath,
    generatorVersion,
    created,
    skipped,
    adopted,
    refused,
    preserved,
    files: fileResults,
  };
}
