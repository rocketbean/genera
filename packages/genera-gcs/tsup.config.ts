import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
  target: "es2022",
  platform: "node",
  // The GCS SDK (peer dependency) stays external — the consumer provides it.
  external: ["@google-cloud/storage", "@rocketbean/genera"],
});
