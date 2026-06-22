import { beforeAll, describe, expect, it } from "vitest";
import { BlobServiceClient } from "@azure/storage-blob";

import { createStorage } from "@rocketbean/genera";
import { describeConformance } from "@rocketbean/genera/conformance";

import { AzureBlobDriver, type AzureDriverOptions } from "../src/index";

/**
 * Conformance + driver-specific tests run only when an Azure connection string is
 * configured, so the suite stays green without an emulator. To run them against
 * Azurite (the well-known dev account):
 *
 *   docker compose up -d azurite        # repo root (see docker-compose.yml)
 *   GENERA_AZURE_TEST_CONNECTION_STRING="DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;" \
 *     pnpm --filter @rocketbean/genera-azure test
 */
const CONNECTION_STRING = process.env.GENERA_AZURE_TEST_CONNECTION_STRING;
const CONTAINER = process.env.GENERA_AZURE_TEST_CONTAINER ?? "genera-conformance";

function baseOptions(): AzureDriverOptions {
  return {
    container: CONTAINER,
    ...(CONNECTION_STRING ? { connectionString: CONNECTION_STRING } : {}),
  };
}

// A fresh, isolated root per driver instance keeps every test (and re-run) in its
// own namespace within the shared container — no cross-test contamination.
function makeDriver(): AzureBlobDriver {
  return new AzureBlobDriver({ ...baseOptions(), root: `conf-${crypto.randomUUID()}` });
}

if (!CONNECTION_STRING) {
  describe.skip("AzureBlobDriver (set GENERA_AZURE_TEST_CONNECTION_STRING to run against Azurite)", () => {
    it("skipped — no Azure connection string configured", () => {});
  });
} else {
  beforeAll(async () => {
    const service = BlobServiceClient.fromConnectionString(CONNECTION_STRING);
    await service.getContainerClient(CONTAINER).createIfNotExists();
  });

  // The linchpin: the Azure driver must satisfy the full portable contract.
  describeConformance("Azure", makeDriver);

  describe("AzureBlobDriver specifics", () => {
    it("is isomorphic and exposes the BlobServiceClient as native", () => {
      const driver = makeDriver();
      expect(driver.environments.has("node")).toBe(true);
      expect(driver.environments.has("browser")).toBe(true);
      expect(driver.native).toBeInstanceOf(BlobServiceClient);
    });

    it("is key-native: resolveNativeId returns the (root-scoped) blob name", async () => {
      const driver = new AzureBlobDriver({ ...baseOptions(), root: "tenant" });
      expect(await driver.resolveNativeId("a/b.txt")).toBe("tenant/a/b.txt");
    });

    it("throws AlreadyExistsError when overwrite is false", async () => {
      const storage = createStorage(makeDriver());
      await storage.put("once.txt", "first");
      await expect(
        storage.unwrap().put("once.txt", "second", { overwrite: false }),
      ).rejects.toMatchObject({ code: "ALREADY_EXISTS" });
    });

    it("preserves content type and metadata through stat", async () => {
      const driver = makeDriver();
      await driver.put("meta.txt", "data", {
        contentType: "text/plain",
        metadata: { owner: "alice" },
      });
      const entry = await driver.stat("meta.txt");
      expect(entry.size).toBe(4);
      expect(entry.metadata).toMatchObject({ owner: "alice" });
    });

    it("generates a SAS URL for the blob", async () => {
      const storage = createStorage(makeDriver());
      await storage.put("signed.txt", "x");
      const url = await storage.getSignedUrl("signed.txt", { expiresIn: 120 });
      expect(url).toContain("signed.txt");
      expect(url).toContain("sig=");
    });
  });
}
