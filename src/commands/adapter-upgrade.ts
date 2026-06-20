import { readFile, readdir, mkdir, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { parse as parseYaml } from "yaml";
import { AgentProfile } from "../core/schemas/agent-profile.ts";
import { ModelProfile } from "../core/schemas/model-profile.ts";
import { adapterRegistry } from "../core/adapters/index.ts";
import { isSupportedAgent } from "../core/agents.ts";
import {
  resolveAgentProfilePath,
  resolveAgentProfileRel,
} from "../core/agent-profile-path.ts";
import type { DesiredAdapterFileRole } from "../core/adapters/types.ts";
import {
  assertAdapterWritePathsContained,
  assertSafeRelativePath,
  classifyFileState,
  decideAction,
  pathTraversesSymlink,
  resolveWithinProject,
  type DesiredFileState,
  type FileAction,
  type LocalFileState,
} from "../core/adapters/file-state.ts";
import { resolveOwnedProjectPath } from "../core/path-safety.ts";
import {
  computeContentHash,
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
import { matchGlob } from "../core/glob.ts";
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
  local: LocalFileState;
  desired: DesiredFileState;
  action: FileAction;
  /**
   * Stable machine-readable reason for a non-obvious action. Set for `warn`
   * (an unowned orphan kept on disk): `"unowned_orphan_not_pruned"`. Absent
   * for actions whose meaning is self-evident from `(action, local, desired)`.
   */
  reason?: string;
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
  const path = await resolveAgentProfilePath(cwd, agentName);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      const e = new Error(`Agent profile for "${agentName}" not found at ${path}.`);
      (e as NodeJS.ErrnoException).code = "AGENT_NOT_FOUND";
      throw e;
    }
    const e = new Error(
      `Agent profile for "${agentName}" at ${path} cannot be read: ${(err as Error).message}`,
    );
    (e as NodeJS.ErrnoException).code = "CONFIG_ERROR";
    throw e;
  }
  // Parse + schema-validate inside a try: a malformed / schema-invalid project
  // profile maps to CONFIG_ERROR, not an uncoded internal error (exit 3).
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

async function resolveOwnedAdapterPath(cwd: string, relPath: string): Promise<string> {
  try {
    return await resolveOwnedProjectPath(cwd, relPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "PATH_OUTSIDE_PROJECT" || code === "PATH_NOT_OWNED") {
      const e = new Error((err as Error).message);
      (e as NodeJS.ErrnoException).code = "CONFIG_ERROR";
      throw e;
    }
    throw err;
  }
}

