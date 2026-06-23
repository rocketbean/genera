# @rocketbean/genera-box

> Box driver for Genera.

A storage driver for **[Genera](https://github.com/rocketbean/genera)** — one API
for every cloud storage provider. Drive it through the same `put / get / list /
delete / exists` contract as every other Genera driver.

## Install

```bash
npm install @rocketbean/genera @rocketbean/genera-box box-node-sdk
```

`box-node-sdk` (v10+, the generated SDK) is a peer dependency.

## Quick start

```ts
import { createStorage } from "@rocketbean/genera";
import { BoxDriver } from "@rocketbean/genera-box";
import { BoxClient, BoxDeveloperTokenAuth } from "box-node-sdk";

const client = new BoxClient({
  auth: new BoxDeveloperTokenAuth({ token: process.env.BOX_TOKEN! }),
});

const storage = createStorage(new BoxDriver({ client }));

await storage.put("docs/readme.txt", "hello");
const bytes = await storage.get("docs/readme.txt"); // Uint8Array
for await (const entry of storage.list("docs")) console.log(entry.path);
await storage.delete("docs/readme.txt");
```

For production use OAuth 2.0, JWT, or CCG auth — build the `BoxClient` with your
chosen auth mode, ideally backed by Genera's
[OAuth credential seam](https://github.com/rocketbean/genera#authentication).

## At a glance

|                       |                                                          |
| --------------------- | -------------------------------------------------------- |
| **Runtime**           | Node only                                                |
| **Addressing**        | id-native — paths are resolved to item ids and cached (root folder `"0"`) |
| **Capabilities**      | Copy, Move, Stat, CreateDirectory, DeleteDirectory, Stream |
| **Native** (`.native`)| `BoxClient`                                              |

Large or streamed uploads automatically use Box chunked upload sessions
(per-part + whole-file SHA-1); tune the chunk size with `chunkSize`.

## Configuration

| Option         | Type                  | Notes                                                       |
| -------------- | --------------------- | ----------------------------------------------------------- |
| `client`       | `BoxClient` **(required)** | A configured Box client (built with your chosen auth mode). |
| `rootFolderId` | `string`              | Root folder id. Box's account root is `"0"` (the default).  |
| `onAmbiguous`  | `"first" \| "error"`  | Same-name-sibling policy. Default `"first"`.                |
| `chunkSize`    | `number`              | Bytes per chunked-upload part. Default 8 MiB.               |

> Full docs — every option, the complete capability matrix, auth, and the
> isomorphism rules — live in the
> [Genera README](https://github.com/rocketbean/genera#readme) and
> [`docs/capability-matrix.md`](https://github.com/rocketbean/genera/blob/main/docs/capability-matrix.md).

## License

MIT © rocketbean
