import { beforeAll, describe, expect, it } from "vitest";
import { Storage } from "@google-cloud/storage";

import { createStorage } from "@rocketbean/genera";
import { describeConformance } from "@rocketbean/genera/conformance";

import { GcsDriver, type GcsDriverOptions } from "../src/index";

/**
 * Conformance + driver-specific tests run only when a GCS endpoint is configured,
 * so the suite stays green without an emulator. To run them:
 *
 *   docker compose up -d fake-gcs        # repo root (see docker-compose.yml)
 *   GENERA_GCS_TEST_ENDPOINT=http://localhost:4443 \
 *     pnpm --filter @rocketbean/genera-gcs test
 */
const ENDPOINT = process.env.GENERA_GCS_TEST_ENDPOINT;
const BUCKET = process.env.GENERA_GCS_TEST_BUCKET ?? "genera-conformance";
const PROJECT = process.env.GENERA_GCS_TEST_PROJECT ?? "test";

function baseOptions(): GcsDriverOptions {
  return {
    bucket: BUCKET,
    projectId: PROJECT,
    ...(ENDPOINT ? { apiEndpoint: ENDPOINT } : {}),
  };
}

// A fresh, isolated root per driver instance keeps every test (and re-run) in its
// own namespace within the shared bucket — no cross-test contamination.
function makeDriver(): GcsDriver {
  return new GcsDriver({ ...baseOptions(), root: `conf-${crypto.randomUUID()}` });
}

if (!ENDPOINT) {
  describe.skip("GcsDriver (set GENERA_GCS_TEST_ENDPOINT to run against fake-gcs-server)", () => {
    it("skipped — no GCS endpoint configured", () => {});
  });
} else {
  beforeAll(async () => {
    const storage = new Storage({ projectId: PROJECT, apiEndpoint: ENDPOINT });
    await storage.createBucket(BUCKET).catch(() => {
      /* already exists — fine */
    });
  });

  // The linchpin: the GCS driver must satisfy the full portable contract.
  describeConformance("GCS", makeDriver);

  describe("GcsDriver specifics", () => {
    it("is Node-only and exposes the Storage client as native", () => {
      const driver = makeDriver();
      expect(driver.environments.has("node")).toBe(true);
      expect(driver.environments.has("browser")).toBe(false);
      expect(driver.native).toBeInstanceOf(Storage);
    });

    it("is key-native: resolveNativeId returns the (root-scoped) object key", async () => {
      const driver = new GcsDriver({ ...baseOptions(), root: "tenant" });
      expect(await driver.resolveNativeId("a/b.txt")).toBe("tenant/a/b.txt");
    });

    it("throws AlreadyExistsError when overwrite is false", async () => {
      const storage = createStorage(makeDriver());
      await storage.put("once.txt", "first");
      await expect(
        storage.unwrap().put("once.txt", "second", { overwrite: false }),
      ).rejects.toMatchObject({ code: "ALREADY_EXISTS" });
    });

    it("preserves custom metadata through stat", async () => {
      const driver = makeDriver();
      await driver.put("meta.txt", "data", { metadata: { owner: "alice" } });
      const entry = await driver.stat("meta.txt");
      expect(entry.size).toBe(4);
      expect(entry.metadata).toMatchObject({ owner: "alice" });
    });
  });
}
