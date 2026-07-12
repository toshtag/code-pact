import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/integration/ci-smoke.test.ts"],
    setupFiles: ["./tests/setup.ts"],
    testTimeout: 30_000,
  },
});
