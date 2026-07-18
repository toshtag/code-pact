import { describe, expect, it } from "vitest";
import { messages, type Locale } from "../../../src/i18n/index.ts";

// P33: the adapter templates (claude.ts / generic.ts) interpolate
// agentContract.verifyBody verbatim, so asserting the consumption-guidance
// anchors here guarantees they reach the generated instruction files. These
// are the exact short, stable tokens the P33 conformance checks anchor on, so
// they must be present in BOTH locales' generated output.
const MINIMAL_PREPARE_ANCHORS = ["data.task", "data.next", "data.more.command"];
const RECOMMENDATION_ANCHORS = [
  "data.recommendation",
  "lifecycleMode",
  "record_only",
  "task record-done",
  "cannot switch model",
];

const LOCALES: Locale[] = ["en-US", "ja-JP"];

describe("agent contract: recommendation consumption guidance", () => {
  for (const locale of LOCALES) {
    it(`${locale} whenBody contains default minimal prepare output fields`, () => {
      const whenBody =
        messages[locale].templates.adapterCommon.agentContract.whenBody;
      for (const anchor of MINIMAL_PREPARE_ANCHORS) {
        expect(whenBody).toContain(anchor);
      }
    });

    it(`${locale} verifyBody contains full-detail prepare anchor`, () => {
      const verifyBody =
        messages[locale].templates.adapterCommon.agentContract.verifyBody;
      expect(verifyBody).toContain("task prepare --detail full");
    });

    for (const anchor of RECOMMENDATION_ANCHORS) {
      it(`${locale} verifyBody contains "${anchor}"`, () => {
        expect(
          messages[locale].templates.adapterCommon.agentContract.verifyBody,
        ).toContain(anchor);
      });
    }

    it(`${locale} does not describe default task prepare --json as returning recommendation fields`, () => {
      const verifyBody =
        messages[locale].templates.adapterCommon.agentContract.verifyBody;
      expect(verifyBody).not.toMatch(
        /task prepare --json[^\n]*data\.recommendation/,
      );
      // Recommendation is tied to --detail full, not to default task prepare.
      expect(verifyBody).toMatch(
        /`?data\.recommendation`?[\s\S]{0,80}--detail full/,
      );
    });
  }
});
