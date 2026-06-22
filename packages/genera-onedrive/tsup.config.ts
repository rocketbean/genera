import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
  target: "es2022",
  external: [
    "@microsoft/microsoft-graph-client",
    "@microsoft/microsoft-graph-types",
    "@rocketbean/genera",
  ],
});
