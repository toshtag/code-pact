import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  target: "node24",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  splitting: false,
  shims: false,
  banner: { js: "" },
});
