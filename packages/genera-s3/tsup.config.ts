import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
  target: "es2022",
  // Keep the AWS SDK (peer dependency) out of the bundle — the consumer provides it.
  external: ["@aws-sdk/client-s3", "@aws-sdk/s3-request-presigner", "@rocketbean/genera"],
});
