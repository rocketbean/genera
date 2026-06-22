import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
  target: "es2022",
  // The Azure SDK (peer dependency) stays external so the consumer's bundler
  // picks the right Node/browser build.
  external: ["@azure/storage-blob", "@rocketbean/genera"],
});
