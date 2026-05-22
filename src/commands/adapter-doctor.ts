import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { AgentProfile } from "../core/schemas/agent-profile.ts";
import { ModelProfile } from "../core/schemas/model-profile.ts";
import { Project } from "../core/schemas/project.ts";
import { adapterRegistry } from "../core/adapters/index.ts";
import { isSupportedAgent, type SupportedAgent } from "../core/agents.ts";
import {
  computeContentHash,
  manifestPath,
  readManifest,
} from "../core/adapters/manifest.ts";
import { classifyFileState } from "../core/adapters/file-state.ts";
import { readPackageVersion } from "../lib/package-version.ts";
import type {
  AdapterManifest,
  ProfileFingerprint,
} from "../core/schemas/adapter-manifest.ts";
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
   * `ADAPTER_CONTRACT_DRIFT` (v1.7 P16-T5) carries
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

async function loadProjectSafe(cwd: string): Promise<Project | null> {
  try {
    const raw = await readFile(join(cwd, ".code-pact", "project.yaml"), "utf8");
    return Project.parse(parseYaml(raw) as unknown);
  } catch {
    return null;
  }
}

async function loadAgentProfileSafe(
  cwd: string,
  agentName: string,
): Promise<AgentProfile | null> {
  try {
    const raw = await readFile(
      join(cwd, ".code-pact", "agent-profiles", `${agentName}.yaml`),
      "utf8",
    );
    return AgentProfile.parse(parseYaml(raw) as unknown);
  } catch {
    return null;
  }
}

async function loadModelProfilesSafe(cwd: string): Promise<ModelProfile[]> {
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
    try {
      const raw = await readFile(join(dir, entry), "utf8");
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
// v1.7 P16-T5: Agent-contract section drift detection
// ---------------------------------------------------------------------------

/**
 * The verbatim, English-locked heading strings the conformance test
 * (P16-T4) and this diagnostic both anchor on. Source of truth lives
 * in `design/decisions/agent-contract-rfc.md`. Adapter templates emit
 * these via `messageCatalog[locale].templates.adapterCommon.agentContract.*`.
 */
const AGENT_CONTRACT_SECTION_HEADING = "## Agent contract";
const AGENT_CONTRACT_AXIS_HEADINGS: ReadonlyArray<string> = [
  "### When to invoke code-pact",
  "### What to verify first",
  "### How to handle failures",
];

/**
 * Returns an `ADAPTER_CONTRACT_DRIFT` issue when an instruction file's
 * body lacks the v1.7+ agent-contract section or has it but is missing
 * one or more axis sub-headings. Returns `null` when the section is
 * intact.
 *
 * The detection is intentionally substring-based on the verbatim
 * heading text (no regex, no fuzzy match) — drift in the heading text
 * is itself a contract break per the RFC. Body content under each
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

  if (manifest.generator_version !== packageVersion) {
    issues.push({
      code: "ADAPTER_GENERATOR_STALE",
      severity: "warning",
      message: `Manifest generator_version is "${manifest.generator_version}" but the current code-pact version is "${packageVersion}".`,
      agent: agentName,
      path: manifestPath(cwd, agentName),
    });
  }

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
    const desiredByPath = new Map(desiredFiles.map((f) => [f.path, f]));

    for (const entry of manifest.files) {
      const absPath = join(cwd, entry.path);
      const diskContent = await readFileMaybe(absPath);
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

      // v1.7 P16-T5: agent-contract section drift.
      //
      // Independent of the file-level drift signals above. Fires when the
      // instruction file is present on disk but its `## Agent contract`
      // section is missing or its three axis sub-headings are
      // incomplete — typically because the file was generated by a
      // pre-P16 code-pact version. Severity stays `warning` (soft
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
  }

  return issues;
}

/**
 * Resolves `ownedPathGlobs` entries to project-relative POSIX paths that
 * exist on disk. v0.9 supports two forms intentionally:
 *  - exact path: returned if the file exists
 *  - single-wildcard basename: directory part listed and entries matched
 *    by prefix+suffix around the `*` (e.g. `.claude/skills/code-pact-*.md`)
 *
 * Broad multi-segment globs (`.claude/skills/**`) are not supported, by
 * design — narrow ownedPathGlobs is the v0.9 safety invariant that keeps
 * doctor from flagging user-created files like `.claude/skills/custom.md`.
 */
async function listOwnedCandidates(
  cwd: string,
  glob: string,
): Promise<string[]> {
  if (!glob.includes("*")) {
    const exists = await readFileMaybe(join(cwd, glob));
    return exists !== null ? [glob] : [];
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
    entries = await readdir(join(cwd, dir));
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
  //  - Without --agent: every enabled agent (no project.yaml → no targets,
  //    result is { ok: true, issues: [] } — adapter doctor is a no-op).
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
