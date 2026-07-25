import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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

  it("classify job emits fallback_full", () => {
    expect(jobOutputs(content, "classify")).toContain("fallback_full");
  });

  it("classify job copies the classifier and its lib dependency into a temporary tree", () => {
    const scripts = collectRunScripts(content, "classify");
    const script = scripts.join("\n");
    expect(script).toMatch(/trusted_root=.*RUNNER_TEMP\/trusted-classifier/);
    expect(script).toContain("scripts/verification-scope.mjs");
    expect(script).toContain("scripts/lib/run-bounded-process.mjs");
    expect(script).toContain('node "$trusted_classifier"');
  });

  it("standard job runs the bounded verification-scope plan only when not in fallback full", () => {
    const scripts = collectRunScripts(content, "standard");
    const planScript = scripts.find(s => s.includes("verification-scope.mjs"));
    expect(planScript).toBeDefined();
    expect(planScript).toMatch(/--base\s+"?\$BASE_REF"?/);
    expect(planScript).toMatch(/--run/);
    expect(planScript).toMatch(/else/);
  });

  it("standard job runs on push or when classify standard is true", () => {
    const ifExpr = jobIf(content, "standard");
    expect(ifExpr).toMatch(/github\.event_name\s*==\s*['"]push['"]/);
    expect(ifExpr).toMatch(
      /needs\.classify\.outputs\.standard\s*==\s*['"]true['"]/,
    );
  });

  it("standard job uses a fixed full gate when fallback_full or on main push", () => {
    const scripts = collectRunScripts(content, "standard");
    const planScript = scripts.find(s => s.includes("FALLBACK_FULL"));
    expect(planScript).toBeDefined();
    expect(planScript).toMatch(/FALLBACK_FULL/);
    expect(planScript).toMatch(/GITHUB_EVENT_NAME/);
    expect(planScript).toMatch(/pnpm\s+test:unit/);
    expect(planScript).toMatch(/pnpm\s+test:integration:smoke/);
    expect(planScript).toMatch(/node\s+dist\/cli\.js/);
  });

  it("standard job runs a hard-coded full test suite for high-risk changes", () => {
    const scripts = collectRunScripts(content, "standard");
    const planScript = scripts.find(s => s.includes("FALLBACK_FULL"));
    expect(planScript).toBeDefined();
    expect(planScript).toMatch(/pnpm\s+check:supply-chain/);
    expect(planScript).toMatch(/pnpm\s+typecheck/);
    expect(planScript).toMatch(/pnpm\s+build/);
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
