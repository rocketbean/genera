import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

/**
 * Lint rule that keeps the isomorphic core free of Node built-ins (plan Phase 0:
 * "lint-enforce that the core uses no Node built-ins — web-standard APIs only").
 * Applied to packages/genera/src/** except the Node-only filesystem driver and
 * the `node` entry, which are environment-scoped by design (plan §5.3, §5.6).
 */
const noNodeBuiltins = {
  "no-restricted-imports": [
    "error",
    {
      paths: [
        { name: "fs", message: "Isomorphic core: no Node built-ins (use web-standard APIs)." },
        { name: "path", message: "Use the canonical path engine, not node:path." },
        { name: "buffer", message: "Use Uint8Array, not Buffer." },
        { name: "process", message: "No process in the isomorphic core." },
        { name: "stream", message: "Use web streams (ReadableStream)." },
        { name: "os", message: "Isomorphic core: no Node built-ins." },
        { name: "crypto", message: "Use Web Crypto (globalThis.crypto)." },
        { name: "util", message: "Isomorphic core: no Node built-ins." },
      ],
      patterns: [
        { group: ["node:*"], message: "Isomorphic core: no Node built-ins (web-standard APIs only)." },
      ],
    },
  ],
  "no-restricted-globals": [
    "error",
    { name: "Buffer", message: "Use Uint8Array." },
    { name: "process", message: "No process in the isomorphic core." },
    { name: "__dirname", message: "No Node globals in the isomorphic core." },
    { name: "__filename", message: "No Node globals in the isomorphic core." },
  ],
};

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/*.config.ts", "**/*.config.mjs"],
  },
  {
    files: ["packages/*/src/**/*.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["packages/genera/src/**/*.ts"],
    ignores: ["packages/genera/src/drivers/fs.ts", "packages/genera/src/node.ts"],
    rules: noNodeBuiltins,
  },
  prettier,
);
