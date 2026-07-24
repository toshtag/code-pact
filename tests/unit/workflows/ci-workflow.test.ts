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

  it("standard job runs the bounded verification-scope plan", () => {
    const scripts = collectRunScripts(content, "standard");
    const planScript = scripts.find(s => s.includes("verification-scope.mjs"));
    expect(planScript).toBeDefined();
    expect(planScript).toMatch(/--base\s+"?\$BASE_REF"?/);
    expect(planScript).toMatch(/--run/);
  });

  it("standard job runs on push or when classify standard is true", () => {
    const ifExpr = jobIf(content, "standard");
    expect(ifExpr).toMatch(/github\.event_name\s*==\s*['"]push['"]/);
    expect(ifExpr).toMatch(
      /needs\.classify\.outputs\.standard\s*==\s*['"]true['"]/,
    );
  });

  it("standard job uses --force-full on main push", () => {
    const scripts = collectRunScripts(content, "standard");
    const planScript = scripts.find(s => s.includes("verification-scope.mjs"));
    expect(planScript).toMatch(/GITHUB_EVENT_NAME/);
    expect(planScript).toMatch(/--force-full/);
  });

  it("standard job does not run a hard-coded full test suite", () => {
    const scripts = collectRunScripts(content, "standard");
    for (const script of scripts) {
      expect(script).not.toMatch(/\bpnpm\s+(?:run\s+)?test:ci\b/);
      expect(script).not.toMatch(/\bpnpm\s+release:check\b/);
      expect(script).not.toMatch(
        /vitest\s+run\s+--config\s+vitest\.integration\.config\.ts/,
      );
    }
  });

  it("ci-status job validates all required results", () => {
    const scripts = collectRunScripts(content, "ci-status");
    const statusScript = scripts.find(s => s.includes("DOCS_OUTPUT"));
    expect(statusScript).toBeDefined();
    expect(statusScript).toMatch(/CLASSIFY_RESULT/);
    expect(statusScript).toMatch(/STANDARD_RESULT/);
  });

  it("ci-status job uses GITHUB_EVENT_NAME to enforce standard on main push", () => {
    const scripts = collectRunScripts(content, "ci-status");
    const statusScript = scripts.find(s => s.includes("DOCS_OUTPUT"));
    expect(statusScript).toMatch(/GITHUB_EVENT_NAME/);
    expect(statusScript).toMatch(/push/);
  });
});
