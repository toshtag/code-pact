import { describe, expect, it } from "vitest";
import { messages, type Locale } from "../../../src/i18n/index.ts";

// P33: the adapter templates (claude.ts / generic.ts) interpolate
// agentContract.verifyBody verbatim, so asserting the consumption-guidance
// anchors here guarantees they reach the generated instruction files. These
// are the exact short, stable tokens the P33 conformance checks anchor on, so
// they must be present in BOTH locales' generated output.
const ANCHORS = [
  "data.recommendation",
  "lifecycleMode",
  "record_only",
  "task record-done",
  "cannot switch model",
];

const LOCALES: Locale[] = ["en-US", "ja-JP"];

describe("agent contract: recommendation consumption guidance", () => {
  for (const locale of LOCALES) {
    for (const anchor of ANCHORS) {
      it(`${locale} verifyBody contains "${anchor}"`, () => {
        expect(
          messages[locale].templates.adapterCommon.agentContract.verifyBody,
        ).toContain(anchor);
      });
    }
  }
});
