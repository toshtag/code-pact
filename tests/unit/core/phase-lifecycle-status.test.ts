import { describe, it, expect } from "vitest";
import {
  derivePhaseLifecycleStatus,
  isTaskTerminalForPhase,
  type PhaseLifecycleTaskState,
} from "../../../src/core/phase-lifecycle-status.ts";

function st(
  design_status: PhaseLifecycleTaskState["design_status"],
  derived_state: PhaseLifecycleTaskState["derived_state"],
): PhaseLifecycleTaskState {
  return { design_status, derived_state };
}

describe("isTaskTerminalForPhase", () => {
  it("design status cancelled is terminal regardless of derived state", () => {
    expect(isTaskTerminalForPhase(st("cancelled", "failed"))).toBe(true);
    expect(isTaskTerminalForPhase(st("cancelled", "planned"))).toBe(true);
    expect(isTaskTerminalForPhase(st("cancelled", "done"))).toBe(true);
  });

  it("derived state done is terminal regardless of design status", () => {
    expect(isTaskTerminalForPhase(st("planned", "done"))).toBe(true);
    expect(isTaskTerminalForPhase(st("in_progress", "done"))).toBe(true);
    expect(isTaskTerminalForPhase(st("done", "done"))).toBe(true);
  });

  it("planned / in_progress design with non-done derived is not terminal", () => {
    expect(isTaskTerminalForPhase(st("planned", "started"))).toBe(false);
    expect(isTaskTerminalForPhase(st("planned", "blocked"))).toBe(false);
    expect(isTaskTerminalForPhase(st("in_progress", "failed"))).toBe(false);
  });
});

describe("derivePhaseLifecycleStatus", () => {
  it("empty array returns planned", () => {
    expect(derivePhaseLifecycleStatus([])).toBe("planned");
  });

  it("all done returns done", () => {
    expect(derivePhaseLifecycleStatus([st("done", "done")])).toBe("done");
    expect(
      derivePhaseLifecycleStatus([st("done", "done"), st("done", "done")]),
    ).toBe("done");
  });

  it("done + cancelled(failed history) returns done", () => {
    expect(
      derivePhaseLifecycleStatus([st("done", "done"), st("cancelled", "failed")]),
    ).toBe("done");
  });

  it("cancelled only returns done", () => {
    expect(derivePhaseLifecycleStatus([st("cancelled", "failed")])).toBe("done");
  });

  it("failed non-cancelled returns in_progress", () => {
    expect(derivePhaseLifecycleStatus([st("planned", "failed")])).toBe("in_progress");
  });

  it("done + planned returns in_progress", () => {
    expect(
      derivePhaseLifecycleStatus([st("done", "done"), st("planned", "planned")]),
    ).toBe("in_progress");
  });

  it("cancelled + planned returns planned", () => {
    expect(
      derivePhaseLifecycleStatus([st("cancelled", "failed"), st("planned", "planned")]),
    ).toBe("planned");
  });

  it("design in_progress with no events returns in_progress", () => {
    expect(derivePhaseLifecycleStatus([st("in_progress", "planned")])).toBe("in_progress");
  });

  it("started returns in_progress", () => {
    expect(derivePhaseLifecycleStatus([st("planned", "started")])).toBe("in_progress");
  });

  it("does not mutate the input array or objects", () => {
    const input = [st("planned", "started")];
    const snapshot = JSON.stringify(input);
    derivePhaseLifecycleStatus(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
