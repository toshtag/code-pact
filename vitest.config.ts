import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    passWithNoTests: true,
    reporters: ["default"],
    // P14 governance test escape: disable the advisory write lock for
    // the bulk of the suite. Lock-specific tests opt back in. See
    // tests/setup.ts for the contract.
    setupFiles: ["./tests/setup.ts"],
    // Multiple integration suites call `pnpm build` in their own
    // beforeAll. Running them in parallel produces a race against
    // tsup's output-dir cleanup. Disable file-level parallelism so
    // workers run sequentially; unit tests inside each file still
    // run concurrently.
    fileParallelism: false,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/cli.ts", "src/i18n/**"],
    },
  },
});
