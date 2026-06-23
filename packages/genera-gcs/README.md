# @rocketbean/genera-gcs

> Google Cloud Storage driver for Genera.

A storage driver for **[Genera](https://github.com/rocketbean/genera)** — one API
for every cloud storage provider. Drive it through the same `put / get / list /
delete / exists` contract as every other Genera driver.

## Install

```bash
npm install @rocketbean/genera @rocketbean/genera-gcs @google-cloud/storage
```

`@google-cloud/storage` is a peer dependency.

## Quick start

```ts
import { createStorage } from "@rocketbean/genera";
import { GcsDriver } from "@rocketbean/genera-gcs";

// Uses Application Default Credentials (GOOGLE_APPLICATION_CREDENTIALS / metadata server).
const storage = createStorage(
  new GcsDriver({ bucket: "my-bucket", projectId: "my-project" }),
);

await storage.put("docs/readme.txt", "hello");
const bytes = await storage.get("docs/readme.txt"); // Uint8Array
for await (const entry of storage.list("docs")) console.log(entry.path);
await storage.delete("docs/readme.txt");
```

## At a glance

|                       |                                          |
| --------------------- | ---------------------------------------- |
| **Runtime**           | Node only (the SDK uses Node built-ins)  |
| **Addressing**        | key-native (path = object name)          |
| **Capabilities**      | SignedUrl, Stream, Copy, Move, Stat      |
| **Native** (`.native`)| `Storage`                                |

> For browser access to GCS, use a server-generated signed URL, or reach GCS
> through the S3-compatible XML API via `@rocketbean/genera-s3`.

## Configuration

| Option        | Type                | Notes                                                                |
| ------------- | ------------------- | -------------------------------------------------------------------- |
| `bucket`      | `string` **(required)** | The bucket every operation targets.                              |
| `projectId`   | `string`            | GCP project id. Optional when ADC provides it.                       |
| `apiEndpoint` | `string`            | Custom endpoint — set to the fake-gcs-server URL for emulator tests. |
| `credentials` | `GcsServiceAccount` | Explicit service account `{ client_email, private_key }`. Omit for ADC. |
| `keyFilename` | `string`            | Path to a service-account JSON key file (alternative to `credentials`). |
| `storage`     | `Storage`           | Escape hatch — bring your own configured client.                     |

> Full docs — every option, the complete capability matrix, auth, and the
> isomorphism rules — live in the
> [Genera README](https://github.com/rocketbean/genera#readme) and
> [`docs/capability-matrix.md`](https://github.com/rocketbean/genera/blob/main/docs/capability-matrix.md).

## License

MIT © rocketbean
