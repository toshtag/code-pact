// Type declaration for the plain-node `closes-claim.mjs` helper so the TypeScript
// unit test can import it with types. The script runs under `node` (not tsx), so the
// implementation stays `.mjs`; `scripts/` is outside tsc's `include`, and only the test
// pulls this in.
export function closesClaimProblem(
  phaseId: string,
  liveEntry: { file: string; body: string } | undefined,
  snapshot: Record<string, unknown> | null | "PARSE_ERROR",
): { rel: string; msg: string } | null;

export function readLivePhaseFiles(repoRoot: string, phaseDir?: string): string[];
