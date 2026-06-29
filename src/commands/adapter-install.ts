import { stat } from "../core/project-fs/index.ts";
import { join } from "node:path";
import { AgentProfile } from "../core/schemas/agent-profile.ts";
import { ModelProfile } from "../core/schemas/model-profile.ts";
import { adapterRegistry } from "../core/adapters/index.ts";
import { isSupportedAgent } from "../core/agents.ts";
import { loadValidatedAdapterProfile } from "../core/agent-profile-path.ts";
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
import { loadModelProfilesStrict } from "../core/models/load-model-profiles.ts";
import { authorizeAdapterMutationPath } from "../core/adapters/manifest-file-ownership.ts";
import {
  computeContentHash,
  manifestPath,
  planManifestWrite,
  manifestRelPath,
  readManifest,
} from "../core/adapters/manifest.ts";
import { dedupeDesiredFiles } from "../core/adapters/desired.ts";
import {
  planModelVersionPin,
  validateModelVersionInput,
} from "../core/adapters/model-version.ts";
import type {
  AdapterManifest,
  ManifestFile,
  ProfileFingerprint,
} from "../core/schemas/adapter-manifest.ts";
import {
  FileTransaction,
  recoverPendingAdapterTransactions,
} from "../core/adapters/staged-write.ts";
import { resolveSymlinkFreeProjectPath } from "../core/path-safety.ts";
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

