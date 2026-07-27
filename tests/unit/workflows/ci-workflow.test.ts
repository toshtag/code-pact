import { describe, it, expect } from "vitest";
import {
  readFileSync,
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  rmSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { parseDocument } from "yaml";

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const workflowPath = join(repoRoot, ".github", "workflows", "ci.yml");

function readWorkflow(): string {
  return readFileSync(workflowPath, "utf8");
}

function jobIf(content: string, jobName: string): string | null {
  const doc = parseDocument(content).toJSON() as {
    jobs?: Record<string, { if?: string }>;
  } | null;
  return doc?.jobs?.[jobName]?.if ?? null;
}

function collectRunScripts(content: string, jobName: string): string[] {
  const doc = parseDocument(content);
  const jobs = doc.get("jobs") as {
    items: Array<{
      key: { value?: unknown };
      value: { get: (k: string) => unknown } | null;
    }>;
  } | null;
  if (!jobs || !jobs.items) return [];
  for (const jobPair of jobs.items) {
    const key = String(jobPair.key.value ?? jobPair.key);
    if (key !== jobName) continue;
    const job = jobPair.value;
    if (!job) return [];
    const steps = job.get("steps") as {
      items: Array<{ get: (k: string) => unknown }>;
    } | null;
    if (!steps || !steps.items) return [];
    const scripts: string[] = [];
    for (const step of steps.items) {
      const run = step.get("run");
      if (typeof run === "string") scripts.push(run);
    }
    return scripts;
  }
  return [];
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function jobOutputs(content: string, jobName: string): string[] {
  const doc = parseDocument(content);
  const jobs = doc.get("jobs") as {
    items: Array<{
      key: { value?: unknown };
      value: { get: (k: string) => unknown } | null;
    }>;
  } | null;
  if (!jobs || !jobs.items) return [];
  for (const jobPair of jobs.items) {
    const key = String(jobPair.key.value ?? jobPair.key);
    if (key !== jobName) continue;
    const job = jobPair.value;
    if (!job) return [];
    const outputs = job.get("outputs") as {
      items: Array<{ key: { value?: unknown }; value: unknown }>;
    } | null;
    if (!outputs || !outputs.items) return [];
    return outputs.items.map(pair => String(pair.key.value ?? pair.key));
  }
  return [];
}

describe("ci.yml topology", () => {
  const content = readWorkflow();

  it("classify job emits base_ref for the standard gate", () => {
    expect(jobOutputs(content, "classify")).toContain("base_ref");
  });

  it("classify job emits fallback_full and plan_json", () => {
    const outputs = jobOutputs(content, "classify");
    expect(outputs).toContain("fallback_full");
    expect(outputs).toContain("mode");
    expect(outputs).toContain("plan_json");
  });

  it("classify job generates a base64-encoded verification plan", () => {
    const scripts = collectRunScripts(content, "classify");
    const script = scripts.join("\n");
    expect(script).toContain("--plan");
    expect(script).toMatch(/base64\s+-w0/);
    expect(script).toMatch(/plan_json=.*>>\s*"\$GITHUB_OUTPUT"/);
  });

  it("classify job derives missing mode and fallback reason from the trusted plan", () => {
    const scripts = collectRunScripts(content, "classify");
    const script = scripts.join("\n");
    expect(script).toMatch(/grep -q '\^fallback_full='\s*"\$GITHUB_OUTPUT"/);
    expect(script).toContain("fallback_full=true");
    expect(script).toMatch(/p\.mode/);
    expect(script).toContain("legacy_trusted_classifier");
  });

  it("classify job copies the classifier and its lib dependency into a temporary tree", () => {
    const scripts = collectRunScripts(content, "classify");
    const script = scripts.join("\n");
    expect(script).toMatch(/trusted_root=.*RUNNER_TEMP\/trusted-classifier/);
    expect(script).toContain("scripts/verification-scope.mjs");
    expect(script).toContain("scripts/lib/run-bounded-process.mjs");
    expect(script).toContain('node "$trusted_classifier"');
  });

  it("standard job runs on push or when classify standard is true", () => {
    const ifExpr = jobIf(content, "standard");
    expect(ifExpr).toMatch(/github\.event_name\s*==\s*['"]push['"]/);
    expect(ifExpr).toMatch(
      /needs\.classify\.outputs\.standard\s*==\s*['"]true['"]/,
    );
  });

  it("docs job only runs for docs-only pull requests", () => {
    const ifExpr = jobIf(content, "docs");
    expect(ifExpr).toMatch(/github\.event_name\s*==\s*['"]pull_request['"]/);
    expect(ifExpr).toMatch(
      /needs\.classify\.outputs\.standard\s*!=\s*['"]true['"]/,
    );
  });

  it("PR standard job runs verification through the trusted base classifier", () => {
    const scripts = collectRunScripts(content, "standard");
    const planScript = scripts.find(s => s.includes("trusted-verification"));
    expect(planScript).toBeDefined();
    expect(planScript).toMatch(/plan_json=/);
    expect(planScript).toMatch(/base64\s+-d/);
    expect(planScript).toContain('git show "$BASE_REF:scripts/verification-scope.mjs"');
    expect(planScript).toContain('node "$trusted_classifier" --base "$BASE_REF" --run');
    expect(planScript).not.toContain("node scripts/verification-scope.mjs --run-plan");
    expect(planScript).not.toMatch(/pnpm\s+test:ci/);
  });

  it("PR standard job compares trusted plan digests before execution", () => {
    const scripts = collectRunScripts(content, "standard");
    const planScript = scripts.find(s => s.includes("trusted-verification"));
    expect(planScript).toBeDefined();
    expect(planScript).toContain('node "$trusted_classifier" --base "$BASE_REF" --plan');
    expect(planScript).toContain("trusted verification plan digest mismatch");
  });

  it("main push runs one full gate instead of the pull-request plan", () => {
    const scripts = collectRunScripts(content, "standard");
    const planScript = scripts.find(s => s.includes("trusted-verification"));
    expect(planScript).toMatch(/GITHUB_EVENT_NAME.*push/s);
    const fullIndex =
      planScript?.indexOf(
        'node scripts/verification-scope.mjs --base "$BASE_REF" --force-full --run',
      ) ?? -1;
    const planIndex =
      planScript?.indexOf(
        'node "$trusted_classifier" --base "$BASE_REF" --run',
      ) ?? -1;
    expect(fullIndex).toBeGreaterThanOrEqual(0);
    expect(planIndex).toBeGreaterThan(fullIndex);
  });

  it("base classifier absence uses a workflow-fixed full gate", () => {
    const scripts = collectRunScripts(content, "standard");
    const planScript = scripts.find(s => s.includes("trusted-verification"));
    expect(planScript).toContain("pnpm check:supply-chain");
    expect(planScript).toContain("pnpm typecheck");
    expect(planScript).toContain("pnpm test:unit -- --no-file-parallelism --testTimeout=30000");
    expect(planScript).toContain("pnpm build");
    expect(planScript).toContain("pnpm test:integration:smoke -- --no-file-parallelism --testTimeout=30000");
    expect(planScript).toContain("node --version");
  });

  it("classifier can be materialized and emit a verification plan", () => {
    const tempDir = mkdtempSync(join(repoRoot, "tmp-trusted-classifier-"));
    const trustedScriptsDir = join(tempDir, "scripts");
    const trustedLibDir = join(trustedScriptsDir, "lib");
    mkdirSync(trustedLibDir, { recursive: true });

    copyFileSync(
      join(repoRoot, "scripts", "verification-scope.mjs"),
      join(trustedScriptsDir, "verification-scope.mjs"),
    );
    copyFileSync(
      join(repoRoot, "scripts", "lib", "run-bounded-process.mjs"),
      join(trustedLibDir, "run-bounded-process.mjs"),
    );

    try {
      const output = execFileSync(
        process.execPath,
        [
          join(trustedScriptsDir, "verification-scope.mjs"),
          "--base",
          "main",
          "--plan",
        ],
        {
          cwd: repoRoot,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 30_000,
        },
      );
      expect(output).toContain('"schema_version"');
      expect(output).toContain('"mode"');
      expect(output).toContain('"stage"');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("standard job runs the filesystem security invariants as fixed steps", () => {
    const script = collectRunScripts(content, "standard").join("\n");
    const containment = script.indexOf("pnpm check:fs-containment");
    const hardening = script.indexOf("pnpm check:security-hardening");

    expect(containment).toBeGreaterThanOrEqual(0);
    expect(hardening).toBeGreaterThan(containment);
    expect(occurrences(script, "pnpm check:fs-containment")).toBe(1);
    expect(occurrences(script, "pnpm check:security-hardening")).toBe(1);
  });

  it("standard job does not scan fs-authority twice", () => {
    // check:security-hardening already runs the global fs-authority gate.
    const script = collectRunScripts(content, "standard").join("\n");

    expect(occurrences(script, "pnpm check:fs-authority")).toBe(0);
  });

  it("docs job stays docs-only and skips the filesystem invariants", () => {
    const script = collectRunScripts(content, "docs").join("\n");

    expect(script).not.toContain("pnpm check:fs-containment");
    expect(script).not.toContain("pnpm check:security-hardening");
  });

  it("ci-status job validates all required results", () => {
    const scripts = collectRunScripts(content, "ci-status");
    const statusScript = scripts.find(s => s.includes("DOCS_OUTPUT"));
    expect(statusScript).toBeDefined();
    expect(statusScript).toMatch(/CLASSIFY_RESULT/);
    expect(statusScript).toMatch(/STANDARD_RESULT/);
    expect(statusScript).toMatch(/FALLBACK_FULL_OUTPUT/);
  });

  it("ci-status job uses GITHUB_EVENT_NAME to enforce standard on main push", () => {
    const scripts = collectRunScripts(content, "ci-status");
    const statusScript = scripts.find(s => s.includes("DOCS_OUTPUT"));
    expect(statusScript).toMatch(/GITHUB_EVENT_NAME/);
    expect(statusScript).toMatch(/push/);
  });
});
