import { beforeAll, describe, expect, it } from "vitest";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";

import { Capability, createStorage, staticCredentials } from "@rocketbean/genera";
import { describeConformance } from "@rocketbean/genera/conformance";

import { S3Driver, type S3DriverOptions } from "../src/index";

/**
 * Conformance + driver-specific tests run only when an S3 endpoint is configured,
 * so the suite stays green on a machine without an emulator. To run them:
 *
 *   docker compose up -d minio            # repo root (see docker-compose.yml)
 *   GENERA_S3_TEST_ENDPOINT=http://localhost:9000 \
 *   GENERA_S3_TEST_ACCESS_KEY=minioadmin \
 *   GENERA_S3_TEST_SECRET_KEY=minioadmin \
 *     pnpm --filter @rocketbean/genera-s3 test
 */
const ENDPOINT = process.env.GENERA_S3_TEST_ENDPOINT;
const BUCKET = process.env.GENERA_S3_TEST_BUCKET ?? "genera-conformance";
const REGION = process.env.GENERA_S3_TEST_REGION ?? "us-east-1";
const ACCESS_KEY = process.env.GENERA_S3_TEST_ACCESS_KEY ?? "minioadmin";
const SECRET_KEY = process.env.GENERA_S3_TEST_SECRET_KEY ?? "minioadmin";

function baseOptions(): S3DriverOptions {
  return {
    bucket: BUCKET,
    region: REGION,
    ...(ENDPOINT ? { endpoint: ENDPOINT } : {}),
    forcePathStyle: true,
    credentials: staticCredentials({
      accessKeyId: ACCESS_KEY,
      secretAccessKey: SECRET_KEY,
    }),
  };
}

// A fresh, isolated root per driver instance keeps every test (and re-run) in its
// own namespace within the shared bucket — no cross-test contamination.
function makeDriver(): S3Driver {
  return new S3Driver({ ...baseOptions(), root: `conf-${crypto.randomUUID()}` });
}

if (!ENDPOINT) {
  describe.skip("S3Driver (set GENERA_S3_TEST_ENDPOINT to run against MinIO/live)", () => {
    it("skipped — no S3 endpoint configured", () => {});
  });
} else {
  beforeAll(async () => {
    const client = new S3Client({
      region: REGION,
      endpoint: ENDPOINT,
      forcePathStyle: true,
      credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
    });
    try {
      await client.send(new CreateBucketCommand({ Bucket: BUCKET }));
    } catch (error) {
      // Bucket already exists from a previous run — fine.
      const name = (error as { name?: string }).name;
      if (name !== "BucketAlreadyOwnedByYou" && name !== "BucketAlreadyExists") {
        throw error;
      }
    }
  });

  // The linchpin: the S3 driver must satisfy the full portable contract.
  describeConformance("S3", makeDriver);

  describe("S3Driver specifics", () => {
    it("is isomorphic and exposes the S3Client as native", () => {
      const driver = makeDriver();
      expect(driver.environments.has("node")).toBe(true);
      expect(driver.environments.has("browser")).toBe(true);
      expect(driver.native).toBeInstanceOf(S3Client);
    });

    it("is key-native: resolveNativeId returns the (root-scoped) object key", async () => {
      const driver = new S3Driver({ ...baseOptions(), root: "tenant" });
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

    it("generates a presigned URL for the resolved key", async () => {
      const storage = createStorage(makeDriver());
      await storage.put("signed.txt", "x");
      const url = await storage.getSignedUrl("signed.txt", { expiresIn: 120 });
      expect(url).toContain("signed.txt");
      expect(url).toContain("X-Amz-Signature");
    });

    it("round-trips a large buffer via multipart upload (Capability.Stream)", async () => {
      const driver = makeDriver();
      expect(driver.capabilities.has(Capability.Stream)).toBe(true);
      // 6 MiB → above the 5 MiB threshold → goes through lib-storage's Upload.
      const big = new Uint8Array(6 * 1024 * 1024);
      for (let i = 0; i < big.length; i += 4093) big[i] = i % 256;
      const entry = await driver.put("big.bin", big);
      expect(entry.size).toBe(big.length);
      const read = await driver.get("big.bin");
      expect(read.length).toBe(big.length);
      expect(read[4093]).toBe(big[4093]);
    });

    it("uploads from a ReadableStream", async () => {
      const driver = makeDriver();
      const payload = new TextEncoder().encode("streamed payload");
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(payload);
          controller.close();
        },
      });
      const entry = await driver.put("streamed.txt", stream);
      expect(entry.size).toBe(payload.length);
      expect(new TextDecoder().decode(await driver.get("streamed.txt"))).toBe("streamed payload");
    });
  });
}