async function loadModelProfiles(cwd: string): Promise<ModelProfile[]> {
  let entries: string[];
  try {
    // Contain the DIRECTORY before enumerating it (no out-of-project readdir on a
    // symlinked model-profiles). Optional source → unsafe/missing dir is [].
    const dir = await resolveWithinProject(cwd, ".code-pact/model-profiles");
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const profiles: ModelProfile[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".yaml")) continue;
    try {
      // Contain the read so a symlinked model-profiles dir / file can't read out
      // of the project; all inside the try so an unreadable / out-of-project /
      // malformed entry is skipped, never an uncoded errno crash (exit 3).
      const abs = await resolveWithinProject(
        cwd,
        [".code-pact", "model-profiles", entry].join("/"),
      );
      const raw = await readFile(abs, "utf8");
      profiles.push(ModelProfile.parse(parseYaml(raw) as unknown));
    } catch {
      // skip unreadable / malformed / out-of-project
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
    const err = new Error(`No adapter implementation for agent "${agentName}".`);
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

  const [profile, modelProfiles] = await Promise.all([
    loadAgentProfile(cwd, agentName),
    loadModelProfiles(cwd),
  ]);

  // Effective model version for GENERATION, computed WITHOUT persisting it.
  // `--check` never pins (and the CLI rejects `--check --model`); `--write` pins
  // `--model`, but the pin is a profile write deferred until AFTER the path-safety
  // preflight below, so a doomed `--write` never strands a pinned `model_version`.
  // validateModelVersionInput is pure and fails fast (CONFIG_ERROR) on an unknown
  // `--model` in both modes. (Matches resolveAndPinModelVersion's own resolution.)
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

  const existingByPath = new Map<string, ManifestFile>(
    existingManifest.files.map((f) => [f.path, f]),
  );

  // Fail-closed path-safety PREFLIGHT for both --check and --write. It is
  // read-only, and in check mode it prevents a directory/FIFO/socket at a
  // desired or orphan path from reaching readFileMaybe as an uncoded errno or
  // blocking read. In write mode it still runs before the first mutation.
  await assertAdapterWritePathsContained(cwd, [
    { path: profile.context_dir, kind: "directory" },
    ...(profile.hook_dir ? [{ path: profile.hook_dir, kind: "directory" as const }] : []),
    { path: manifestRelPath(agentName), kind: "file" },
    ...desiredFiles.map((d) => ({ path: d.path, kind: "file" as const })),
    ...[...existingByPath.keys()].map((p) => ({ path: p, kind: "file" as const })),
  ]);

  const plan: AdapterUpgradePlanEntry[] = [];
  const newManifestFiles: ManifestFile[] = [];
  const desiredApply: Array<{
    desired: (typeof desiredFiles)[number];
    absPath: string;
    action: FileAction;
  }> = [];
  const orphanApply: Array<{ absPath: string; action: FileAction }> = [];

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
    let action = decideAction({
      local: cls.local,
      desired: cls.desired,
      mode: mode === "check" ? "upgrade-check" : "upgrade-write",
      force: effectiveForce,
      acceptModified,
    });

    // SECURITY (CWE-345/CWE-22/CWE-59): same gate as `adapter install`. A content
    // OVERWRITE of an existing divergent file (`update` / `replace_unmanaged`) is
    // authorized ONLY when BOTH: the GENERATED path is in the trusted static owned
    // set, AND the path traverses no symlink (an in-project symlink would make the
    // owned-looking lexical path resolve to a different real file). Applied in
    // BOTH modes so `--check` previews the refusal that `--write` would take.
    // `refuse` from decideAction is managed-modified × stale (a local edit).
    let refuseReason: string | undefined =
      action === "refuse" ? "managed_modified" : undefined;
    if (action === "update" || action === "replace_unmanaged") {
      const owned = descriptor.ownedPathGlobs.some((g) => matchGlob(g, desired.path));
      if (!owned) {
        action = "refuse";
        refuseReason = "unowned_generated_path";
      }
    }
    if (action !== "refuse" && await pathTraversesSymlink(cwd, desired.path)) {
      action = "refuse";
      refuseReason = "symlink_traversal";
    }

    plan.push({
      path: absPath,
      relPath: desired.path,
      role: desired.role,
      local: cls.local,
      desired: cls.desired,
      action,
      ...(refuseReason ? { reason: refuseReason } : {}),
    });

    if (mode === "check") {
      // Read-only — no I/O, no manifest changes. We still need to decide
      // what hash WOULD go into the new manifest, but we don't write it.
      continue;
    }

    desiredApply.push({ desired, absPath, action });
    let recordedHash: string | null = null;

    if (action === "write" || action === "replace_unmanaged" || action === "update") {
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
  const desiredPaths = new Set(desiredFiles.map((d) => d.path));
  for (const [relPath, entry] of existingByPath) {
    if (desiredPaths.has(relPath)) continue; // still emitted — handled above
    assertSafeRelativePath(relPath);
    const absPath = await resolveWithinProject(cwd, relPath);
    const diskContent = await readFileMaybe(absPath);
    if (diskContent === null) continue; // managed-missing: nothing on disk to prune

    const diskHash = computeContentHash(diskContent);
    const isClean = diskHash === entry.sha256;

    // SECURITY (CWE-73): the manifest is project-controlled and unauthenticated.
    // Deleting a file just because a manifest entry claims it is "managed" turns
    // `upgrade --write` into an arbitrary in-project delete: a forged manifest
    // entry (any in-project path + that file's real sha256) would be pruned as a
    // managed-clean orphan. So we only AUTO-PRUNE an orphan whose path is in the
    // adapter descriptor's OWNED path set — the generator's own namespace, kept
    // deliberately narrow. An orphan OUTSIDE that set is never deleted, even when
    // managed-clean: we surface it (`warn`) and keep tracking it so the user can
    // remove it deliberately. An owned managed-MODIFIED orphan is still refused
    // so a local edit is never destroyed.
    const isOwned = descriptor.ownedPathGlobs.some((g) => matchGlob(g, relPath));
    // SECURITY (CWE-59/CWE-61): even an OWNED orphan path must not be auto-rm'd if
    // it traverses a symlink. `.claude/skills -> ../src` makes the owned-looking
    // `.claude/skills/context.md` resolve to `src/context.md`, so an unconditional
    // `rm` would delete an out-of-namespace real file. A symlinked owned path is
    // refused (kept + surfaced), never auto-pruned.
    const traversesSymlink = await pathTraversesSymlink(cwd, relPath);
    const action: FileAction = !isOwned
      ? "warn"
      : traversesSymlink || !isClean
        ? "refuse"
        : "prune";

    plan.push({
      path: absPath,
      relPath,
      role: entry.role,
      local: isClean ? "managed-clean" : "managed-modified",
      desired: "stale", // generator no longer emits this path
      action,
      // Machine-readable reason: `warn` = unowned orphan kept on disk; `refuse` =
      // a symlinked owned orphan (would delete the real target) or a local edit.
      ...(action === "warn"
        ? { reason: "unowned_orphan_not_pruned" }
        : action === "refuse"
          ? { reason: traversesSymlink ? "symlink_traversal" : "managed_modified" }
          : {}),
    });

    if (mode === "check") continue; // read-only

    orphanApply.push({ absPath, action });
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

  const clean = plan.every((p) => p.action === "skip");

  // Build the result + (for --write) write the manifest.
  const generatorVersion =
    generatorVersionOverride ?? (await readPackageVersion());
  const resolvedModel = resolvedModelVersion;

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

  if (plan.some((p) => p.action === "refuse")) {
    return {
      agentName,
      mode,
      manifestPath: join(cwd, ".code-pact", "adapters", `${agentName}.manifest.yaml`),
      generatorVersion,
      clean,
      plan,
    };
  }

  await resolveAndPinModelVersion({
    cwd,
    agentName,
    profile,
    modelVersionInput: modelVersion,
  });

  await mkdir(await resolveOwnedAdapterPath(cwd, profile.context_dir), { recursive: true });
  if (profile.hook_dir) {
    await mkdir(await resolveOwnedAdapterPath(cwd, profile.hook_dir), { recursive: true });
  }

  for (const item of desiredApply) {
    if (item.action === "write" || item.action === "replace_unmanaged" || item.action === "update") {
      await mkdir(dirname(item.absPath), { recursive: true });
      await atomicWriteText(item.absPath, item.desired.content);
    }
  }
  for (const item of orphanApply) {
    if (item.action === "prune") await rm(item.absPath, { force: true });
  }

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
  const profile = await loadAgentProfile(cwd, agentName);
  return { profileRel, drift: detectModelMapDrift(profile.model_map) };
}
