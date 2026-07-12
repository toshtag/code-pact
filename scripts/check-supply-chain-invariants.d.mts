// Type declarations for check-supply-chain-invariants.mjs (consumed by the unit
// test; the script itself runs as plain Node ESM).

export function checkActionShaPins(content: string): string[];
export function checkNoTokenSecrets(content: string): string[];
export function checkCheckoutPersistCredentials(content: string): string[];
export function checkCancellationCoverage(testContent: string): string[];
export function checkWindowsCancellationCoverage(testContent: string): string[];
export function checkCiPackageScripts(packageContent: string): string[];
export function checkSupplyChainInvariants(root: string): { failures: number };

export const PUBLISH_RUN_HASH: string;
export const GITHUB_RELEASE_RUN_HASH: string;
export const EXPECTED_CANONICAL_JOBS: Record<string, unknown>;
export const EXPECTED_WORKFLOW_ENVELOPE: Record<string, unknown>;
