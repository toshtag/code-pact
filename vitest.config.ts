import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    passWithNoTests: true,
    reporters: ["default"],
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
