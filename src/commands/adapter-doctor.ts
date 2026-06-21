import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { AgentProfile } from "../core/schemas/agent-profile.ts";
import { ModelProfile } from "../core/schemas/model-profile.ts";
import { Project } from "../core/schemas/project.ts";
import { adapterRegistry } from "../core/adapters/index.ts";
import { classifyManifestFileForRead } from "../core/adapters/manifest-file-ownership.ts";
import { isSupportedAgent, type SupportedAgent } from "../core/agents.ts";
import { resolveAgentProfilePath } from "../core/agent-profile-path.ts";
import { resolveWithinProject } from "../core/path-safety.ts";
import {
  computeContentHash,
  manifestPath,
  readManifest,
} from "../core/adapters/manifest.ts";
import { classifyFileState } from "../core/adapters/file-state.ts";
import { dedupeDesiredFiles } from "../core/adapters/desired.ts";
import { readPackageVersion } from "../lib/package-version.ts";
import type {
  AdapterManifest,
  ProfileFingerprint,
} from "../core/schemas/adapter-manifest.ts";
import type { DesiredAdapterFile } from "../core/adapters/types.ts";
import type { Locale } from "../i18n/index.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AdapterDoctorIssue = {
  code: string;
  severity: "error" | "warning";
  message: string;
  agent: SupportedAgent;
  /** Absolute path. Set for file-level findings; omitted for whole-agent findings. */
  path?: string;
  /**
   * Optional structured payload — additive on `Record<string, unknown>`,
   * mirroring the `PlanIssue.details` shape used by `plan lint`.
   * `ADAPTER_CONTRACT_DRIFT` carries
   * `{ kind: "section_missing" | "axes_incomplete", missing_axes?: string[] }`.
   * Older issue codes set this to `undefined` and consumers that read
   * only the top-level fields see no shape change.
   */
  details?: Record<string, unknown>;
};

export type AdapterDoctorResult = {
  ok: boolean;
  issues: AdapterDoctorIssue[];
};

export type AdapterDoctorOptions = {
  cwd: string;
  /** If omitted, inspects every enabled agent listed in project.yaml. */
  agentName?: string;
  locale: Locale;
};

// ---------------------------------------------------------------------------
// Loaders (lenient — doctor never throws on absence)
// ---------------------------------------------------------------------------

// Missing project.yaml → null (adapter doctor is a no-op without a project).
// But a present-but-broken project.yaml (unreadable, unparseable, or
// schema-invalid) is surfaced as CONFIG_ERROR rather than masked as "no
// project", so `adapter doctor` doesn't report a clean bill on a broken config.
async function loadProjectSafe(cwd: string): Promise<Project | null> {
  let path: string;
  let raw: string;
  try {
    path = await resolveWithinProject(cwd, ".code-pact/project.yaml");
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    const e = new Error(`Cannot read .code-pact/project.yaml.`);
    (e as NodeJS.ErrnoException).code = "CONFIG_ERROR";
    throw e;
  }
  try {
    return Project.parse(parseYaml(raw) as unknown);
  } catch (err) {
    const e = new Error(`Cannot parse or validate ${path}: ${(err as Error).message}`);
    (e as NodeJS.ErrnoException).code = "CONFIG_ERROR";
    throw e;
  }
}

async function loadAgentProfileSafe(
  cwd: string,
  agentName: string,
): Promise<AgentProfile | null> {
  // Resolve OUTSIDE the try so a CONFIG_ERROR (unparseable project.yaml or an
  // invalid `agents[].profile`) propagates — consistent with the other commands
  // rather than masked as "no profile". Missing/malformed profile *content* is
  // still lenient (null), which the adapter doctor checks surface as issues.
  const path = await resolveAgentProfilePath(cwd, agentName);
  try {
    const raw = await readFile(path, "utf8");
    return AgentProfile.parse(parseYaml(raw) as unknown);
  } catch {
    return null;
  }
}

