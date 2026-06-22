import { defineConfig } from "tsup";

export default defineConfig({
  // Multi-entry: the public API, the Node-only entry (FsDriver), and the
  // conformance kit — each a subpath export (see package.json#exports).
  entry: {
    index: "src/index.ts",
    node: "src/node.ts",
    conformance: "src/conformance.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
  target: "es2022",
});
