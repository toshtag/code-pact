import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRoadmap } from "../../../../src/core/plan/roadmap.ts";
import { loadPhase } from "../../../../src/core/plan/load-phase.ts";
import { collectPlanArtifacts } from "../../../../src/core/plan/state.ts";

// SECURITY (Blocker 2 — roadmap/phase in-project symlink alias). The control
// plane (design/roadmap.yaml, design/phases/*.yaml) must be OWNED: an in-project
// symlink that aliases a private file (e.g. `.local/private-phase.yaml`) must be
// refused, matching the strict loadPlanState contract. resolveWithinProject
// allowed in-project symlinks — resolveSymlinkFreeProjectPath does not.

const VALID_PHASE = [
  "id: P1",
  "name: Foundation",
  "weight: 10",
  "confidence: high",
  "risk: low",
  "status: planned",
  "objective: leaked private objective MARKER-PHASE",
  "definition_of_done:",
  "  - done",
  "verification:",
  "  commands:",
  "    - echo LEAKED-VERIFY-MARKER",
  "tasks:",
  "  - id: P1-T1",
  "    type: feature",
  "    ambiguity: low",
  "    risk: low",
  "    context_size: small",
  "    write_surface: low",
  "    verification_strength: weak",
  "    expected_duration: short",
  "    status: planned",
  "",
].join("\n");

const VALID_ROADMAP = "phases:\n  - id: P1\n    path: design/phases/P1.yaml\n    weight: 10\n";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "code-pact-owned-symlink-"));
  await mkdir(join(dir, "design", "phases"), { recursive: true });
  await mkdir(join(dir, ".local"), { recursive: true });
});
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("loadPhase — in-project symlink alias is refused (owned-path)", () => {
  it("rejects design/phases/P1.yaml -> ../../.local/private-phase.yaml with CONFIG_ERROR", async () => {
    await writeFile(join(dir, ".local", "private-phase.yaml"), VALID_PHASE, "utf8");
    await symlink(
      join(dir, ".local", "private-phase.yaml"),
      join(dir, "design", "phases", "P1.yaml"),
    );
    await expect(loadPhase(dir, "design/phases/P1.yaml")).rejects.toMatchObject({
      code: "CONFIG_ERROR",
    });
  });

  it("a genuinely missing (non-symlink) phase still throws RAW ENOENT (archived-fallback signal)", async () => {
    await expect(loadPhase(dir, "design/phases/absent.yaml")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("loadRoadmap — in-project symlink alias is refused (owned-path)", () => {
  it("rejects design/roadmap.yaml -> ../.local/roadmap.yaml with CONFIG_ERROR", async () => {
    await writeFile(join(dir, ".local", "roadmap.yaml"), VALID_ROADMAP, "utf8");
    await symlink(join(dir, ".local", "roadmap.yaml"), join(dir, "design", "roadmap.yaml"));
    await expect(loadRoadmap(dir)).rejects.toMatchObject({ code: "CONFIG_ERROR" });
  });
});

describe("collectPlanArtifacts — symlink alias fail-closed (lenient)", () => {
  it("an aliased roadmap becomes a FileIssue and yields no usable state", async () => {
    await writeFile(join(dir, ".local", "roadmap.yaml"), VALID_ROADMAP, "utf8");
    await symlink(join(dir, ".local", "roadmap.yaml"), join(dir, "design", "roadmap.yaml"));
    const result = await collectPlanArtifacts(dir);
    // Roadmap unreadable → fail-closed: a FileIssue is recorded and no plan
    // state is produced from the aliased graph.
    expect(result.fileIssues.length).toBeGreaterThan(0);
    expect(result.state).toBeNull();
  });

  it("an aliased phase ref becomes a FileIssue, never an aliased read", async () => {
    await writeFile(join(dir, "design", "roadmap.yaml"), VALID_ROADMAP, "utf8");
    await writeFile(join(dir, ".local", "private-phase.yaml"), VALID_PHASE, "utf8");
    await symlink(
      join(dir, ".local", "private-phase.yaml"),
      join(dir, "design", "phases", "P1.yaml"),
    );
    const result = await collectPlanArtifacts(dir);
    expect(result.fileIssues.some((i) => i.file === "design/phases/P1.yaml")).toBe(true);
    // The aliased private content must never surface.
    expect(JSON.stringify(result)).not.toContain("MARKER-PHASE");
    expect(JSON.stringify(result)).not.toContain("LEAKED-VERIFY-MARKER");
  });
});