async function loadModelProfilesSafe(cwd: string): Promise<ModelProfile[]> {
  const dir = await resolveWithinProject(cwd, ".code-pact/model-profiles").catch(() => null);
  if (dir === null) return [];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const profiles: ModelProfile[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".yaml")) continue;
    try {
      const raw = await readFile(
        await resolveWithinProject(cwd, [".code-pact", "model-profiles", entry].join("/")),
        "utf8",
      );
      profiles.push(ModelProfile.parse(parseYaml(raw) as unknown));
    } catch {
      // skip malformed
    }
  }
  return profiles;
}

type ProjectReadResult =
  | { kind: "content"; absPath: string; content: string }
  | { kind: "missing"; absPath: string }
  | { kind: "unsafe"; absPath: string; message: string };

async function readProjectFileForDoctor(
  cwd: string,
  relPath: string,
): Promise<ProjectReadResult> {
  const absPath = join(cwd, relPath);
  let containedPath: string;
  try {
    containedPath = await resolveWithinProject(cwd, relPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "missing", absPath };
    }
    return { kind: "unsafe", absPath, message: (err as Error).message };
  }

  try {
    const s = await stat(containedPath);
    if (!s.isFile()) return { kind: "missing", absPath };
    return {
      kind: "content",
      absPath,
      content: await readFile(containedPath, "utf8"),
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "missing", absPath };
    }
    // Best-effort DIAGNOSTIC read: any failure degrades to null. ENOENT is a
    // missing file; EISDIR (a manifest-declared path that is actually a directory,
    // planted by a hostile repo), ENOTDIR, EACCES, etc. are likewise treated as
    // "not a readable managed file" — surfaced via the existing FILE_MISSING /
    // DRIFT advisories, never re-thrown as an uncoded errno that crashes doctor
    // (exit 3). doctor must report problems, not abort on them.
    return { kind: "missing", absPath };
  }
}

function unsafeAdapterFileIssue(
  agentName: SupportedAgent,
  relPath: string,
  absPath: string,
  message: string,
): AdapterDoctorIssue {
  return {
    code: "ADAPTER_FILE_PATH_UNSAFE",
    severity: "error",
    message: `Managed file "${relPath}" is not a safe project-contained path and was not read: ${message}`,
    agent: agentName,
    path: absPath,
  };
}

