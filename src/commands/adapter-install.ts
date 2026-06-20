import { readFile, readdir, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
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
  classifyFileState,
  decideAction,
  pathTraversesSymlink,
  resolveWithinProject,
  type FileAction,
} from "../core/adapters/file-state.ts";
import { resolveOwnedProjectPath } from "../core/path-safety.ts";
import {
  computeContentHash,
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

export type AdapterInstallFile = {
  /** Absolute path. */
  path: string;
  /** Project-relative POSIX path (what gets recorded in the manifest). */
  relPath: string;
  role: DesiredAdapterFileRole;
  action: FileAction;
  /** Set when `action === "refuse"`; drives the CLI's remediation message. */
  reason?: RefuseReason;
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
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      const e = new Error(`Agent profile for "${agentName}" not found at ${path}.`);
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
    (existingManifest?.files ?? []).map((f) => [f.path, f]),
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
  // dirs AND every generated file for BOTH containment (symlink escape / dangling
  // → PATH_OUTSIDE_PROJECT) AND on-disk TYPE (a dir spec that is really a file,
  // or a file spec that is really a directory → CONFIG_ERROR). Either aborts the
  // install here — no pin, no write — instead of failing the later mkdir/write
  // AFTER the `--model` pin. The CLI maps PATH_OUTSIDE_PROJECT → CONFIG_ERROR.
  await assertAdapterWritePathsContained(cwd, [
    { path: profile.context_dir, kind: "directory" },
    ...(profile.hook_dir ? [{ path: profile.hook_dir, kind: "directory" as const }] : []),
    ...desiredFiles.map((d) => ({ path: d.path, kind: "file" as const })),
  ]);

  // Preflight passed — this is the MINIMUM-MUTATION point to PERSIST the `--model`
  // pin: the manifest read and the containment+type preflight both fail closed,
  // so no containment/type failure can strand a pin afterwards. (This is NOT a
  // crash-atomic guarantee: a process death between the pin and the manifest
  // write below, or a runtime fault like ENOSPC during a write, can still leave
  // the profile pinned ahead of the manifest — `adapter doctor` reports that
  // drift.) The mkdirs below are idempotent, in-project, and benign.
  await resolveAndPinModelVersion({
    cwd,
    agentName,
    profile,
    modelVersionInput: modelVersion,
  });

  // Directory placeholders (verified safe in the preflight above).
  await mkdir(await resolveOwnedAdapterPath(cwd, profile.context_dir), { recursive: true });
  if (profile.hook_dir) {
    await mkdir(await resolveOwnedAdapterPath(cwd, profile.hook_dir), { recursive: true });
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
    let action = decideAction({
      local: cls.local,
      desired: cls.desired,
      mode: "install",
      force: effectiveForce,
      acceptModified: false,
    });

    // SECURITY (CWE-345/CWE-22/CWE-59): a content OVERWRITE of an EXISTING,
    // divergent file (`update` = managed-clean × stale; `replace_unmanaged` =
    // unmanaged × stale with --force) must NOT be authorized by the project-
    // supplied manifest hash or profile path alone — both are attacker-controlled.
    // Refuse unless BOTH hold:
    //   1. the GENERATED path is in the TRUSTED static owned set (a profile
    //      redirecting instruction_filename/skill_dir at e.g. package.json, or a
    //      shared `.claude/skills/<user>.md`, is outside it), AND
    //   2. the path traverses NO symlink — else an in-project symlink (e.g.
    //      `.claude/skills -> ../src`) makes the owned-looking lexical path
    //      resolve to a DIFFERENT real file, so the glob match is not ownership.
    // `refuse` from decideAction is the managed-modified × stale local-edit case.
    let refuseReason: RefuseReason | undefined =
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

    fileResults.push({
      path: absPath,
      relPath: desired.path,
      role: desired.role,
      action,
      ...(refuseReason ? { reason: refuseReason } : {}),
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
