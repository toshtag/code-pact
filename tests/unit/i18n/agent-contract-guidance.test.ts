import { describe, expect, it } from "vitest";
import { messages } from "../../../src/i18n/index.ts";

describe("agent contract failure guidance", () => {
  for (const locale of ["en-US", "ja-JP"] as const) {
    it(`${locale} points agents at compact failure capsule fields`, () => {
      const failBody = messages[locale].templates.adapterCommon.agentContract.failBody;

      for (const anchor of [
        "data.failure.kind",
        "data.failure.fingerprint",
        "stderr_excerpt",
        "stdout_excerpt",
        "retrieve_command",
      ]) {
        expect(failBody).toContain(anchor);
      }
      expect(failBody).not.toContain("error.message is actionable");
      expect(failBody).not.toContain("error.message は actionable");
    });

    it(`${locale} separates task complete cause codes from standalone verify failure kinds`, () => {
      const failBody = messages[locale].templates.adapterCommon.agentContract.failBody;

      expect(failBody).toContain("task complete --json --detail agent");
      expect(failBody).toContain("verify --json --detail agent");

      for (const causeCode of ["COMMANDS_FAILED", "DECISION_REQUIRED", "ABORTED"]) {
        expect(failBody).toContain(causeCode);
      }
      for (const kind of ["command_failed", "timed_out", "decision_required"]) {
        expect(failBody).toContain(kind);
      }

      expect(failBody).toMatch(/task complete[\s\S]*error\.cause_code[\s\S]*COMMANDS_FAILED[\s\S]*DECISION_REQUIRED[\s\S]*ABORTED/);
      expect(failBody).toMatch(/verify --json --detail agent[\s\S]*data\.failure\.kind[\s\S]*command_failed[\s\S]*timed_out[\s\S]*decision_required/);
      expect(failBody).not.toMatch(/verify --json --detail agent[\s\S]{0,160}COMMANDS_FAILED/);
      expect(failBody).not.toMatch(/verify --json --detail agent[\s\S]{0,160}DECISION_REQUIRED/);
    });
  }
});
