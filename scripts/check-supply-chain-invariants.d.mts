// Type declarations for check-supply-chain-invariants.mjs (consumed by the unit
// test; the script itself runs as plain Node ESM).

export function checkActionShaPins(content: string): string[];
export function checkNoTokenSecrets(content: string): string[];
export function checkCheckoutPersistCredentials(content: string): string[];
export function checkSupplyChainInvariants(root: string): { failures: number };
