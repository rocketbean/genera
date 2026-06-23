# Genera

**One API for every cloud storage provider.** A driver-based, provider-agnostic,
isomorphic (browser + Node) storage layer for TypeScript. Write your application
once against a small portable contract, then switch between AWS S3, Google Cloud
Storage, Azure Blob, Dropbox, OneDrive, Google Drive, Box — or your own driver —
by changing **configuration, not code**.

```ts
import { createStorage, staticCredentials } from "@rocketbean/genera";
import { S3Driver } from "@rocketbean/genera-s3";

const storage = createStorage(
  new S3Driver({
    bucket: "my-bucket",
    region: "us-east-1",
    credentials: staticCredentials({
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    }),
  }),
);

const bytes = new Uint8Array([/* your file bytes */]);
await storage.put("users/42/avatar.png", bytes, { contentType: "image/png" });
const data = await storage.get("users/42/avatar.png");
for await (const entry of storage.list("users/42")) console.log(entry.path);
```

---

## Table of contents

- [Why Genera](#why-genera)
- [Installation](#installation)
- [Getting started](#getting-started)
- [Core concepts](#core-concepts)
  - [Drivers and disks](#drivers-and-disks)
  - [Paths](#paths)
  - [Capabilities](#capabilities)
  - [The escape hatch](#the-escape-hatch)
- [Core API](#core-api)
  - `[createStorage](#createstorage)`
  - [Portable operations](#portable-operations) — `put` · `get` · `list` · `delete` · `exists`
  - [Capability-gated operations](#capability-gated-operations) — `copy` · `move` · `stat` · `getSignedUrl` · `getStream` · `createDirectory` · `deleteDirectory`
  - [Multiple disks (`StorageManager`)](#multiple-disks-storagemanager)
- [Types reference](#types-reference)
- [Supported providers](#supported-providers)
  - [Capability matrix](#capability-matrix)
  - [Memory](#memory-built-in)
  - [Filesystem](#filesystem-built-in)
  - [S3 and S3-compatible](#s3-and-s3-compatible)
  - [Google Cloud Storage](#google-cloud-storage)
  - [Azure Blob Storage](#azure-blob-storage)
  - [Dropbox](#dropbox)
  - [OneDrive](#onedrive)
  - [Google Drive](#google-drive)
  - [Box](#box)
- [Authentication](#authentication)
  - [Static credentials](#static-credentials)
  - [OAuth 2.0 + PKCE](#oauth-20--pkce)
- [Resilience: retries and rate limits](#resilience-retries-and-rate-limits)
- [Observability: events](#observability-events)
- [Streaming](#streaming)
- [Encryption at rest](#encryption-at-rest)
- [Cross-provider transfer](#cross-provider-transfer)
- [Wrapper drivers](#wrapper-drivers)
- [Error handling](#error-handling)
- [Writing a driver](#writing-a-driver)
- [Testing and the conformance kit](#testing-and-the-conformance-kit)
- [Packages](#packages)
- [Development](#development)
- [Releasing](#releasing)
- [License](#license)

---

## Why Genera

- **Portable core.** Five operations — `put` / `get` / `list` / `delete` / `exists` —
behave identically across every provider, verified by a shared **conformance kit**.
- **Capabilities, not assumptions.** Richer operations (copy, move, stat, signed
URLs, directories, streaming) are *advertised* per driver and gated; calling one a
driver doesn't support throws a typed `OperationNotSupportedError`.
- **Isomorphic.** The core uses only web-standard primitives (no Node built-ins) and
passes its conformance kit in both Node and a real browser.
- **Escape hatch.** Drop to the raw provider SDK any time via `disk.as(Driver).native`.
- **Batteries included.** OAuth 2.0 + PKCE auth layer, retry/backoff with rate-limit
handling, observability hooks, AES-256-GCM encryption-at-rest, and a cross-provider
`transfer` utility.

## Installation

Genera is a small dependency-light **core** plus one package per provider. Install
the core and the driver(s) you need; each driver declares its cloud SDK as a peer
dependency, so you install only what you use.

```bash
# core (required)
npm install @rocketbean/genera

# pick your provider(s) + their SDK (peer dependency)
npm install @rocketbean/genera-s3        @aws-sdk/client-s3 @aws-sdk/lib-storage @aws-sdk/s3-request-presigner
npm install @rocketbean/genera-gcs       @google-cloud/storage
npm install @rocketbean/genera-azure     @azure/storage-blob
npm install @rocketbean/genera-dropbox   dropbox
npm install @rocketbean/genera-onedrive  @microsoft/microsoft-graph-client
npm install @rocketbean/genera-gdrive    @googleapis/drive
npm install @rocketbean/genera-box       box-node-sdk
```

Requires Node 18+ (for global `fetch` / Web Crypto) or any modern browser.

## Getting started

```ts
import { createStorage, MemoryDriver } from "@rocketbean/genera";

// 1. Create a disk from any driver.
const storage = createStorage(new MemoryDriver());

// 2. Use the five portable operations.
await storage.put("a/b.txt", "hello world");        // string | bytes | Blob | stream
const bytes = await storage.get("a/b.txt");          // Uint8Array
const ok = await storage.exists("a/b.txt");          // boolean
for await (const entry of storage.list("a")) {       // async iterable
  console.log(entry.type, entry.path);               // "file" | "directory", canonical path
}
await storage.delete("a/b.txt");                     // idempotent
```

Switch providers by swapping the driver — every call above is unchanged:

```ts
import { S3Driver } from "@rocketbean/genera-s3";
import { createStorage, staticCredentials } from "@rocketbean/genera";

const storage = createStorage(
  new S3Driver({
    bucket: "my-bucket",
    region: "us-east-1",
    credentials: staticCredentials({
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    }),
  }),
);
```

## Core concepts

### Drivers and disks

- A **driver** (`StorageDriver`) maps the portable contract onto one provider. You
rarely call a driver directly.
- A `**Disk`** wraps a driver (`createStorage(driver)`), adds capability gating, and
optionally retries + events. This is what your app uses.
- A `**StorageManager**` holds several named disks (`createManager(...)`).

### Paths

All paths are **canonical**: POSIX forward slashes, no leading slash, Unicode
normalized to NFC, and `..` traversal rejected (`InvalidPathError`). `"users/42/a.png"`
is valid; `"/users"`, `"../x"`, and backslashes are normalized or rejected.

Every driver accepts a `root` option that scopes all paths under a prefix — useful
for multi-tenant isolation:

```ts
import { MemoryDriver } from "@rocketbean/genera";

new MemoryDriver({ root: "tenant-123" }); // put("a.txt") lands at tenant-123/a.txt natively
```

### Capabilities

Beyond the five core operations, drivers advertise optional ones via `disk.capabilities`
(a `ReadonlySet<Capability>`). Check before calling, or call and catch:

```ts
import { Capability } from "@rocketbean/genera";

if (storage.capabilities.has(Capability.SignedUrl)) {
  const url = await storage.getSignedUrl("a/b.txt", { expiresIn: 900 });
}
```

`Capability` values: `SignedUrl`, `Stream`, `Copy`, `Move`, `Stat`,
`CreateDirectory`, `DeleteDirectory`, `PublicUrl`, `Append`.

### The escape hatch

The abstraction is never a cage. Reach the underlying SDK when you need a
provider-specific feature:

```ts
import { S3Driver } from "@rocketbean/genera-s3";

const s3 = storage.as(S3Driver); // runtime-checked narrowing → typed driver (throws DriverMismatchError if wrong)
s3.native;                        // the raw S3Client
await s3.resolveNativeId("a.png"); // canonical path → provider-native id (key / path / file id)
storage.unwrap();                 // the underlying StorageDriver instance
```

## Core API

### `createStorage`

```ts skip
createStorage(driver: StorageDriver, options?: DiskOptions): Disk
```

`DiskOptions`:


| Option   | Type                     | Default | Description                                                                                      |
| -------- | ------------------------ | ------- | ------------------------------------------------------------------------------------------------ |
| `retry`  | `boolean | RetryOptions` | off     | Retry transient failures. `true` = defaults; see [retries](#resilience-retries-and-rate-limits). |
| `events` | `StorageEvents`          | –       | Observability hooks fired around each operation; see [events](#observability-events).            |


### Portable operations

Every driver implements these and they behave identically everywhere.

`**put(path, data, opts?): Promise<StorageEntry>**` — write an object.


| Param              | Type                     | Description                                                                       |
| ------------------ | ------------------------ | --------------------------------------------------------------------------------- |
| `path`             | `string`                 | Canonical destination path.                                                       |
| `data`             | `PutData`                | `string | Uint8Array | ArrayBuffer | Blob | ReadableStream`.                      |
| `opts.contentType` | `string?`                | MIME type stored with the object.                                                 |
| `opts.metadata`    | `Record<string,string>?` | Custom metadata (where the provider supports it).                                 |
| `opts.overwrite`   | `boolean?`               | When `false`, throws `AlreadyExistsError` instead of overwriting. Default `true`. |


```ts
await storage.put("report.csv", "a,b,c\n", { contentType: "text/csv" });
await storage.put("once.txt", "v", { overwrite: false }); // fails if it exists
```

`**get(path): Promise<Uint8Array>**` — read an object's bytes. Throws
`NotFoundError` if missing.

`**list(prefix?, opts?): AsyncIterable<StorageEntry>**` — list entries under a prefix.


| Param            | Type       | Description                                                                                                                  |
| ---------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `prefix`         | `string?`  | Folder to list. Omit/`""` for the root.                                                                                      |
| `opts.recursive` | `boolean?` | `false` (default) returns one level (files + synthesized `directory` entries); `true` returns every file beneath the prefix. |
| `opts.limit`     | `number?`  | Cap the number of entries yielded.                                                                                           |


```ts
for await (const e of storage.list("docs", { recursive: true })) {
  if (e.type === "file") console.log(e.path, e.size);
}
```

`**delete(path): Promise<void>**` — remove an object. **Idempotent** — deleting a
missing path is a no-op.

`**exists(path): Promise<boolean>`** — whether an object exists.

### Capability-gated operations

Available only when the driver advertises the matching `Capability` (otherwise
`OperationNotSupportedError`).


| Method                      | Capability        | Description                                                                                                      |
| --------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------- |
| `copy(from, to)`            | `Copy`            | Copy an object; returns the new `StorageEntry`.                                                                  |
| `move(from, to)`            | `Move`            | Move/rename an object.                                                                                           |
| `stat(path)`                | `Stat`            | Rich metadata (`size`, `modifiedAt`, `etag`, `metadata`).                                                        |
| `getSignedUrl(path, opts?)` | `SignedUrl`       | A time-limited URL. `opts.expiresIn` (seconds, default 900), `opts.action` (`"read"` | `"write"`, default read). |
| `getStream(path)`           | `Stream`          | Download as a `ReadableStream<Uint8Array>` without buffering.                                                    |
| `createDirectory(path)`     | `CreateDirectory` | Explicitly create a folder.                                                                                      |
| `deleteDirectory(path)`     | `DeleteDirectory` | Recursively delete a folder.                                                                                     |


```ts
await storage.copy("a.txt", "b.txt");
const meta = await storage.stat("a.txt");          // { size, modifiedAt, etag, ... }
const url = await storage.getSignedUrl("a.txt", { expiresIn: 600, action: "read" });
const stream = await storage.getStream("big.bin"); // pipe it somewhere
```

### Multiple disks (`StorageManager`)

```ts
import { createManager, MemoryDriver, staticCredentials } from "@rocketbean/genera";
import { S3Driver } from "@rocketbean/genera-s3";

const storage = createManager({
  default: "uploads",
  disks: {
    uploads: new S3Driver({
      bucket: "uploads",
      region: "us-east-1",
      credentials: staticCredentials({
        accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
      }),
    }),
    cache: new MemoryDriver(),
  },
  options: { retry: true }, // applied to every disk
});

await storage.disk("cache").put("k", "v");
await storage.disk().put("photo.jpg", new Uint8Array([/* … */])); // the default disk ("uploads")
```

## Types reference

```ts
interface StorageEntry {
  path: string;                 // canonical path, e.g. "users/42/a.png"
  name: string;                 // last segment, e.g. "a.png"
  type: "file" | "directory";
  size?: number;                // bytes (files)
  modifiedAt?: Date;
  etag?: string;
  metadata?: Record<string, string>;
}

type PutData = string | Uint8Array | ArrayBuffer | Blob | ReadableStream;

interface PutOptions { contentType?: string; metadata?: Record<string, string>; overwrite?: boolean }
interface ListOptions { recursive?: boolean; limit?: number }
interface SignedUrlOptions { expiresIn?: number; action?: "read" | "write" }

type Environment = "node" | "browser";
```

## Supported providers

Each driver shares one addressing flavor: **key-native** (the path *is* the object
key), **path-native** (a trivial path translation), or **id-native** (paths resolve
to opaque ids via the cached `PathResolver`).

### Capability matrix


| Driver               | Package                       | Runtime        | Addressing | SignedUrl | Stream | Copy | Move | Stat | CreateDir | DeleteDir |
| -------------------- | ----------------------------- | -------------- | ---------- | --------- | ------ | ---- | ---- | ---- | --------- | --------- |
| Memory               | `@rocketbean/genera`          | node + browser | key        | –         | ✅      | ✅    | ✅    | ✅    | –         | –         |
| Filesystem           | `@rocketbean/genera/node`     | node           | key        | –         | –      | ✅    | ✅    | ✅    | ✅         | ✅         |
| S3 family            | `@rocketbean/genera-s3`       | node + browser | key        | ✅         | ✅      | ✅    | ✅    | ✅    | –         | –         |
| Google Cloud Storage | `@rocketbean/genera-gcs`      | node           | key        | ✅         | ✅      | ✅    | ✅    | ✅    | –         | –         |
| Azure Blob           | `@rocketbean/genera-azure`    | node + browser | key        | ✅         | ✅      | ✅    | ✅    | ✅    | –         | –         |
| Dropbox              | `@rocketbean/genera-dropbox`  | node + browser | path       | ✅¹        | ✅²     | ✅    | ✅    | ✅    | ✅         | ✅         |
| OneDrive             | `@rocketbean/genera-onedrive` | node + browser | path       | ✅¹        | ✅      | ✅    | ✅    | ✅    | ✅         | ✅         |
| Google Drive         | `@rocketbean/genera-gdrive`   | node           | id         | –         | ✅      | ✅    | ✅    | ✅    | ✅         | ✅         |
| Box                  | `@rocketbean/genera-box`      | node           | id         | –         | ✅      | ✅    | ✅    | ✅    | ✅         | ✅         |


¹ Dropbox/OneDrive "signed URLs" are **sharing links**, not time-limited presigned
URLs (`expiresIn` is ignored). ² Dropbox download is buffered by its SDK, so
`getStream` is a single-chunk wrapper (correct, not memory-saving).

### Memory (built-in)

Zero-dependency, fully isomorphic — ideal for tests and caches.

```ts
import { MemoryDriver, createStorage } from "@rocketbean/genera";
const storage = createStorage(new MemoryDriver({ root: "optional-prefix" }));
```

### Filesystem (built-in)

Local disk, Node-only. Imported from the `/node` subpath so the core stays
browser-safe.

```ts
import { FsDriver } from "@rocketbean/genera/node";
import { createStorage } from "@rocketbean/genera";

const storage = createStorage(new FsDriver({ baseDir: "./storage" }));
```


| Option    | Type     | Required | Description                                                                   |
| --------- | -------- | -------- | ----------------------------------------------------------------------------- |
| `baseDir` | `string` | ✅        | Directory on disk that backs this driver (absolute, or resolved against cwd). |
| `root`    | `string` | –        | Extra path prefix scoped under `baseDir`.                                     |


### S3 and S3-compatible

One driver for **AWS S3, Cloudflare R2, DigitalOcean Spaces, Backblaze B2, Wasabi,
MinIO, and IDrive e2** — they differ only in client config.

```ts
import { S3Driver } from "@rocketbean/genera-s3";
import { createStorage, staticCredentials } from "@rocketbean/genera";

const storage = createStorage(
  new S3Driver({
    bucket: "my-bucket",
    region: "us-east-1",
    credentials: staticCredentials({ accessKeyId: "…", secretAccessKey: "…" }),
  }),
);
```


| Option           | Type                                 | Required | Description                                                                                       |
| ---------------- | ------------------------------------ | -------- | ------------------------------------------------------------------------------------------------- |
| `bucket`         | `string`                             | ✅        | The bucket every operation targets.                                                               |
| `region`         | `string?`                            | –        | AWS region; `"auto"` for R2; any value the endpoint accepts otherwise.                            |
| `endpoint`       | `string?`                            | –        | Omit for AWS; **set** for every S3-compatible provider.                                           |
| `forcePathStyle` | `boolean?`                           | –        | Path-style addressing. Required by MinIO/R2/B2/Wasabi/IDrive.                                     |
| `credentials`    | `CredentialProvider<S3Credentials>?` | –        | Access keys via the auth seam. `S3Credentials = { accessKeyId, secretAccessKey, sessionToken? }`. |
| `client`         | `S3Client?`                          | –        | Bring your own configured client (overrides the above).                                           |
| `root`           | `string?`                            | –        | Path prefix for multi-tenant scoping.                                                             |


Per-provider config:


| Provider            | `endpoint`                                   | `region`    | `forcePathStyle` |
| ------------------- | -------------------------------------------- | ----------- | ---------------- |
| AWS S3              | (omit)                                       | real region | false            |
| Cloudflare R2       | `https://<account>.r2.cloudflarestorage.com` | `auto`      | true             |
| DigitalOcean Spaces | `https://<region>.digitaloceanspaces.com`    | region      | either           |
| Backblaze B2        | `https://s3.<region>.backblazeb2.com`        | region      | true             |
| Wasabi              | `https://s3.<region>.wasabisys.com`          | region      | true             |
| MinIO               | `http://localhost:9000`                      | `us-east-1` | true             |
| IDrive e2           | `https://<region>.idrivee2-XX.com`           | region      | true             |


```ts
import { S3Driver } from "@rocketbean/genera-s3";
import { staticCredentials } from "@rocketbean/genera";

// Cloudflare R2
new S3Driver({
  bucket: "my-bucket",
  region: "auto",
  endpoint: "https://<account>.r2.cloudflarestorage.com",
  forcePathStyle: true,
  credentials: staticCredentials({
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  }),
});
```

Capabilities: `SignedUrl`, `Stream` (multipart upload + streamed download), `Copy`,
`Move`, `Stat`. Isomorphic (in the browser, use presigned URLs or short-lived
scoped credentials — never long-lived keys).

### Google Cloud Storage

Node-only (the SDK uses Node built-ins). For the browser, route through the
S3-compatible endpoint or a server-generated signed URL.

```ts
import { GcsDriver } from "@rocketbean/genera-gcs";
import { createStorage } from "@rocketbean/genera";

// Application Default Credentials:
const storage = createStorage(new GcsDriver({ bucket: "my-bucket", projectId: "my-project" }));

// Explicit service account:
new GcsDriver({
  bucket: "my-bucket",
  projectId: "my-project",
  credentials: { client_email: "…", private_key: "…" },
});
```


| Option        | Type                             | Required | Description                                             |
| ------------- | -------------------------------- | -------- | ------------------------------------------------------- |
| `bucket`      | `string`                         | ✅        | Target bucket.                                          |
| `projectId`   | `string?`                        | –        | GCP project id (optional when ADC provides it).         |
| `apiEndpoint` | `string?`                        | –        | Custom endpoint (e.g. a fake-gcs-server URL for tests). |
| `credentials` | `{ client_email, private_key }?` | –        | Service-account key (else ADC is used).                 |
| `keyFilename` | `string?`                        | –        | Path to a service-account JSON file.                    |
| `storage`     | `Storage?`                       | –        | Bring your own configured `Storage` client.             |
| `root`        | `string?`                        | –        | Path prefix.                                            |


Capabilities: `SignedUrl`, `Stream`, `Copy`, `Move`, `Stat`.

### Azure Blob Storage

```ts
import { AzureBlobDriver } from "@rocketbean/genera-azure";
import { createStorage } from "@rocketbean/genera";

const storage = createStorage(
  new AzureBlobDriver({ container: "my-container", connectionString: "…" }),
);
```


| Option                   | Type                 | Required | Description                                                         |
| ------------------------ | -------------------- | -------- | ------------------------------------------------------------------- |
| `container`              | `string`             | ✅        | The blob container every operation targets.                         |
| `connectionString`       | `string?`            | –¹       | Connection string (Node; simplest shared-key path).                 |
| `account` + `accountKey` | `string?`            | –¹       | Shared-key auth (Node — never ship the key to a browser).           |
| `sasUrl`                 | `string?`            | –¹       | A service SAS URL — the browser-safe path (scoped, no account key). |
| `serviceClient`          | `BlobServiceClient?` | –¹       | Bring your own configured client.                                   |
| `root`                   | `string?`            | –        | Path prefix.                                                        |


¹ Provide exactly one auth source: `connectionString`, `account`+`accountKey`,
`sasUrl`, or `serviceClient`.

Capabilities: `SignedUrl` (SAS), `Stream`, `Copy`, `Move`, `Stat`. Isomorphic.

### Dropbox

Path-native, isomorphic. Authenticate with the [OAuth layer](#oauth-20--pkce).

```ts
import { DropboxDriver } from "@rocketbean/genera-dropbox";
import { createStorage } from "@rocketbean/genera";

const storage = createStorage(new DropboxDriver({ credentials: oauthProvider }));
// or, for quick scripts:
new DropboxDriver({ accessToken: "…" });
```


| Option        | Type                                   | Required | Description                                        |
| ------------- | -------------------------------------- | -------- | -------------------------------------------------- |
| `credentials` | `CredentialProvider<OAuthCredential>?` | –¹       | OAuth provider yielding a fresh token per request. |
| `accessToken` | `string?`                              | –¹       | A static token (expires; prefer `credentials`).    |
| `client`      | `Dropbox?`                             | –¹       | Bring your own SDK client.                         |
| `root`        | `string?`                              | –        | Path prefix.                                       |


¹ Provide one of `credentials`, `accessToken`, or `client`.

Capabilities: `SignedUrl` (shared link), `Stream`, `Copy`, `Move`, `Stat`,
`CreateDirectory`, `DeleteDirectory`.

### OneDrive

Microsoft Graph, path-native, isomorphic. The OAuth token is bridged into the
Graph auth provider for you.

```ts
import { OneDriveDriver } from "@rocketbean/genera-onedrive";
import { createStorage } from "@rocketbean/genera";

const storage = createStorage(new OneDriveDriver({ credentials: oauthProvider }));
```


| Option        | Type                                   | Required | Description                  |
| ------------- | -------------------------------------- | -------- | ---------------------------- |
| `credentials` | `CredentialProvider<OAuthCredential>?` | –¹       | OAuth provider.              |
| `accessToken` | `string?`                              | –¹       | Static token.                |
| `client`      | `Client?`                              | –¹       | Bring your own Graph client. |
| `root`        | `string?`                              | –        | Path prefix.                 |


¹ Provide one of `credentials`, `accessToken`, or `client`. Scopes: `Files.ReadWrite`
(+ `offline_access` for refresh tokens).

Capabilities: `SignedUrl` (sharing link), `Stream`, `Copy`, `Move`, `Stat`,
`CreateDirectory`, `DeleteDirectory`.

### Google Drive

ID-native, Node-only. Paths are resolved to Drive file ids by the cached
`PathResolver` (resolve-or-create folders, same-name-sibling policy). You supply a
configured `googleapis` auth client.

```ts
import { GoogleDriveDriver } from "@rocketbean/genera-gdrive";
import { createStorage } from "@rocketbean/genera";
import { OAuth2Client } from "google-auth-library";

// clientId + clientSecret come from your Google Cloud OAuth 2.0 client.
const auth = new OAuth2Client({
  clientId: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
});

// A refresh token obtained once via the consent flow (access_type=offline,
// scope https://www.googleapis.com/auth/drive). google-auth-library mints
// access tokens from it and refreshes them automatically.
auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });

const storage = createStorage(new GoogleDriveDriver({ auth }));
```


| Option         | Type                                   | Required | Description                                                            |
| -------------- | -------------------------------------- | -------- | ---------------------------------------------------------------------- |
| `auth`         | googleapis auth client                 | –¹       | e.g. `OAuth2Client`; the driver builds the Drive client from it.       |
| `drive`        | `drive_v3.Drive?`                      | –¹       | A fully-configured Drive client (instead of `auth`).                   |
| `credentials`  | `CredentialProvider<OAuthCredential>?` | –        | Pushes a fresh token onto `auth` before each request.                  |
| `driveId`      | `string?`                              | –        | Shared (Team) drive id; adds the all-drives params to every call.      |
| `rootFolderId` | `string?`                              | –        | Scope every path under this folder id instead of `"root"`.             |
| `onAmbiguous`  | `"first" | "error"`                    | –        | Same-name-sibling policy (Drive allows duplicates). Default `"first"`. |
| `root`         | `string?`                              | –        | Path prefix.                                                           |


¹ Provide `auth` or `drive`. Scope: `https://www.googleapis.com/auth/drive`.

Capabilities: `Stream`, `Copy`, `Move`, `Stat`, `CreateDirectory`, `DeleteDirectory`.
Layer-1 extra: `driver.export(path, mimeType)` for native Google Docs/Sheets.

### Box

ID-native (root folder id `"0"`), Node. The Box SDK's surface shifts between
versions, so the driver is typed structurally — you build and pass a `BoxClient`.

```ts
import { BoxDriver } from "@rocketbean/genera-box";
import { createStorage } from "@rocketbean/genera";
import { BoxClient, BoxDeveloperTokenAuth } from "box-node-sdk";

const client = new BoxClient({
  auth: new BoxDeveloperTokenAuth({ token: process.env.BOX_TOKEN! }),
});
const storage = createStorage(new BoxDriver({ client }));
```


| Option         | Type                | Required | Description                                                                              |
| -------------- | ------------------- | -------- | ---------------------------------------------------------------------------------------- |
| `client`       | `BoxClient`         | ✅        | A configured Box client (you choose the auth mode: Developer Token / OAuth / JWT / CCG). |
| `rootFolderId` | `string?`           | –        | Root folder id. Defaults to Box's account root, `"0"`.                                   |
| `onAmbiguous`  | `"first" | "error"` | –        | Same-name-sibling policy. Default `"first"`.                                             |
| `root`         | `string?`           | –        | Path prefix.                                                                             |


Capabilities: `Stream`, `Copy`, `Move`, `Stat`, `CreateDirectory`, `DeleteDirectory`.

## Authentication

Operations never see raw credentials — they ask a `CredentialProvider` for a
*currently-valid* credential. Acquisition is the app's concern; the storage layer
only ever consumes a fresh credential.

```ts
interface CredentialProvider<T> { getCredential(): Promise<T> }
```

### Static credentials

For long-lived keys (S3 family):

```ts
import { staticCredentials } from "@rocketbean/genera";
import { S3Driver } from "@rocketbean/genera-s3";

const credentials = staticCredentials({ accessKeyId: "…", secretAccessKey: "…" });
new S3Driver({ bucket: "my-bucket", region: "us-east-1", credentials });
```

### OAuth 2.0 + PKCE

For consumer drives (Dropbox, OneDrive, Google Drive, Box). Three decoupled pieces:

- `**OAuthFlow**` — the interactive authorization-code↔token exchange.
- `**OAuthCredentialProvider**` — `getCredential()` that returns a valid access
token, refreshing transparently (expiry skew, refresh-token rotation,
single-flight refresh-race lock).
- `**TokenStore**` — pluggable persistence (`MemoryTokenStore` by default).

```ts
import {
  OAuthFlow,
  OAuthCredentialProvider,
  MemoryTokenStore,
  createStorage,
} from "@rocketbean/genera";
import { DropboxDriver } from "@rocketbean/genera-dropbox";

const config = {
  clientId: "…",
  authorizationEndpoint: "https://www.dropbox.com/oauth2/authorize",
  tokenEndpoint: "https://api.dropboxapi.com/oauth2/token",
  revocationEndpoint: "https://api.dropboxapi.com/2/auth/token/revoke", // optional
  redirectUri: "https://app.example.com/callback",
  scopes: ["files.content.read", "files.content.write"],
  // clientSecret: "…",        // confidential (server) clients only; omit for public/PKCE
};

// 1. Send the user to authorize (store state + codeVerifier until the redirect returns).
const flow = new OAuthFlow(config);
const { url, state, codeVerifier } = await flow.createAuthorizationRequest();
// → redirect the user to `url`

// 2. On the redirect back, verify state + exchange the code (handleCallback does both):
const tokens = await flow.handleCallback(window.location.href, { state, codeVerifier });

// 3. Seed a store and hand the provider to the driver.
const store = new MemoryTokenStore(tokens);
const oauthProvider = new OAuthCredentialProvider(store, config, { skewMs: 60_000 });

const storage = createStorage(new DropboxDriver({ credentials: oauthProvider }));
```

`OAuthConfig` fields: `clientId`, `authorizationEndpoint`, `tokenEndpoint`,
`redirectUri` (required); `revocationEndpoint`, `scopes`, `clientSecret`,
`extraAuthParams` (optional). `OAuthCredentialProvider` options: `skewMs` (refresh
this many ms before expiry; default 60000). Sign out with `await oauthProvider.revoke()`
(revokes at the provider if `revocationEndpoint` is set, and always clears the store).

A custom `TokenStore` (e.g. Redis, for shared refresh across instances):

```ts skip
import type { TokenStore, TokenSet } from "@rocketbean/genera";

class RedisTokenStore implements TokenStore {
  async get(): Promise<TokenSet | undefined> { /* … */ }
  async set(tokens: TokenSet): Promise<void> { /* … */ }
  async clear(): Promise<void> { /* … */ }
}
```

> **Honest scope:** OAuth *setup* differs per provider, so the "swap is config-only"
> guarantee covers storage *operations*, not credential acquisition. The
> `CredentialProvider` seam is standardized; the credential payload and the flow are
> provider-shaped.

## Resilience: retries and rate limits

Opt in per disk; transient failures (rate limits, 5xx, network blips) are retried
with exponential backoff + jitter, honoring `Retry-After`.

```ts
import { createStorage } from "@rocketbean/genera";

const storage = createStorage(driver, {
  retry: { maxAttempts: 5, baseDelayMs: 200 },
});
```

`RetryOptions`:


| Option        | Type                 | Default                            | Description                                  |
| ------------- | -------------------- | ---------------------------------- | -------------------------------------------- |
| `maxAttempts` | `number`             | 3                                  | Total attempts including the first.          |
| `baseDelayMs` | `number`             | 100                                | Base backoff, doubled each attempt.          |
| `maxDelayMs`  | `number`             | 5000                               | Backoff ceiling.                             |
| `jitter`      | `boolean`            | true                               | Apply ±50% randomization to computed delays. |
| `isRetryable` | `(error) => boolean` | rate-limit / unavailable / network | Decide what to retry.                        |
| `onRetry`     | `(info) => void`     | –                                  | Called before each backoff wait.             |


Drivers map provider errors to `RateLimitError` (429, with `retryAfterMs`) and
`UnavailableError` (502/503/504), which the retry layer retries by default. The
standalone helper is also exported: `withRetry(fn, options?)`.

## Observability: events

```ts
import { createStorage } from "@rocketbean/genera";

const storage = createStorage(driver, {
  events: {
    onSuccess: (e) => metrics.timing(`storage.${e.operation}`, e.durationMs),
    onError: (e) => logger.warn({ op: e.operation, path: e.path, err: e.error }),
    onRetry: (e) => logger.info(`retry ${e.operation} attempt ${e.attempt} in ${e.delayMs}ms`),
  },
});
```

Each event carries `operation`, `path?`, and `durationMs` (`onError` adds `error`;
`onRetry` adds `attempt` + `delayMs`).

## Streaming

Drivers advertising `Capability.Stream` support memory-efficient I/O. `put` accepts
a `ReadableStream` (and large buffers upload via multipart where supported); `getStream`
returns a `ReadableStream<Uint8Array>`:

```ts
// stream a large upload (no full buffering on S3 — multipart)
await storage.put("big.zip", someReadableStream);

// stream a download
const stream = await storage.getStream("big.zip");
const res = new Response(stream); // e.g. serve it directly
```

Notes: S3 does true multipart upload; Box/Drive/OneDrive (Node) do true streamed
download; Dropbox download is buffered by its SDK (single-chunk stream).

## Encryption at rest

`EncryptionDriver` wraps any driver and transparently encrypts payloads with
AES-256-GCM (Web Crypto, isomorphic) before they reach the backend.

```ts
import { EncryptionDriver, importAesGcmKey, createStorage, MemoryDriver } from "@rocketbean/genera";

// A 32-byte (256-bit) AES key. Persist it — you need the same key to decrypt later.
const key = await importAesGcmKey(crypto.getRandomValues(new Uint8Array(32)));

const storage = createStorage(
  new EncryptionDriver(new MemoryDriver(), { key }), // wrap ANY driver (S3, GCS, Azure, …)
);

await storage.put("secret.txt", "top secret"); // ciphertext at rest; reads decrypt transparently
```

It delegates `copy`/`move`/`createDirectory`/`deleteDirectory` but drops
`Stat`/`SignedUrl`/`Stream` (ciphertext size and bytes differ from plaintext).

## Cross-provider transfer

Copy every file from one driver to another — works between *any* two providers.

```ts
import { transfer } from "@rocketbean/genera";

const result = await transfer(sourceDriver, destDriver, { prefix: "2024", overwrite: false });
console.log(`${result.files} files, ${result.bytes} bytes`);
```

`TransferOptions`: `prefix?` (limit to a subtree), `overwrite?` (skip existing when
`false`). Pass driver instances (use `disk.unwrap()` if you have a `Disk`).

## Wrapper drivers

`WrapperDriver` is the base for composable decorators — extend it and override only
what you change. `EncryptionDriver` is one example; the same pattern enables caching,
mirroring/failover, and logging wrappers on top of any driver.

```ts
import { WrapperDriver } from "@rocketbean/genera";

class LoggingDriver extends WrapperDriver {
  override async get(path: string) {
    console.log("get", path);
    return super.get(path); // delegates to the inner driver
  }
}
```

## Error handling

Every failure is a `StorageError` subclass with a stable `code` — match on the code,
not the message.


| Class                        | `code`                    | When                                             |
| ---------------------------- | ------------------------- | ------------------------------------------------ |
| `NotFoundError`              | `NOT_FOUND`               | object/path missing                              |
| `AlreadyExistsError`         | `ALREADY_EXISTS`          | `overwrite: false` hit an existing object / 409  |
| `InvalidPathError`           | `INVALID_PATH`            | bad path (`..`, null bytes)                      |
| `AuthError`                  | `AUTH`                    | authentication failed (401)                      |
| `PermissionError`            | `PERMISSION`              | access denied (403)                              |
| `RateLimitError`             | `RATE_LIMITED`            | 429 (carries `retryAfterMs`)                     |
| `UnavailableError`           | `UNAVAILABLE`             | transient 502/503/504                            |
| `OperationNotSupportedError` | `OPERATION_NOT_SUPPORTED` | capability not advertised (carries `capability`) |
| `DriverMismatchError`        | `DRIVER_MISMATCH`         | `disk.as(WrongDriver)`                           |


```ts
import { NotFoundError } from "@rocketbean/genera";

try {
  await storage.get("missing.txt");
} catch (e) {
  if (e instanceof NotFoundError) {/* … */}
  // or: if ((e as StorageError).code === "NOT_FOUND") { … }
}
```

## Writing a driver

Implement the contract, pass the conformance kit, and your driver is a drop-in for
every other. See **[docs/authoring-a-driver.md](docs/authoring-a-driver.md)** for the
full walkthrough; the short version:

```ts skip
import { BaseDriver, Capability, type Environment } from "@rocketbean/genera";

class MyDriver extends BaseDriver<MyClient> {
  readonly capabilities = new Set([Capability.Copy, Capability.Stat]);
  readonly environments = new Set<Environment>(["node", "browser"]);
  get native(): MyClient { return this.client; }
  // implement put, get, list, delete, exists, resolveNativeId (+ advertised optionals)
}
```

```ts skip
import { describeConformance } from "@rocketbean/genera/conformance";
describeConformance("MyDriver", () => new MyDriver());
```

## Testing and the conformance kit

The conformance kit is the linchpin of the "swap and it works" guarantee — every
driver must pass it. It's published as a subpath export so third-party drivers can
self-certify:

```ts
import { describeConformance } from "@rocketbean/genera/conformance";
```

Locally, drivers test against emulators (no live accounts needed) and a real
browser:

```bash
docker compose up -d            # MinIO (S3), Azurite (Azure), fake-gcs-server (GCS)
corepack pnpm -r test           # node suites (cloud conformance is env-gated)
corepack pnpm --filter @rocketbean/genera test:browser   # in-browser conformance
```

## Packages


| Package                       | Subpath exports              | Description                                                                                  |
| ----------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------- |
| `@rocketbean/genera`          | `.`, `/node`, `/conformance` | Core contract, Memory + FS drivers, conformance kit, OAuth, retry/events, wrappers, transfer |
| `@rocketbean/genera-s3`       | `.`                          | AWS S3 + R2 / Spaces / B2 / Wasabi / MinIO / IDrive e2                                       |
| `@rocketbean/genera-gcs`      | `.`                          | Google Cloud Storage (Node)                                                                  |
| `@rocketbean/genera-azure`    | `.`                          | Azure Blob Storage                                                                           |
| `@rocketbean/genera-dropbox`  | `.`                          | Dropbox                                                                                      |
| `@rocketbean/genera-onedrive` | `.`                          | OneDrive (Microsoft Graph)                                                                   |
| `@rocketbean/genera-gdrive`   | `.`                          | Google Drive (Node)                                                                          |
| `@rocketbean/genera-box`      | `.`                          | Box (Node)                                                                                   |


## Development

A pnpm monorepo. `corepack pnpm install`, then:

```bash
corepack pnpm -r build       # build every package (tsup, dual ESM + CJS + .d.ts)
corepack pnpm -r typecheck   # tsc --noEmit, strict
corepack pnpm lint           # ESLint (enforces no Node built-ins in the isomorphic core)
corepack pnpm -r test        # vitest (cloud conformance is env-gated; see each driver test)
docker compose up -d         # local emulators
docker compose down          # stop them
```

Cloud conformance runs against emulators or live endpoints via env vars, e.g.
`GENERA_S3_TEST_ENDPOINT`, `GENERA_AZURE_TEST_CONNECTION_STRING`,
`GENERA_GCS_TEST_ENDPOINT`, `GENERA_DROPBOX_TEST_TOKEN`.

## Releasing

Versioned with [Changesets](docs/releasing.md): `corepack pnpm changeset` to record a
change, `changeset version` to bump + write changelogs, and `changeset publish` to
release. See **[docs/releasing.md](docs/releasing.md)**.

## License

MIT