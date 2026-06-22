import { describe, expect, it, vi } from "vitest";

import {
  MemoryDriver,
  RateLimitError,
  UnavailableError,
  createStorage,
  isRetryableError,
  withRetry,
  type RetryEvent,
  type StorageEvents,
} from "../src/index";

const instantSleep = (): Promise<void> => Promise.resolve();

describe("withRetry", () => {
  it("returns on first success without sleeping", async () => {
    const fn = vi.fn(async () => "ok");
    expect(await withRetry(fn, { sleep: instantSleep })).toBe("ok");
    expect(fn).toHaveBeenCalledOnce();
  });

  it("retries a transient error then succeeds", async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw new UnavailableError();
      return "recovered";
    });
    const onRetry = vi.fn();
    expect(await withRetry(fn, { sleep: instantSleep, onRetry })).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it("gives up after maxAttempts and rethrows the last error", async () => {
    const fn = vi.fn(async () => {
      throw new UnavailableError("still down");
    });
    await expect(withRetry(fn, { maxAttempts: 3, sleep: instantSleep })).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry a non-retryable error", async () => {
    const fn = vi.fn(async () => {
      throw new Error("nope");
    });
    await expect(withRetry(fn, { sleep: instantSleep })).rejects.toThrow("nope");
    expect(fn).toHaveBeenCalledOnce();
  });

  it("honors RateLimitError.retryAfterMs exactly (no jitter)", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const fn = async () => {
      calls += 1;
      if (calls === 1) throw new RateLimitError("slow down", 1234);
      return "ok";
    };
    await withRetry(fn, { sleep: (ms) => (sleeps.push(ms), Promise.resolve()) });
    expect(sleeps).toEqual([1234]);
  });

  it("isRetryableError classifies the transient errors", () => {
    expect(isRetryableError(new RateLimitError())).toBe(true);
    expect(isRetryableError(new UnavailableError())).toBe(true);
    expect(isRetryableError(new TypeError("fetch failed"))).toBe(true);
    expect(isRetryableError({ code: "ECONNRESET" })).toBe(true);
    expect(isRetryableError(new Error("plain"))).toBe(false);
  });
});

/** Wraps a driver, failing the first N `put` calls with a transient error. */
function flakyPut(driver: MemoryDriver, failures: number): MemoryDriver {
  let remaining = failures;
  const original = driver.put.bind(driver);
  driver.put = ((path, data, opts) => {
    if (remaining > 0) {
      remaining -= 1;
      return Promise.reject(new UnavailableError());
    }
    return original(path, data, opts);
  }) as MemoryDriver["put"];
  return driver;
}

describe("Disk hardening integration", () => {
  it("retries a flaky operation when retry is enabled", async () => {
    const driver = flakyPut(new MemoryDriver(), 2);
    const retries: RetryEvent[] = [];
    const storage = createStorage(driver, {
      retry: { sleep: instantSleep, maxAttempts: 5 },
      events: { onRetry: (event) => retries.push(event) },
    });

    const entry = await storage.put("flaky.txt", "payload");
    expect(entry.path).toBe("flaky.txt");
    expect(retries).toHaveLength(2);
    expect(retries[0]).toMatchObject({ operation: "put", path: "flaky.txt", attempt: 1 });
  });

  it("does not retry when retry is disabled (default)", async () => {
    const driver = flakyPut(new MemoryDriver(), 1);
    const storage = createStorage(driver);
    await expect(storage.put("x.txt", "y")).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("emits success and error events with timing", async () => {
    const events: string[] = [];
    const recorder: StorageEvents = {
      onSuccess: (e) => events.push(`success:${e.operation}:${e.path}`),
      onError: (e) => events.push(`error:${e.operation}:${e.path}`),
    };
    const storage = createStorage(new MemoryDriver(), { events: recorder });

    await storage.put("a.txt", "data");
    await expect(storage.get("missing.txt")).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(events).toContain("success:put:a.txt");
    expect(events).toContain("error:get:missing.txt");
  });

  it("emits a success event after a list completes", async () => {
    const events: string[] = [];
    const storage = createStorage(new MemoryDriver(), {
      events: { onSuccess: (e) => events.push(e.operation) },
    });
    await storage.put("dir/f.txt", "x");
    for await (const _entry of storage.list("dir")) {
      /* drain */
    }
    expect(events).toContain("list");
  });
});
