import { stat } from "../core/project-fs/index.ts";
import { join } from "node:path";
import { AgentProfile } from "../core/schemas/agent-profile.ts";
import { ModelProfile } from "../core/schemas/model-profile.ts";
import { adapterRegistry } from "../core/adapters/index.ts";
import { isSupportedAgent } from "../core/agents.ts";
import {
  resolveAgentProfileRel,
  loadValidatedAdapterProfile,
} from "../core/agent-profile-path.ts";
import type { DesiredAdapterFileRole } from "../core/adapters/types.ts";
import {
  assertAdapterWritePathsContained,
  assertSafeRelativePath,
  authorizedPathExists,
  classifyFileState,
  decideAction,
  readAuthorizedRegularFileMaybe,
  type AdapterUpgradePlanDesiredState,
  type AdapterUpgradeReason,
  type FileAction,
  type LocalFileState,
} from "../core/adapters/file-state.ts";
import { loadModelProfilesStrict } from "../core/models/load-model-profiles.ts";
import { authorizeAdapterMutationPath } from "../core/adapters/manifest-file-ownership.ts";
import {
  computeContentHash,
  manifestRelPath,
  planManifestWrite,
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
import { FileTransaction } from "../core/adapters/staged-write.ts";
import { resolveSymlinkFreeProjectPath } from "../core/path-safety.ts";
import { readPackageVersion } from "../lib/package-version.ts";
import {
  detectModelMapDrift,
  type ModelMapDrift,
} from "../core/models/model-map-drift.ts";
import { isDoctorCheckDisabled } from "../core/doctor-config.ts";
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
  local: LocalFileState | "unverifiable";
  desired: AdapterUpgradePlanDesiredState;
  action: FileAction;
  /**
   * Stable machine-readable reason for a non-obvious action. Set for `warn`
   * (`dynamic_file_unverifiable`, `unowned_orphan_not_pruned`) and `refuse`
   * (`managed_modified`, `unowned_generated_path`, `symlink_traversal`).
   */
  reason?: AdapterUpgradeReason;
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
// Loaders
// ---------------------------------------------------------------------------

async function loadModelProfiles(cwd: string): Promise<ModelProfile[]> {
  // Fail-closed: a symlinked or unreadable model-profiles directory is a
  // CONFIG_ERROR, not silently degraded to empty profiles.
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
 * preserved unchanged.
 *
 * **Orphan prune:** a path the OLD manifest tracked but the generator no
 * longer emits is auto-deleted ONLY when (a) its path is in the adapter
 * descriptor's owned path set and (b) its content still matches the manifest
 * hash (`action: "prune"`). An owned orphan the user edited is `refuse`d (left
 * in place). An orphan OUTSIDE the owned set is never deleted — even when
 * clean — but surfaced as `warn` and kept tracked, because the manifest is
 * project-controlled and trusting it to authorize a delete would let a forged
 * manifest remove arbitrary in-project files (see the security note at the
 * prune loop). `--check` reports the same actions without touching disk. Files
 * never tracked by the manifest (hand-authored skills) are not manifest
 * entries, so they are never considered.
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
    const err = new Error(
      `No adapter implementation for agent "${agentName}".`,
    );
    (err as NodeJS.ErrnoException).code = "AGENT_NOT_FOUND";
    throw err;
  }

  // Tolerant read: a legacy manifest with duplicate paths is repairable by
  // `--write` (we regenerate a unique manifest below), and `--check` must
  // report drift rather than crash with a schema error. Either way the
  // duplicate-path strict check must not abort before we can act.
  const existingManifest = await readManifest(cwd, agentName, {
    tolerantDuplicatePaths: true,
  });
  if (existingManifest === null) {
    const err = new Error(
      `No manifest at .code-pact/adapters/${agentName}.manifest.yaml — run "code-pact adapter install ${agentName}" first.`,
    );
    (err as NodeJS.ErrnoException).code = "MANIFEST_NOT_FOUND";
    throw err;
  }

  const descriptor = adapterRegistry[agentName];
  const [profile, modelProfiles] = await Promise.all([
    loadValidatedAdapterProfile(cwd, agentName, descriptor),
    loadModelProfiles(cwd),
  ]);

  // Profile contract validation has already run inside loadValidatedAdapterProfile.

  // Effective model version for GENERATION, computed WITHOUT persisting it.
  // `--check` never pins (and the CLI rejects `--check --model`); `--write` pins
  // `--model`, but the pin is a profile write deferred until AFTER the path-safety
  // preflight below, so a doomed `--write` never strands a pinned `model_version`.
  // validateModelVersionInput is pure and fails fast (CONFIG_ERROR) on an unknown
  // `--model` in both modes. (Matches resolveAndPinModelVersion's own resolution.)
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

  const existingByPath = new Map<string, ManifestFile>(
    existingManifest.files.map(f => [f.path, f]),
  );

  // Write PREFLIGHT — only the manifest path. Profile-derived paths are NOT
  // pre-checked: the profile contract has already validated them against
  // canonical values, and the write loop creates parent dirs as needed.
  await assertAdapterWritePathsContained(cwd, [
    { path: manifestRelPath(agentName), kind: "file" },
  ]);

  // Resolve context_dir symlink-free BEFORE the model pin. context_dir is
  // NOT pre-created: the atomic write path creates it lazily when the first
  // context pack is written.
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

  // Type check: if context_dir already exists as a non-directory, a later
  // context pack write would fail. Catch it here — before any side effect.
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

  // Verify hook_dir is symlink-free (if declared). NOT pre-created, but a
  // symlinked hook_dir must be caught before the model pin.
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

  const plan: AdapterUpgradePlanEntry[] = [];
  const newManifestFiles: ManifestFile[] = [];
  const desiredApply: Array<{
    desired: (typeof desiredFiles)[number];
    absPath: string;
    action: FileAction;
  }> = [];
  const orphanApply: Array<{
    relPath: string;
    role: DesiredAdapterFileRole;
    absPath: string;
    action: FileAction;
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

    let local: LocalFileState | "unverifiable";
    let desiredState: AdapterUpgradePlanDesiredState;
    let action: FileAction;
    let reason: AdapterUpgradeReason | undefined;
    if (authority.kind === "unowned") {
      local = "unverifiable";
      desiredState = "unverifiable";
      action = "refuse";
      reason = "unowned_generated_path";
    } else if (authority.kind === "unsafe") {
      local = "unverifiable";
      desiredState = "unverifiable";
      action = "refuse";
      reason = "symlink_traversal";
    } else if (authority.kind === "dynamic_write") {
      // Dynamic paths may be CREATED, but an existing target is never read or
      // hashed. Even with the reserved `code-pact-*` namespace, an existing
      // file's ownership cannot be proven via manifest SHA alone. An existing
      // dynamic file is preserved (warn) — not refused — so the rest of the
      // upgrade can proceed (static writes, model pin, manifest refresh).
      if (await authorizedPathExists(absPath, desired.path)) {
        local = "unverifiable";
        desiredState = "unverifiable";
        action = "warn";
        reason = "dynamic_file_unverifiable";
      } else {
        const cls = classifyFileState({
          manifestHash,
          diskHash: null,
          desiredHash,
        });
        local = cls.local;
        desiredState = cls.desired;
        action = decideAction({
          local,
          desired: cls.desired,
          mode: mode === "check" ? "upgrade-check" : "upgrade-write",
          force: force || (regenSkills && desired.role === "skill"),
          acceptModified,
        });
      }
    } else {
      const diskContent = await readAuthorizedRegularFileMaybe(
        absPath,
        desired.path,
      );
      const diskHash =
        diskContent === null ? null : computeContentHash(diskContent);
      const cls = classifyFileState({ manifestHash, diskHash, desiredHash });
      local = cls.local;
      desiredState = cls.desired;
      action = decideAction({
        local,
        desired: desiredState,
        mode: mode === "check" ? "upgrade-check" : "upgrade-write",
        force: force || (regenSkills && desired.role === "skill"),
        acceptModified,
      });
      if (action === "refuse") reason = "managed_modified";
    }

    plan.push({
      path: absPath,
      relPath: desired.path,
      role: desired.role,
      local,
      desired: desiredState,
      action,
      ...(reason ? { reason } : {}),
    });

    if (mode === "check") {
      // Read-only — no I/O, no manifest changes. We still need to decide
      // what hash WOULD go into the new manifest, but we don't write it.
      continue;
    }

    desiredApply.push({ desired, absPath, action });
    let recordedHash: string | null = null;

    if (
      action === "write" ||
      action === "replace_unmanaged" ||
      action === "update"
    ) {
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
    } else if (action === "warn") {
      // Existing dynamic file preserved without read/hash. Keep the existing
      // manifest entry unchanged; do not adopt or update the hash.
      if (manifestEntry !== undefined) {
        newManifestFiles.push(manifestEntry);
      }
    }

    if (recordedHash !== null) {
      newManifestFiles.push({
        path: desired.path,
        sha256: recordedHash,
        managed: true,
        role: desired.role,
      });
    }
  }

  // ---- Orphan prune ----
  // A path the OLD manifest tracked but the generator no longer emits (it
  // dropped out of `desiredFiles`) is an orphan. This happens when a skill is
  // renamed — e.g. the self-describing skill-name change turned `claude-code-2`
  // into `adapter-doctor`, leaving the old file on disk. We delete only orphans
  // whose disk content still matches the manifest hash (managed-clean): they are
  // verbatim generator output, safe to remove. An orphan the user edited
  // (managed-modified) is REFUSED — left on disk and surfaced — so a manual
  // change is never silently destroyed. A manifest entry whose disk file is
  // already gone (managed-missing) needs no action. Files never tracked by the
  // manifest (hand-authored skills like ship-task.md) are not in
  // `existingByPath`, so they are never considered here.
  const desiredPaths = new Set(desiredFiles.map(d => d.path));
  for (const [relPath, entry] of existingByPath) {
    if (desiredPaths.has(relPath)) continue; // still emitted — handled above
    assertSafeRelativePath(relPath);
    const authority = await authorizeAdapterMutationPath(
      cwd,
      descriptor,
      relPath,
      {
        expectedRole: entry.role,
        declaredRole: entry.role,
        allowDynamicWrite: false,
      },
    );
    const absPath =
      authority.kind === "owned" ? authority.absPath : join(cwd, relPath);

    if (authority.kind === "unowned" || authority.kind === "dynamic_write") {
      // Manifest-only unowned paths are never statted or read. Report the same
      // opaque state whether the target is missing, present, or hash-matching.
      plan.push({
        path: absPath,
        relPath,
        role: entry.role,
        local: "unverifiable",
        desired: "stale",
        action: "warn",
        reason: "unowned_orphan_not_pruned",
      });
      if (mode === "write") newManifestFiles.push(entry);
      continue;
    }
    if (authority.kind === "unsafe") {
      plan.push({
        path: absPath,
        relPath,
        role: entry.role,
        local: "unverifiable",
        desired: "stale",
        action: "refuse",
        reason: "symlink_traversal",
      });
      continue;
    }

    const diskContent = await readAuthorizedRegularFileMaybe(absPath, relPath);
    if (diskContent === null) continue; // managed-missing: nothing on disk to prune
    const isClean = computeContentHash(diskContent) === entry.sha256;
    const action: FileAction = isClean ? "prune" : "refuse";

    plan.push({
      path: absPath,
      relPath,
      role: entry.role,
      local: isClean ? "managed-clean" : "managed-modified",
      desired: "stale", // generator no longer emits this path
      action,
      // Machine-readable reason: `warn` = unowned orphan kept on disk; `refuse` =
      // a symlinked owned orphan (would delete the real target) or a local edit.
      ...(action === "refuse" ? { reason: "managed_modified" } : {}),
    });

    if (mode === "check") continue; // read-only

    orphanApply.push({ relPath, role: entry.role, absPath, action });
    if (action !== "prune") {
      // refuse / warn: keep the file on disk AND keep tracking it, so the next
      // run still sees it as a managed orphan (and still refuses/warns) rather
      // than re-classifying it as an unmanaged surprise.
      newManifestFiles.push({
        path: relPath,
        sha256: entry.sha256,
        managed: true,
        role: entry.role,
      });
    }
  }

  const clean = plan.every(p => p.action === "skip");

  // Build the result + (for --write) write the manifest.
  const generatorVersion =
    generatorVersionOverride ?? (await readPackageVersion());
  if (mode === "check") {
    return {
      agentName,
      mode,
      manifestPath: join(
        cwd,
        ".code-pact",
        "adapters",
        `${agentName}.manifest.yaml`,
      ),
      generatorVersion: existingManifest.generator_version,
      clean,
      plan,
    };
  }

  if (plan.some(p => p.action === "refuse")) {
    return {
      agentName,
      mode,
      manifestPath: join(
        cwd,
        ".code-pact",
        "adapters",
        `${agentName}.manifest.yaml`,
      ),
      generatorVersion,
      clean,
      plan,
    };
  }

  const pinPlan = await planModelVersionPin({
    cwd,
    agentName,
    profile,
    modelVersionInput: modelVersion,
  });
  const resolvedModel = pinPlan.resolvedModelVersion;

  // --write: persist the new manifest after all refusal checks have passed.
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

  // Stage profile pin, desired-file writes, orphan deletes, and manifest in one
  // best-effort transaction. The manifest is committed last.
  const tx = new FileTransaction();
  try {
    if (pinPlan.write !== null) {
      await tx.stage(pinPlan.write.path, pinPlan.write.content);
    }
    for (const item of desiredApply) {
      if (
        item.action === "write" ||
        item.action === "replace_unmanaged" ||
        item.action === "update"
      ) {
        const writeAuthority = await authorizeAdapterMutationPath(
          cwd,
          descriptor,
          item.desired.path,
          {
            expectedRole: item.desired.role,
            allowDynamicWrite: true,
          },
        );
        if (
          writeAuthority.kind !== "owned" &&
          writeAuthority.kind !== "dynamic_write"
        ) {
          const err = new Error(
            `Refusing to write adapter file "${item.desired.path}" without path authority.`,
          );
          (err as NodeJS.ErrnoException).code = "CONFIG_ERROR";
          throw err;
        }
        await tx.stage(writeAuthority.absPath, item.desired.content);
      }
    }
    for (const item of orphanApply) {
      if (item.action === "prune") {
        const pruneAuthority = await authorizeAdapterMutationPath(
          cwd,
          descriptor,
          item.relPath,
          {
            expectedRole: item.role,
            declaredRole: item.role,
            allowDynamicWrite: false,
          },
        );
        if (pruneAuthority.kind !== "owned") {
          const err = new Error(
            `Refusing to prune adapter file "${item.relPath}" without path authority.`,
          );
          (err as NodeJS.ErrnoException).code = "CONFIG_ERROR";
          throw err;
        }
        tx.stageDelete(pruneAuthority.absPath);
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
    mode,
    manifestPath: manifestWrite.path,
    generatorVersion,
    clean,
    plan,
  };
}

export type AgentModelMapDrift = {
  /** Project-relative (under `.code-pact/`) path of the agent profile read. */
  profileRel: string;
  drift: ModelMapDrift[];
};

/**
 * Detect MODEL_MAP_STALE drift for an agent's `model_map`, for the
 * `adapter upgrade --write` remaining-advisory hint. `adapter upgrade` never
 * rewrites `model_map` (a deliberate pin may be intentional), so a stale entry
 * survives a `--write`; this lets the CLI tell the user *why* an advisory
 * remained rather than leaving them to re-run `doctor` to find out.
 *
 * Scoped to claude-code — the only catalog-backed agent — so it returns an
 * empty `drift` for any other agent, without touching the filesystem at all:
 * the non-claude gate is first, so a broken `project.yaml` cannot make a
 * non-claude call throw before it returns empty (the documented contract holds
 * unconditionally). For claude-code it reads the profile fresh from disk (after
 * the write), reusing the shared {@link detectModelMapDrift} condition so the
 * hint can never disagree with doctor's `MODEL_MAP_STALE`.
 *
 * Honors the same suppression as doctor: a project that silenced the advisory
 * via `.code-pact/doctor.yaml` (`disabled_checks: [MODEL_MAP_STALE]`) gets an
 * empty `drift`, so the hint never re-nags about a pin the team already chose
 * to keep — and never contradicts its own "silence via doctor.yaml" guidance.
 */
export async function detectAgentModelMapDrift(
  cwd: string,
  agentName: string,
): Promise<AgentModelMapDrift> {
  // Non-claude first: no profile resolution, no I/O, no failure path. The
  // returned `profileRel` is the convention only as a placeholder — non-claude
  // callers never consume it (drift is always empty, and the CLI gates the call
  // on claude-code), so it is never resolved against a custom agents[].profile.
  if (agentName !== "claude-code") {
    return { profileRel: `agent-profiles/${agentName}.yaml`, drift: [] };
  }
  const profileRel = await resolveAgentProfileRel(cwd, agentName);
  if (await isDoctorCheckDisabled(cwd, "MODEL_MAP_STALE")) {
    return { profileRel, drift: [] };
  }
  const descriptor = adapterRegistry[agentName];
  const profile = await loadValidatedAdapterProfile(cwd, agentName, descriptor);
  return { profileRel, drift: detectModelMapDrift(profile.model_map) };
}
