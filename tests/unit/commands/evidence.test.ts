import { describe, expect, it } from "vitest";
import { mapEvidenceShowError } from "../../../src/cli/commands/evidence.ts";

describe("evidence command error mapping", () => {
  it("maps read permission failures to EVIDENCE_READ_FAILED diagnostics", () => {
    const error = new Error("permission denied");
    (error as NodeJS.ErrnoException).code = "EACCES";

    expect(mapEvidenceShowError(error)).toEqual({
      code: "EVIDENCE_READ_FAILED",
      systemCode: "EACCES",
      message: "permission denied",
    });
  });
});
