// Aggregator for adapter subcommands. The individual runners live in
// adapter-install.ts / adapter-list.ts / adapter-doctor.ts /
// adapter-upgrade.ts so the CLI router can import them by purpose and
// callers (tests, future code) can import named runners without going
// through this file. Kept thin on purpose.

export {
  runAdapterInstall,
} from "./adapter-install.ts";

export type {
  AdapterInstallOptions,
  AdapterInstallResult,
  AdapterInstallFile,
} from "./adapter-install.ts";

export { runAdapterList } from "./adapter-list.ts";
export type {
  AdapterListEntry,
  AdapterListResult,
} from "./adapter-list.ts";

// ---------------------------------------------------------------------------
// Back-compat aliases — the v0.8 surface used `runGenerateAdapter` and
// `AdapterOptions` / `AdapterResult`. v0.9 keeps these names working so
// the bare-form shim, the existing test suite, and any third-party code
// that imported the v0.8 names continue to compile. The aliases point at
// the v0.9 install implementation; the only user-visible behavior change
// is the `--force` narrowing documented in CHANGELOG.
// ---------------------------------------------------------------------------

import { runAdapterInstall } from "./adapter-install.ts";
import type {
  AdapterInstallOptions,
  AdapterInstallResult,
} from "./adapter-install.ts";

export type AdapterOptions = AdapterInstallOptions;
export type AdapterResult = AdapterInstallResult;

export const runGenerateAdapter = runAdapterInstall;
