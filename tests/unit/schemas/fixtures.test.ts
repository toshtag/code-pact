import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { loadYaml } from "../../../src/io/load.ts";
import { readFile } from "node:fs/promises";
import {
  Project,
  Roadmap,
  Phase,
  AgentProfile,
  ModelProfile,
  ProgressLog,
  BaselineSnapshot,
} from "../../../src/core/schemas/index.ts";

const FIXTURE = resolve(import.meta.dirname, "../../fixtures/project-a");

describe("fixture project-a: all YAML files pass their schemas", () => {
  it("project.yaml", async () => {
    const p = await loadYaml(`${FIXTURE}/.code-pact/project.yaml`, Project);
    expect(p.name).toBe("project-alpha");
    expect(p.locale).toBe("ja-JP");
  });

  it("roadmap.yaml", async () => {
    const r = await loadYaml(`${FIXTURE}/design/roadmap.yaml`, Roadmap);
    expect(r.phases).toHaveLength(2);
    expect(r.phases[0]?.id).toBe("P1");
  });

  it("phase P1-foundation.yaml", async () => {
    const p = await loadYaml(`${FIXTURE}/design/phases/P1-foundation.yaml`, Phase);
    expect(p.id).toBe("P1");
    expect(p.status).toBe("done");
    expect(p.tasks).toHaveLength(2);
  });

  it("phase P2-core.yaml", async () => {
    const p = await loadYaml(`${FIXTURE}/design/phases/P2-core.yaml`, Phase);
    expect(p.id).toBe("P2");
    expect(p.requires_decision).toBe(true);
  });

  it("agent-profile claude-code.yaml", async () => {
    const a = await loadYaml(
      `${FIXTURE}/.code-pact/agent-profiles/claude-code.yaml`,
      AgentProfile,
    );
    expect(a.name).toBe("claude-code");
    expect(a.model_map.highest_reasoning).toBe("claude-opus-4-7");
  });

  it("model-profile highest-reasoning.yaml", async () => {
    const m = await loadYaml(
      `${FIXTURE}/.code-pact/model-profiles/highest-reasoning.yaml`,
      ModelProfile,
    );
    expect(m.tier).toBe("highest_reasoning");
    expect(m.supports_thinking).toBe(true);
  });

  it("progress.yaml", async () => {
    const log = await loadYaml(`${FIXTURE}/.code-pact/state/progress.yaml`, ProgressLog);
    expect(log.events).toHaveLength(2);
    expect(log.events[0]?.status).toBe("done");
  });

  it("baselines/initial.json", async () => {
    const raw = await readFile(
      `${FIXTURE}/.code-pact/state/baselines/initial.json`,
      "utf8",
    );
    const s = BaselineSnapshot.parse(JSON.parse(raw));
    expect(s.name).toBe("initial");
    expect(s.total_weight).toBe(30);
  });
});
