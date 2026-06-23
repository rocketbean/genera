# @rocketbean/genera-azure

> Azure Blob Storage driver for Genera.

A storage driver for **[Genera](https://github.com/rocketbean/genera)** — one API
for every cloud storage provider. Drive it through the same `put / get / list /
delete / exists` contract as every other Genera driver.

## Install

```bash
npm install @rocketbean/genera @rocketbean/genera-azure @azure/storage-blob
```

`@azure/storage-blob` is a peer dependency.

## Quick start

```ts
import { createStorage } from "@rocketbean/genera";
import { AzureBlobDriver } from "@rocketbean/genera-azure";

const storage = createStorage(
  new AzureBlobDriver({
    container: "my-container",
    connectionString: process.env.AZURE_STORAGE_CONNECTION_STRING!,
  }),
);

await storage.put("docs/readme.txt", "hello");
const bytes = await storage.get("docs/readme.txt"); // Uint8Array
for await (const entry of storage.list("docs")) console.log(entry.path);
await storage.delete("docs/readme.txt");
```

## At a glance

|                       |                                         |
| --------------------- | --------------------------------------- |
| **Runtime**           | Node + browser                          |
| **Addressing**        | key-native (path = blob name)           |
| **Capabilities**      | SignedUrl (SAS), Stream, Copy, Move, Stat |
| **Native** (`.native`)| `BlobServiceClient`                     |

> **Browser:** construct from a scoped, short-lived `sasUrl`. Never ship the
> account key or a connection string to the client.

## Configuration

| Option             | Type                | Notes                                                          |
| ------------------ | ------------------- | -------------------------------------------------------------- |
| `container`        | `string` **(required)** | The blob container every operation targets.                |
| `connectionString` | `string`            | Simplest path for shared-key auth + Azurite (Node).            |
| `account`          | `string`            | Account name — pair with `accountKey` (Node).                  |
| `accountKey`       | `string`            | Shared account key (Node only — never ship to the browser).    |
| `sasUrl`           | `string`            | Full service SAS URL — the browser-safe path.                  |
| `serviceClient`    | `BlobServiceClient` | Escape hatch — bring your own configured client.               |

> Full docs — every option, the complete capability matrix, auth, and the
> isomorphism rules — live in the
> [Genera README](https://github.com/rocketbean/genera#readme) and
> [`docs/capability-matrix.md`](https://github.com/rocketbean/genera/blob/main/docs/capability-matrix.md).

## License

MIT © rocketbean
