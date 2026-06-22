# @rocketbean/genera

> One API for every cloud storage provider.

Write your application against a single storage contract. Switching providers becomes a
config change, not a code change. Genera is **driver-based**, **fully typed**, and
**isomorphic** — the core runs unchanged in the browser and in Node.js.

This package ships the core contract, the `MemoryDriver` (isomorphic) and `FsDriver`
(Node, via `@rocketbean/genera/node`), the conformance kit
(`@rocketbean/genera/conformance`), the OAuth2 + PKCE auth layer, retry/observability
helpers, and the `EncryptionDriver` / `transfer` utilities. Cloud providers ship as
companion packages: `@rocketbean/genera-s3` (AWS + R2/Spaces/B2/Wasabi/MinIO/IDrive),
`-gcs`, `-azure`, `-dropbox`, `-onedrive`, `-gdrive`, `-box`. See the repo's
`docs/capability-matrix.md`.

## Install

```bash
npm install @rocketbean/genera
```

## Quick start

```ts
import { createStorage, MemoryDriver } from "@rocketbean/genera";

const storage = createStorage(new MemoryDriver());

await storage.put("users/42/avatar.png", new Uint8Array([/* … */]));

const bytes = await storage.get("users/42/avatar.png"); // Uint8Array
const here  = await storage.exists("users/42/avatar.png"); // boolean

for await (const entry of storage.list("users/42")) {
  console.log(entry.type, entry.path); // "file" | "directory", canonical path
}

await storage.delete("users/42/avatar.png"); // idempotent
```

`put()` accepts any web-standard byte source — `string | Uint8Array | ArrayBuffer | Blob |
ReadableStream` — so the same call works on both sides of the wire. On Node, `Buffer`
satisfies `Uint8Array`, so it is accepted too.

## Multiple disks

```ts
import { createManager, MemoryDriver } from "@rocketbean/genera";

const storage = createManager({
  default: "local",
  disks: {
    local:  new MemoryDriver(),
    tenant: new MemoryDriver({ root: "tenant-123" }), // every path scoped under this prefix
  },
});

await storage.disk("tenant").put("file.txt", "lands at tenant-123/file.txt natively");
await storage.disk().put("note.txt", "goes to the default disk");
```

## Escape hatch

The abstraction is never a cage. Drop to the concrete driver when you need a
provider-specific feature:

```ts
const disk = createStorage(new MemoryDriver());

const mem = disk.as(MemoryDriver); // runtime-checked narrowing → fully typed driver
mem.native;                        // the raw underlying client (here, the backing Map)
await mem.resolveNativeId("a.txt"); // virtual path → native id (S3 key / Drive ID / …)
```

`disk.as(Wrong)` throws `DriverMismatchError`. Reaching for `.as()` / `.native` is the
visible, intentional signal that you're stepping outside the portable core.

## Errors

Every failure is a `StorageError` subclass with a stable `code` — match on the code, not the
message: `NotFoundError` (`NOT_FOUND`), `AlreadyExistsError`, `InvalidPathError`,
`AuthError`, `PermissionError`, `RateLimitError` (`RATE_LIMITED`, with `retryAfterMs`),
`UnavailableError` (`UNAVAILABLE`), `OperationNotSupportedError`, `DriverMismatchError`.
The last two transient codes are what the built-in `withRetry` layer retries by default.

## Writing a driver

Extend `BaseDriver` (which provides root-scoping and capability helpers), implement the five
core methods plus the escape-hatch members, and declare what you support:

```ts
import { BaseDriver, Capability, type Environment } from "@rocketbean/genera";

class MyDriver extends BaseDriver</* NativeClientType */> {
  readonly capabilities = new Set([Capability.SignedUrl, Capability.Copy]);
  readonly environments = new Set<Environment>(["node"]); // e.g. Node-only SDK

  // implement: put, get, list, delete, exists, resolveNativeId, and the `native` getter
}
```

Then **certify it** against the shared conformance kit (`test/conformance.ts`):

```ts
import { describeConformance } from "./test/conformance";

describeConformance("MyDriver", () => new MyDriver());
```

Passing the kit is what guarantees the swap-and-it-works promise. (The kit will ship as a
published subpath export so third-party drivers can self-certify.)

## Scripts

```bash
npm run build      # dual ESM + CJS bundles + .d.ts (tsup)
npm test           # run the suite, incl. the conformance kit (vitest)
npm run typecheck  # tsc --noEmit, strict
```

## License

MIT
