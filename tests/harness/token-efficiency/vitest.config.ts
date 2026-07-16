import { defineConfig } from "vitest/config";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const configDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: resolve(configDir, "../../.."),
  test: {
    include: ["tests/harness/token-efficiency/**/*.test.ts"],
    setupFiles: ["./tests/setup.ts"],
    testTimeout: 60_000,
  },
});
