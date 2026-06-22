# Genera

**One API for every cloud storage provider.** A driver-based, provider-agnostic,
isomorphic (browser + Node) storage layer for TypeScript. Write your code once
against a small portable contract; swap S3 for GCS, Dropbox, Google Drive, or your
own driver by changing configuration — not code.

```ts
import { createStorage } from "@rocketbean/genera";
import { S3Driver } from "@rocketbean/genera-s3";
import { staticCredentials } from "@rocketbean/genera";

const storage = createStorage(
  new S3Driver({
    bucket: "my-bucket",
    region: "us-east-1",
    credentials: staticCredentials({ accessKeyId, secretAccessKey }),
  }),
);

await storage.put("users/42/avatar.png", bytes, { contentType: "image/png" });
const data = await storage.get("users/42/avatar.png");
for await (const entry of storage.list("users/42")) console.log(entry.path);
```

Point the same code at a different provider by swapping the driver:

```ts
import { GcsDriver } from "@rocketbean/genera-gcs";
const storage = createStorage(new GcsDriver({ bucket: "my-bucket", projectId }));
// put/get/list/delete/exists are identical.
```

## Why

- **Portable core** — five operations (`put`/`get`/`list`/`delete`/`exists`) that
  behave identically across providers, verified by a shared **conformance kit**.
- **Capabilities, not assumptions** — richer operations (`copy`, `move`, `stat`,
  `getSignedUrl`, directories, streaming) are advertised per driver and gated; an
  unsupported call throws a typed `OperationNotSupportedError`.
- **Escape hatch** — drop to the raw SDK any time via `disk.as(S3Driver).native`.
- **Isomorphic** — web-standard primitives only in the core; the conformance kit
  passes in both Node and a real browser.
- **Batteries** — OAuth2 + PKCE auth layer, retry/backoff + rate-limit handling,
  observability hooks, AES-256-GCM encryption-at-rest wrapper, and a
  cross-provider `transfer` utility.

## Packages

| Package | What |
|---|---|
| `@rocketbean/genera` | Core contract, Memory + FS drivers, conformance kit, OAuth, retry/events, wrappers |
| `@rocketbean/genera-s3` | AWS S3 + R2 / Spaces / B2 / Wasabi / MinIO / IDrive e2 |
| `@rocketbean/genera-gcs` | Google Cloud Storage (Node) |
| `@rocketbean/genera-azure` | Azure Blob Storage |
| `@rocketbean/genera-dropbox` | Dropbox |
| `@rocketbean/genera-onedrive` | OneDrive (Microsoft Graph) |
| `@rocketbean/genera-gdrive` | Google Drive (Node) |
| `@rocketbean/genera-box` | Box (Node) |

See the **[capability matrix](docs/capability-matrix.md)** for what each supports,
and **[authoring a driver](docs/authoring-a-driver.md)** to add your own.

## Development

A pnpm monorepo. `corepack pnpm install`, then:

```bash
corepack pnpm -r build       # build every package
corepack pnpm -r test        # node test suites (driver conformance is env-gated)
corepack pnpm lint           # ESLint (enforces no Node built-ins in the core)
docker compose up -d         # MinIO / Azurite / fake-gcs-server emulators
corepack pnpm --filter @rocketbean/genera test:browser   # in-browser conformance
```

Driver conformance against emulators/live runs via env vars (e.g.
`GENERA_S3_TEST_ENDPOINT`); see each driver's test file.

## License

MIT
