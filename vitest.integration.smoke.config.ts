import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "tests/integration/adapter-cli.test.ts",
      "tests/integration/cli.test.ts",
      "tests/integration/e2e-workflow.test.ts",
      "tests/integration/json-stdout.test.ts",
    ],
    passWithNoTests: false,
    reporters: ["default"],
    setupFiles: ["./tests/setup.ts"],
    testTimeout: 30_000,
  },
});
