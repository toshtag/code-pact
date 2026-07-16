import { describe, expect, it } from "vitest";
import { messages } from "../../../src/i18n/index.ts";
import { renderAgentContractSection } from "../../../src/core/adapters/template-sections.ts";
import {
  STRUCTURAL_PROJECTION_GUIDANCE_COMMON_ANCHORS,
  STRUCTURAL_PROJECTION_GUIDANCE_VARIANTS,
} from "../../../src/core/adapters/conformance-spec.ts";

describe("agent contract failure guidance", () => {
  for (const locale of ["en-US", "ja-JP"] as const) {
    it(`${locale} points agents at compact failure capsule fields`, () => {
      const failBody = messages[locale].templates.adapterCommon.agentContract.failBody;

      for (const anchor of [
        "data.failure.kind",
        "data.failure.check",
        "data.failure.reason",
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
      for (const kind of ["command_failed", "timed_out", "decision_required", "invalid_state"]) {
        expect(failBody).toContain(kind);
      }
      for (const stateAnchor of ["progress_event", "task_status"]) {
        expect(failBody).toContain(stateAnchor);
      }

      expect(failBody).toMatch(/task complete[\s\S]*error\.cause_code[\s\S]*COMMANDS_FAILED[\s\S]*DECISION_REQUIRED[\s\S]*ABORTED/);
      expect(failBody).toMatch(/verify --json --detail agent[\s\S]*data\.failure\.kind[\s\S]*command_failed[\s\S]*timed_out[\s\S]*decision_required[\s\S]*invalid_state/);
      expect(failBody).toMatch(/invalid_state[\s\S]*data\.failure\.check[\s\S]*data\.failure\.reason/);
      expect(failBody).not.toMatch(/verify --json --detail agent[\s\S]{0,160}COMMANDS_FAILED/);
      expect(failBody).not.toMatch(/verify --json --detail agent[\s\S]{0,160}DECISION_REQUIRED/);
    });

    it(`${locale} documents bounded repair policy anchors`, () => {
      const verifyBody = messages[locale].templates.adapterCommon.agentContract.verifyBody;
      const repairBody = messages[locale].templates.adapterCommon.agentContract.repairBody;
      const combined = `${verifyBody}\n${repairBody}`;

      for (const anchor of [
        "data.recommendation",
        "data.recommendation.repairPolicy",
        "data.repairPolicy",
        "data.recommendation.allowedEscalation",
        "data.allowedEscalation",
        "repairPolicy",
        "maxRepairAttempts",
        "command_failed",
        "same_model_same_effort_same_context",
        "failure_delta",
        "stopOnRepeatedFingerprint",
        "use_allowed_escalation",
        "timed_out",
        "aborted",
        "decision_required",
        "unsafe_write",
        "invalid_state",
        "unknown",
      ]) {
        expect(repairBody).toContain(anchor);
      }

      expect(repairBody).not.toContain("retry until success");
      expect(repairBody).not.toContain("increase context before retry");
      expect(repairBody).not.toContain("escalate model before retry");
      expect(repairBody).not.toContain("成功するまで繰り返す");
      expect(repairBody).not.toContain("retry 前に context を増やす");
      expect(repairBody).not.toContain("retry 前に model を上げる");
      expect(combined).not.toContain(
        "data.recommendation.repairPolicy` from the existing `task prepare` / `recommend` result",
      );
      expect(combined).not.toContain(
        "既存の `task prepare` / `recommend` 結果にある `data.recommendation.repairPolicy`",
      );
    });

    it(`${locale} documents prior-local signal consumption in generated guidance`, () => {
      const t = messages[locale].templates.adapterCommon;
      const failBody = t.agentContract.failBody;
      const generated = renderAgentContractSection(t).join("\n");

      for (const text of [failBody, generated]) {
        for (const anchor of [
          "prior_local_signal",
          "exact_match_count",
          "stopOnRepeatedFingerprint",
        ]) {
          expect(text).toContain(anchor);
        }
      }

      if (locale === "en-US") {
        expect(generated).toContain("does not describe previous repair attempts");
        expect(generated).toContain("do not infer them");
      } else {
        expect(generated).toContain("過去の repair や仮説の内容は示さない");
        expect(generated).toContain("推測しない");
      }
    });

    it(`${locale} documents structural projection consumption anchors`, () => {
      const contextBody = messages[locale].templates.adapterCommon.agentContract
        .contextCommandBody;

      for (const anchor of STRUCTURAL_PROJECTION_GUIDANCE_COMMON_ANCHORS) {
        expect(contextBody).toContain(anchor);
      }
      const variant = STRUCTURAL_PROJECTION_GUIDANCE_VARIANTS.find(
        candidate => candidate.id === locale,
      );
      expect(variant).toBeDefined();
      for (const anchor of variant!.anchors) {
        expect(contextBody).toContain(anchor);
      }
    });
  }
});
