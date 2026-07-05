import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    passWithNoTests: true,
    reporters: ["default"],
    setupFiles: ["./tests/setup.ts"],
    maxWorkers: 4,
    benchmark: {
      include: ["tests/unit/**/*.bench.ts"],
      outputJson: ".vitest-benchmark.json",
    },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/cli.ts", "src/i18n/**"],
    },
  },
});
