import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadProject } from "../../../src/core/project.ts";

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "code-pact-project-loader-"));
  await mkdir(join(cwd, ".code-pact"), { recursive: true });
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe("loadProject error contract", () => {
  it("maps a missing project.yaml to CONFIG_ERROR", async () => {
    await expect(loadProject(cwd)).rejects.toMatchObject({ code: "CONFIG_ERROR" });
  });

  it("maps malformed YAML to CONFIG_ERROR", async () => {
    await writeFile(join(cwd, ".code-pact", "project.yaml"), "agents: {unclosed", "utf8");
    await expect(loadProject(cwd)).rejects.toMatchObject({ code: "CONFIG_ERROR" });
  });

  it("maps schema-invalid YAML to CONFIG_ERROR", async () => {
    await writeFile(
      join(cwd, ".code-pact", "project.yaml"),
      "name: demo\nversion: 0.1.0\nlocale: en-US\ndefault_agent: claude-code\nagents: nope\n",
      "utf8",
    );
    await expect(loadProject(cwd)).rejects.toMatchObject({ code: "CONFIG_ERROR" });
  });
});
