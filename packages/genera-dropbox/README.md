# @rocketbean/genera-dropbox

> Dropbox driver for Genera.

A storage driver for **[Genera](https://github.com/rocketbean/genera)** — one API
for every cloud storage provider. Drive it through the same `put / get / list /
delete / exists` contract as every other Genera driver.

## Install

```bash
npm install @rocketbean/genera @rocketbean/genera-dropbox dropbox
```

`dropbox` is a peer dependency. Node 18+ ships a native `fetch`; on older
runtimes pass a `fetch` implementation to the SDK client.

## Quick start

```ts
import { createStorage } from "@rocketbean/genera";
import { DropboxDriver } from "@rocketbean/genera-dropbox";

const storage = createStorage(
  new DropboxDriver({ accessToken: process.env.DROPBOX_TOKEN! }),
);

await storage.put("docs/readme.txt", "hello");
const bytes = await storage.get("docs/readme.txt"); // Uint8Array
for await (const entry of storage.list("docs")) console.log(entry.path);
await storage.delete("docs/readme.txt");
```

For production, pass an OAuth `credentials` provider instead of a static
`accessToken` — it refreshes transparently per request (see the
[OAuth/PKCE notes](https://github.com/rocketbean/genera#authentication) in the
main README).

## At a glance

|                       |                                                                  |
| --------------------- | ---------------------------------------------------------------- |
| **Runtime**           | Node + browser                                                   |
| **Addressing**        | path-native                                                      |
| **Capabilities**      | SignedUrl (shared link), Stream, Copy, Move, Stat, CreateDirectory, DeleteDirectory |
| **Native** (`.native`)| `Dropbox`                                                        |

Large or streamed uploads (`ReadableStream`, or buffers ≥ 150 MB) automatically
use Dropbox upload sessions; tune the chunk size with `chunkSize`.

## Configuration

| Option        | Type                                | Notes                                                       |
| ------------- | ----------------------------------- | ----------------------------------------------------------- |
| `credentials` | `CredentialProvider<OAuthCredential>` | OAuth provider yielding a fresh access token per request. |
| `accessToken` | `string`                            | A static access token — simplest, but it expires.          |
| `client`      | `Dropbox`                           | Escape hatch / test seam — bring your own configured client. |
| `chunkSize`   | `number`                            | Bytes per upload-session chunk. Default 8 MiB.              |

> Full docs — every option, the complete capability matrix, auth, and the
> isomorphism rules — live in the
> [Genera README](https://github.com/rocketbean/genera#readme) and
> [`docs/capability-matrix.md`](https://github.com/rocketbean/genera/blob/main/docs/capability-matrix.md).

## License

MIT © rocketbean