async function loadModelProfiles(cwd: string): Promise<ModelProfile[]> {
  // Fail-closed: a symlinked or unreadable model-profiles directory is a
  // CONFIG_ERROR, not silently degraded to empty profiles. An empty array
  // would cause the generator to produce model-unaware output, masking the
  // configuration problem.
  try {
    return await loadModelProfilesStrict(cwd);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "PATH_NOT_OWNED" || code === "PATH_OUTSIDE_PROJECT") {
      const e = new Error(
        `Model profiles directory is not an owned project path and was refused: ${(err as Error).message}`,
      );
      (e as NodeJS.ErrnoException).code = "CONFIG_ERROR";
      throw e;
    }
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
    const err = new Error(
      `No adapter implementation for agent "${agentName}".`,
    );
    (err as NodeJS.ErrnoException).code = "AGENT_NOT_FOUND";
    throw err;
  }

  const descriptor = adapterRegistry[agentName];
  const [profile, modelProfiles] = await Promise.all([
    loadValidatedAdapterProfile(cwd, agentName, descriptor),
    loadModelProfiles(cwd),
  ]);

  // Profile contract validation has already run inside loadValidatedAdapterProfile.

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

  const desiredFiles = dedupeDesiredFiles(
    await descriptor.generateDesiredFiles({
      cwd,
      profile,
      modelProfiles,
      locale,
      modelVersion: resolvedModelVersion,
    }),
  );

  // Write PREFLIGHT — fail closed BEFORE any persistent side effect. Only the
  // manifest path (a fixed .code-pact/adapters path) is checked here. Profile-
  // derived paths (context_dir, hook_dir) are NOT pre-created or pre-checked:
  // the profile contract has already validated them against canonical values,
  // and the write loop creates parent dirs via mkdir(dirname(absPath), { recursive }).
  // This prevents a hostile profile from forcing arbitrary directory creation
  // even if the contract check is bypassed.
  await assertAdapterWritePathsContained(cwd, [
    { path: manifestRelPath(agentName), kind: "file" },
  ]);

  // Resolve context_dir symlink-free BEFORE the model pin. context_dir is
  // schema-constrained to .context/** and a symlinked .context must be caught
  // here — before any persistent side effect — so a doomed install never
  // strands a pinned model_version. context_dir is NOT pre-created: the
  // atomic write path creates it lazily when the first context pack is written.
  let contextDirAbs: string;
  try {
    contextDirAbs = await resolveSymlinkFreeProjectPath(
      cwd,
      profile.context_dir,
    );
  } catch (err) {
    const e = new Error(
      `context_dir "${profile.context_dir}" resolves through a symlink or outside the project root and was refused: ${(err as Error).message}`,
    );
    (e as NodeJS.ErrnoException).code = "CONFIG_ERROR";
    throw e;
  }

  // Type check: if context_dir already exists as a non-directory (e.g. a
  // regular file planted by a hostile repo), a later context pack write would
  // fail. Catch it here — before any persistent side effect.
  try {
    const s = await stat(contextDirAbs);
    if (!s.isDirectory()) {
      const e = new Error(
        `context_dir "${profile.context_dir}" already exists but is not a directory`,
      );
      (e as NodeJS.ErrnoException).code = "CONFIG_ERROR";
      throw e;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // not-yet-created — valid
    } else if ((err as NodeJS.ErrnoException).code === "CONFIG_ERROR") {
      throw err;
    } else {
      throw err;
    }
  }

  // Verify hook_dir is symlink-free (if declared). hook_dir is NOT pre-created,
  // but a symlinked hook_dir must be caught here — before the model pin — so
  // the install fails closed without partial side effects.
  if (profile.hook_dir !== undefined) {
    try {
      await resolveSymlinkFreeProjectPath(cwd, profile.hook_dir);
    } catch (err) {
      const e = new Error(
        `hook_dir "${profile.hook_dir}" resolves through a symlink or outside the project root and was refused: ${(err as Error).message}`,
      );
      (e as NodeJS.ErrnoException).code = "CONFIG_ERROR";
      throw e;
    }
  }

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
      // hashed: even with the reserved `code-pact-*` namespace, an existing
      // file's ownership cannot be proven via manifest SHA alone. An existing
      // dynamic file is preserved (warn) — not refused — so the rest of the
      // install can proceed (static writes, model pin, manifest).
      if (await authorizedPathExists(absPath, desired.path)) {
        if (manifestEntry?.ownership === "handed_off") {
          action = "skip";
        } else {
          action = "warn";
          warningReason = "dynamic_file_unverifiable";
          preserved.push(absPath);
        }
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
    let recordedOwnership: ManifestFile["ownership"] = "managed";

    if (
      action === "write" ||
      action === "replace_unmanaged" ||
      action === "update"
    ) {
      recordedHash = desiredHash;
      if (authority.kind === "dynamic_write") recordedOwnership = "handed_off";
    } else if (action === "adopt") {
      recordedHash = desiredHash;
    } else if (action === "skip") {
      skipped.push(absPath);
      // Preserve existing manifest entry for managed files we did not touch.
      // For unmanaged-without-force, we don't record (file isn't ours yet).
      if (manifestHash !== null) {
        recordedHash = manifestHash;
        recordedOwnership = manifestEntry?.ownership ?? "managed";
      }
    } else if (action === "refuse") {
      // managed-modified × stale: divergent from BOTH the manifest and the
      // generator. Do not overwrite (possible local edit) but surface it (the
      // command layer warns + exits non-zero). Keep tracking it so it stays
      // visible rather than re-classifying as an unmanaged surprise next run.
      refused.push(absPath);
      if (manifestHash !== null) {
        recordedHash = manifestHash;
        recordedOwnership = manifestEntry?.ownership ?? "managed";
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
        ownership: recordedOwnership,
      });
    }
  }

  const generatorVersion =
    generatorVersionOverride ?? (await readPackageVersion());

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

  const pinPlan = await planModelVersionPin({
    cwd,
    agentName,
    profile,
    modelVersionInput: modelVersion,
  });
  const resolvedModel = pinPlan.resolvedModelVersion;

  const manifest: AdapterManifest = {
    schema_version: 1,
    agent_name: agentName,
    generator_version: generatorVersion,
    adapter_schema_version: descriptor.adapterSchemaVersion,
    generated_at: new Date().toISOString(),
    profile_fingerprint: buildFingerprint(profile, resolvedModel),
    files: newManifestFiles,
  };
  const manifestWrite = await planManifestWrite(cwd, agentName, manifest);

  await recoverPendingAdapterTransactions(cwd);
  const tx = new FileTransaction({ cwd });
  try {
    if (pinPlan.write !== null) {
      await tx.stage(pinPlan.write.path, pinPlan.write.content);
    }
    for (const planned of plannedFiles) {
      if (
        planned.action === "write" ||
        planned.action === "replace_unmanaged" ||
        planned.action === "update"
      ) {
        const writeAuthority = await authorizeAdapterMutationPath(
          cwd,
          descriptor,
          planned.desired.path,
          {
            expectedRole: planned.desired.role,
            allowDynamicWrite: true,
          },
        );
        if (
          writeAuthority.kind !== "owned" &&
          writeAuthority.kind !== "dynamic_write"
        ) {
          const err = new Error(
            `Refusing to write adapter file "${planned.desired.path}" without path authority.`,
          );
          (err as NodeJS.ErrnoException).code = "CONFIG_ERROR";
          throw err;
        }
        await tx.stage(writeAuthority.absPath, planned.desired.content);
        created.push(writeAuthority.absPath);
      } else if (planned.action === "adopt") {
        adopted.push(planned.absPath);
      }
    }
    await tx.stage(manifestWrite.path, manifestWrite.content);
    await tx.commit();
  } catch (err) {
    await tx.rollback();
    throw err;
  }

  return {
    agentName,
    manifestPath: manifestWrite.path,
    generatorVersion,
    created,
    skipped,
    adopted,
    refused,
    preserved,
    files: fileResults,
  };
}
