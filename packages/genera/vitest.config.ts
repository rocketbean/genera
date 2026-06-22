import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

/**
 * Two projects (plan Phase 5):
 *   - node    — the full suite, including Node-only drivers (FS).
 *   - browser — the isomorphism proof: `*.browser.test.ts` run in a real browser
 *               via Playwright. Only isomorphic code belongs here (any `fs`/`path`/
 *               `Buffer`/`process` leak fails immediately).
 *
 * `pnpm test` runs the node project (fast, no browser needed); `pnpm test:browser`
 * runs the browser project (requires `npx playwright install chromium`).
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          include: ["test/**/*.test.ts"],
          exclude: ["test/**/*.browser.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "browser",
          include: ["test/**/*.browser.test.ts"],
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
});
