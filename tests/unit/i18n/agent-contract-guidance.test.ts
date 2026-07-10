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
  }
});
