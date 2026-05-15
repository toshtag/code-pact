import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    passWithNoTests: true,
    reporters: ["default"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/cli.ts", "src/i18n/**"],
    },
  },
});
