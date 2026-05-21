import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    passWithNoTests: true,
    reporters: ["default"],
    setupFiles: ["./tests/setup.ts"],
    testTimeout: 30_000,
  },
});
