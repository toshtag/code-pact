import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    // P14 governance test escape: disable the advisory write lock for
    // the bulk of the suite. Lock-specific tests opt back in. See
    // tests/setup.ts for the contract.
    setupFiles: ["./tests/setup.ts"],
  },
});
