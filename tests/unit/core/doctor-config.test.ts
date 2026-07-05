import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadDoctorConfig } from "../../../src/core/doctor-config.ts";

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "code-pact-doctor-config-"));
  await mkdir(join(cwd, ".code-pact"), { recursive: true });
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe("loadDoctorConfig", () => {
  it("loads a normal doctor.yaml", async () => {
    await writeFile(
      join(cwd, ".code-pact", "doctor.yaml"),
      "disabled_checks:\n  - MODEL_MAP_STALE\n",
      "utf8",
    );

    await expect(loadDoctorConfig(cwd)).resolves.toMatchObject({
      disabled_checks: ["MODEL_MAP_STALE"],
    });
  });

  it("does not read an external symlink", async () => {
    const outside = await mkdtemp(join(tmpdir(), "code-pact-doctor-config-outside-"));
    try {
      await writeFile(
        join(outside, "doctor.yaml"),
        "disabled_checks:\n  - MODEL_MAP_STALE\n",
        "utf8",
      );
      await symlink(
        join(outside, "doctor.yaml"),
        join(cwd, ".code-pact", "doctor.yaml"),
      );

      await expect(loadDoctorConfig(cwd)).resolves.toEqual({ disabled_checks: [] });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("does not read a project-local private file symlinked as doctor.yaml", async () => {
    await writeFile(
      join(cwd, ".local-doctor.yaml"),
      "disabled_checks:\n  - MODEL_MAP_STALE\n",
      "utf8",
    );
    await symlink("../.local-doctor.yaml", join(cwd, ".code-pact", "doctor.yaml"));

    await expect(loadDoctorConfig(cwd)).resolves.toEqual({ disabled_checks: [] });
  });

  it("does not read oversized doctor.yaml", async () => {
    await writeFile(
      join(cwd, ".code-pact", "doctor.yaml"),
      `disabled_checks:\n${"  - MODEL_MAP_STALE\n".repeat(9000)}`,
      "utf8",
    );

    await expect(loadDoctorConfig(cwd)).resolves.toEqual({ disabled_checks: [] });
  });
});