function buildCurrentFingerprint(
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

function fingerprintsEqual(a: ProfileFingerprint, b: ProfileFingerprint): boolean {
  return (
    a.instruction_filename === b.instruction_filename &&
    a.context_dir === b.context_dir &&
    (a.skill_dir ?? null) === (b.skill_dir ?? null) &&
    (a.hook_dir ?? null) === (b.hook_dir ?? null) &&
    (a.resolved_model ?? null) === (b.resolved_model ?? null)
  );
}

// ---------------------------------------------------------------------------
// Agent-contract section drift detection
// ---------------------------------------------------------------------------

// Source of truth for the agent contract surface — heading strings
// and required CLI surface mentions live in
// `src/core/adapters/conformance-spec.ts` and are shared with the
// `adapter conformance` command so the two callers can never
// disagree.
import {
  AGENT_CONTRACT_SECTION_HEADING,
  AGENT_CONTRACT_AXIS_HEADINGS,
} from "../core/adapters/conformance-spec.ts";

/**
 * Returns an `ADAPTER_CONTRACT_DRIFT` issue when an instruction file's
 * body lacks the agent-contract section or has it but is missing
 * one or more axis sub-headings. Returns `null` when the section is
 * intact.
 *
 * The detection is intentionally substring-based on the verbatim
 * heading text (no regex, no fuzzy match) — drift in the heading text
 * is itself a contract break. Body content under each
 * axis is not inspected; only the heading presence is locked.
 */
function detectContractDrift(
  agentName: SupportedAgent,
  relPath: string,
  absPath: string,
  diskContent: string,
): AdapterDoctorIssue | null {
  if (!diskContent.includes(AGENT_CONTRACT_SECTION_HEADING)) {
    return {
      code: "ADAPTER_CONTRACT_DRIFT",
      severity: "warning",
      message: `Managed instruction file "${relPath}" is missing the "${AGENT_CONTRACT_SECTION_HEADING}" section. Run "adapter upgrade ${agentName} --write" to apply the v1.7+ template (use --accept-modified to preserve user edits).`,
      agent: agentName,
      path: absPath,
      details: { kind: "section_missing" },
    };
  }

  const missing = AGENT_CONTRACT_AXIS_HEADINGS.filter(
    (heading) => !diskContent.includes(heading),
  );
  if (missing.length > 0) {
    return {
      code: "ADAPTER_CONTRACT_DRIFT",
      severity: "warning",
      message: `Managed instruction file "${relPath}" has the "${AGENT_CONTRACT_SECTION_HEADING}" section but is missing ${missing.length} of ${AGENT_CONTRACT_AXIS_HEADINGS.length} axis sub-heading(s): ${missing.join(", ")}. Run "adapter upgrade ${agentName} --write".`,
      agent: agentName,
      path: absPath,
      details: { kind: "axes_incomplete", missing_axes: missing },
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Issue #340: stamp-only generator_version lag
// ---------------------------------------------------------------------------

/**
 * True when the manifest's recorded file set is byte-identical to what the
 * generator would produce right now — i.e. a `generator_version` mismatch is a
 * pure version-stamp lag, not real adapter-content drift.
 *
 * The comparison is intentionally narrow (Issue #340): it looks ONLY at the
 * desired file content and path set, never at `generator_version` /
 * `generated_at` (the version stamp is exactly what we are trying to discount).
 *
 *  - Path sets must match exactly. A desired file the manifest never recorded,
 *    or a manifest path the generator no longer produces, both count as a
 *    mismatch — these are the new-path / orphan-path cases that the manifest-
 *    iterating file-level checks below would otherwise miss.
 *  - Every desired file's content hash must equal the manifest entry's sha256
 *    at the same path.
 *
 * `desiredFiles` is run through `dedupeDesiredFiles` first, mirroring the
 * install/upgrade engines, so the path set we compare is the same converged
 * set those engines would write — not the raw generator output.
 *
 * Returns `false` (conservative: keep the warning) if dedup throws, so a
 * generator regression that can't even produce a clean desired set never gets
 * silently waved through as "equivalent".
 */
function desiredEquivalentToManifest(
  manifest: AdapterManifest,
  desiredFiles: readonly DesiredAdapterFile[],
): boolean {
  let deduped: DesiredAdapterFile[];
  try {
    deduped = dedupeDesiredFiles(desiredFiles);
  } catch {
    return false;
  }

  if (deduped.length !== manifest.files.length) return false;

  const manifestHashByPath = new Map(
    manifest.files.map((f) => [f.path, f.sha256]),
  );
  if (manifestHashByPath.size !== manifest.files.length) return false; // dup paths

  for (const desired of deduped) {
    const manifestHash = manifestHashByPath.get(desired.path);
    if (manifestHash === undefined) return false; // desired path absent from manifest
    if (computeContentHash(desired.content) !== manifestHash) return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Per-agent inspection (exported so the global doctor can reuse it)
// ---------------------------------------------------------------------------

export type InspectAgentOptions = {
  cwd: string;
  agentName: SupportedAgent;
  locale: Locale;
  /** True when the agent appears under project.yaml `agents:` with enabled != false. */
  enabled: boolean;
  /** Current code-pact package version (for ADAPTER_GENERATOR_STALE). */
  packageVersion: string;
};

export async function inspectAgent(
  opts: InspectAgentOptions,
): Promise<AdapterDoctorIssue[]> {
  const { cwd, agentName, locale, enabled, packageVersion } = opts;
  const issues: AdapterDoctorIssue[] = [];

  // ---- Read manifest ----
  let manifest: AdapterManifest | null;
  try {
    manifest = await readManifest(cwd, agentName);
  } catch (err) {
    issues.push({
      code: "ADAPTER_MANIFEST_INVALID",
      severity: "error",
      message: `Manifest at ${manifestPath(cwd, agentName)} failed to parse: ${(err as Error).message}`,
      agent: agentName,
      path: manifestPath(cwd, agentName),
    });
    return issues;
  }

  if (manifest === null) {
    // Missing-manifest is a soft signal only for agents that are enabled.
    // Adapters present in the registry but not listed under project.yaml
    // are not expected to have a manifest, so we stay quiet.
    if (enabled) {
      issues.push({
        code: "ADAPTER_MANIFEST_MISSING",
        severity: "warning",
        message: `Agent "${agentName}" has no manifest — run "code-pact adapter install ${agentName}"`,
        agent: agentName,
        path: manifestPath(cwd, agentName),
      });
    }
    return issues;
  }

  // ---- Manifest present: version + schema + fingerprint drift ----
  const descriptor = adapterRegistry[agentName];

  // ADAPTER_GENERATOR_STALE (Issue #340) is decided AFTER desired files are
  // generated, inside the `profile` block below — a version-stamp mismatch is
  // only worth reporting when the desired adapter output actually differs from
  // the manifest. The flag is hoisted here so the version check reads in the
  // same place as the schema/fingerprint checks; it is resolved once we know
  // whether the desired output is byte-identical (stamp-only lag → silent).
  const versionStale = manifest.generator_version !== packageVersion;

  if (manifest.adapter_schema_version < descriptor.adapterSchemaVersion) {
    issues.push({
      code: "ADAPTER_SCHEMA_DRIFT",
      severity: "warning",
      message: `Manifest adapter_schema_version is ${manifest.adapter_schema_version} but the adapter module declares ${descriptor.adapterSchemaVersion}.`,
      agent: agentName,
      path: manifestPath(cwd, agentName),
    });
  }

  const profile = await loadAgentProfileSafe(cwd, agentName);

  if (profile) {
    const modelProfiles = await loadModelProfilesSafe(cwd);
    const resolvedModel = profile.model_version;
    const currentFP = buildCurrentFingerprint(profile, resolvedModel);
    if (!fingerprintsEqual(manifest.profile_fingerprint, currentFP)) {
      issues.push({
        code: "ADAPTER_PROFILE_DRIFT",
        severity: "warning",
        message: `Agent profile fields used by the adapter have changed since the last install.`,
        agent: agentName,
        path: manifestPath(cwd, agentName),
      });
    }

    // ---- File-level checks ----
    const desiredFiles = await descriptor.generateDesiredFiles({
      cwd,
      profile,
      modelProfiles,
      locale,
      modelVersion: profile.model_version,
    });

    // Issue #340: a generator_version mismatch only earns ADAPTER_GENERATOR_STALE
    // when the desired output is NOT byte-identical to the manifest. A pure
    // version-stamp lag (patch bump that changes no managed file) stays silent —
    // running `adapter upgrade --write` would only re-stamp generator_version /
    // generated_at, which is not drift worth nagging about.
    if (versionStale && !desiredEquivalentToManifest(manifest, desiredFiles)) {
      issues.push({
        code: "ADAPTER_GENERATOR_STALE",
        severity: "warning",
        message: `Manifest generator_version is "${manifest.generator_version}" but the current code-pact version is "${packageVersion}", and the generated adapter output no longer matches the manifest. Run "adapter upgrade ${agentName} --write".`,
        agent: agentName,
        path: manifestPath(cwd, agentName),
      });
    }

    const desiredByPath = new Map(desiredFiles.map((f) => [f.path, f]));

    for (const entry of manifest.files) {
      // SECURITY (forged-manifest content/SHA oracle): the manifest is
      // project-supplied. Refuse to read — and to hash or run contract-heading
      // inspection on — any entry naming a path this adapter could not have
      // generated. A forged `path: .env` is `unowned` → reported, never read,
      // never hashed; `role: instruction, path: .env` never reaches
      // detectContractDrift. Gated by the SAME trusted authority the writer
      // uses (writePathGlobs ?? ownedPathGlobs) + the owned-path symlink guard.
      const ownership = await classifyManifestFileForRead(cwd, descriptor, entry.path);
      if (ownership.kind !== "owned") {
        issues.push(
          unsafeAdapterFileIssue(
            agentName as SupportedAgent,
            entry.path,
            join(cwd, entry.path),
            ownership.kind === "unsafe"
              ? "resolves through a symlink or escapes the project root"
              : "is not a path this adapter generates (forged-manifest guard)",
          ),
        );
        continue;
      }
      const diskRead = await readProjectFileForDoctor(cwd, entry.path);
      const absPath = diskRead.absPath;
      if (diskRead.kind === "unsafe") {
        issues.push(
          unsafeAdapterFileIssue(
            agentName as SupportedAgent,
            entry.path,
            absPath,
            diskRead.message,
          ),
        );
        continue;
      }
      const diskContent =
        diskRead.kind === "content" ? diskRead.content : null;
      const diskHash =
        diskContent === null ? null : computeContentHash(diskContent);
      const desired = desiredByPath.get(entry.path);
      const desiredHash =
        desired === undefined ? null : computeContentHash(desired.content);

      const cls = classifyFileState({
        manifestHash: entry.sha256,
        diskHash,
        desiredHash,
      });

      if (cls.local === "managed-missing") {
        issues.push({
          code: "ADAPTER_FILE_MISSING",
          severity: "error",
          message: `Managed file "${entry.path}" is missing from disk`,
          agent: agentName,
          path: absPath,
        });
      } else if (cls.local === "managed-modified" && cls.desired === "stale") {
        issues.push({
          code: "ADAPTER_FILE_DRIFT",
          severity: "warning",
          message: `Managed file "${entry.path}" has been locally modified and the generator output also moved on. Re-run "adapter upgrade ${agentName} --write --accept-modified" to overwrite local changes.`,
          agent: agentName,
          path: absPath,
        });
      } else if (cls.local === "managed-clean" && cls.desired === "stale") {
        issues.push({
          code: "ADAPTER_DESIRED_STALE",
          severity: "warning",
          message: `Managed file "${entry.path}" is unchanged locally but the generator now produces different content. Re-run "adapter upgrade ${agentName} --write".`,
          agent: agentName,
          path: absPath,
        });
      }
      // managed-modified × current → silent (manifest-only drift; not a doctor concern)
      // managed-clean × current → silent (happy path)

      // Agent-contract section drift.
      //
      // Independent of the file-level drift signals above. Fires when the
      // instruction file is present on disk but its `## Agent contract`
      // section is missing or its three axis sub-headings are
      // incomplete — typically because the file was generated by an
      // older code-pact version. Severity stays `warning` (soft
      // signal — never gates the overall doctor exit code; the
      // existing `ADAPTER_FILE_DRIFT` and friends still own that
      // signal). Resolution: `code-pact adapter upgrade <agent>
      // --write --accept-modified` reinstates the section while
      // preserving any user edits.
      if (entry.role === "instruction" && diskContent !== null) {
        const contractIssue = detectContractDrift(
          agentName as SupportedAgent,
          entry.path,
          absPath,
          diskContent,
        );
        if (contractIssue !== null) issues.push(contractIssue);
      }
    }

    // ---- Orphan scan ----
    const manifestPaths = new Set(manifest.files.map((f) => f.path));
    for (const glob of descriptor.ownedPathGlobs) {
      const candidates = await listOwnedCandidates(cwd, glob);
      for (const rel of candidates) {
        if (manifestPaths.has(rel)) continue;
        issues.push({
          code: "ADAPTER_UNMANAGED_FILE",
          severity: "warning",
          message: `"${rel}" sits under a code-pact-owned namespace but is not in the manifest`,
          agent: agentName,
          path: join(cwd, rel),
        });
      }
    }
  } else if (versionStale) {
    // No agent profile → the generator cannot produce desired files, so we
    // cannot prove the output is byte-identical. Stay conservative (Issue #340)
    // and keep the legacy version-stamp warning rather than silently suppress.
    issues.push({
      code: "ADAPTER_GENERATOR_STALE",
      severity: "warning",
      message: `Manifest generator_version is "${manifest.generator_version}" but the current code-pact version is "${packageVersion}".`,
      agent: agentName,
      path: manifestPath(cwd, agentName),
    });
  }

  return issues;
}

/**
 * Resolves `ownedPathGlobs` entries to project-relative POSIX paths that
 * exist on disk. Two forms are supported intentionally:
 *  - exact path: returned if the file exists
 *  - single-wildcard basename: directory part listed and entries matched
 *    by prefix+suffix around the `*` (e.g. `.claude/skills/code-pact-*.md`)
 *
 * Broad multi-segment globs (`.claude/skills/**`) are not supported, by
 * design — narrow ownedPathGlobs is the safety invariant that keeps
 * doctor from flagging user-created files like `.claude/skills/custom.md`.
 */
async function listOwnedCandidates(
  cwd: string,
  glob: string,
): Promise<string[]> {
  if (!glob.includes("*")) {
    const exists = await readProjectFileForDoctor(cwd, glob);
    return exists.kind === "content" ? [glob] : [];
  }
  const slash = glob.lastIndexOf("/");
  const dir = slash >= 0 ? glob.slice(0, slash) : ".";
  const pattern = slash >= 0 ? glob.slice(slash + 1) : glob;
  const star = pattern.indexOf("*");
  if (star < 0) return [];
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);

  let entries: string[];
  try {
    entries = await readdir(dir === "." ? cwd : await resolveWithinProject(cwd, dir));
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (!entry.startsWith(prefix) || !entry.endsWith(suffix)) continue;
    if (entry.length < prefix.length + suffix.length) continue; // overlap
    out.push(dir === "." ? entry : `${dir}/${entry}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public runner
// ---------------------------------------------------------------------------

export async function runAdapterDoctor(
  opts: AdapterDoctorOptions,
): Promise<AdapterDoctorResult> {
  const { cwd, agentName, locale } = opts;

  if (agentName !== undefined && !isSupportedAgent(agentName)) {
    const err = new Error(`No adapter implementation for agent "${agentName}".`);
    (err as NodeJS.ErrnoException).code = "AGENT_NOT_FOUND";
    throw err;
  }

  const packageVersion = await readPackageVersion();
  const project = await loadProjectSafe(cwd);
  const enabledNames = new Set<SupportedAgent>();
  if (project) {
    for (const a of project.agents) {
      if (a.enabled !== false && isSupportedAgent(a.name)) {
        enabledNames.add(a.name);
      }
    }
  }

  // Target set:
  //  - With --agent: just that agent, regardless of enabled state.
  //  - Without --agent: every enabled agent. A *missing* project.yaml → no
  //    targets → { ok: true, issues: [] } (no-op); a present-but-broken
  //    project.yaml already threw CONFIG_ERROR in loadProjectSafe above.
  const targets: SupportedAgent[] = agentName
    ? [agentName as SupportedAgent]
    : [...enabledNames];

  const issues: AdapterDoctorIssue[] = [];
  for (const name of targets) {
    const isEnabled = enabledNames.has(name);
    const found = await inspectAgent({
      cwd,
      agentName: name,
      locale,
      enabled: isEnabled,
      packageVersion,
    });
    issues.push(...found);
  }

  const ok = issues.every((i) => i.severity !== "error");
  return { ok, issues };
}
