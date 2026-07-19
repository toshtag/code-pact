export const MAX_SOURCE_BYTES = 8192;
export const MAX_SOURCE_LINES = 120;
export const MAX_REASON_BYTES = 512;
export const MAX_NEW_TEXT_BYTES = 8192;

export type OneShotEligibility =
  | {
      eligible: true;
      sourcePath: string;
      verificationCommand: string;
    }
  | {
      eligible: false;
      reasons: string[];
    };

export type ExactReplacement = {
  path: string;
  expected_file_sha256: string;
  old_text: string;
  new_text: string;
};

export type ApplyExactReplacementResult =
  | {
      kind: "applied";
      originalContent: string;
    }
  | {
      kind: "rejected";
      reason: string;
    };
