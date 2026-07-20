import { chmod, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __filename = fileURLToPath(import.meta.url);
export const fixtureDir = join(dirname(__filename), "..", "..", "fixtures", "executors");
export const fakeExecutorPath = join(fixtureDir, "fake-executor.mjs");

export async function withTempProject<T>(
  fn: (cwd: string) => Promise<T>,
  verificationCommand = "exit 0",
): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), "code-pact-execute-once-"));
  try {
    await setupCodePactProject(cwd, verificationCommand);
    return await fn(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

export async function setupCodePactProject(
  cwd: string,
  verificationCommand: string,
): Promise<void> {
  const projectYaml = `name: test
version: "0.0.1"
locale: en-US
default_agent: claude-code
agents:
  - name: claude-code
    profile: agent-profiles/claude-code.yaml
`;
  const roadmapYaml = `phases:
  - id: P78
    path: design/phases/P78.yaml
    weight: 1
`;
  const phaseYaml = `id: P78
name: One-shot
weight: 1
confidence: medium
risk: low
status: in_progress
objective: test objective
definition_of_done:
  - done
verification:
  commands:
    - ${verificationCommand}
tasks:
  - id: P78-T1
    type: feature
    ambiguity: low
    risk: low
    context_size: small
    write_surface: low
    verification_strength: medium
    expected_duration: short
    status: planned
    description: test goal
    reads:
      - src/example.ts
    writes:
      - src/example.ts
`;
  const sourceContent = "hello world";

  await mkdir(join(cwd, ".code-pact", "state"), { recursive: true });
  await mkdir(join(cwd, "design", "phases"), { recursive: true });
  await mkdir(join(cwd, "src"), { recursive: true });

  await import("node:fs/promises").then(fs =>
    Promise.all([
      fs.writeFile(join(cwd, ".code-pact", "project.yaml"), projectYaml, "utf8"),
      fs.writeFile(join(cwd, "design", "roadmap.yaml"), roadmapYaml, "utf8"),
      fs.writeFile(join(cwd, "design", "phases", "P78.yaml"), phaseYaml, "utf8"),
      fs.writeFile(join(cwd, "src", "example.ts"), sourceContent, "utf8"),
    ]),
  );

  execSync("git init", { cwd, stdio: "ignore" });
  execSync("git config user.email test@example.com", { cwd, stdio: "ignore" });
  execSync("git config user.name Test", { cwd, stdio: "ignore" });
  execSync("git add .", { cwd, stdio: "ignore" });
  execSync("git commit -m init", { cwd, stdio: "ignore" });
}

export function setMode(mode: string): void {
  process.env.EXECUTOR_MODE = mode;
}

export function clearEnv(): void {
  delete process.env.EXECUTOR_MODE;
  delete process.env.EXECUTOR_OLD;
  delete process.env.EXECUTOR_NEW;
  delete process.env.EXECUTOR_REASON;
  delete process.env.EXECUTOR_STDERR;
}

export async function countEventFiles(cwd: string): Promise<number> {
  try {
    const names = await readdir(join(cwd, ".code-pact", "state", "events"));
    return names.filter(n => /^\d{8}T\d{9}Z-[0-9a-f]{64}\.yaml$/.test(n))
      .length;
  } catch {
    return 0;
  }
}

export async function ensureExecutorExecutable(): Promise<void> {
  await chmod(fakeExecutorPath, 0o755);
}
