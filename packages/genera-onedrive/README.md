# @rocketbean/genera-onedrive

> OneDrive / Microsoft Graph driver for Genera.

A storage driver for **[Genera](https://github.com/rocketbean/genera)** — one API
for every cloud storage provider. Drive it through the same `put / get / list /
delete / exists` contract as every other Genera driver.

## Install

```bash
npm install @rocketbean/genera @rocketbean/genera-onedrive \
  @microsoft/microsoft-graph-client @microsoft/microsoft-graph-types
```

The Graph packages are peer dependencies. For auth, add `@azure/msal-node`
(Node) or `@azure/msal-browser` (browser).

## Quick start

```ts
import { createStorage } from "@rocketbean/genera";
import { OneDriveDriver } from "@rocketbean/genera-onedrive";

const storage = createStorage(
  new OneDriveDriver({ accessToken: process.env.MS_GRAPH_TOKEN! }),
);

await storage.put("docs/readme.txt", "hello");
const bytes = await storage.get("docs/readme.txt"); // Uint8Array
for await (const entry of storage.list("docs")) console.log(entry.path);
await storage.delete("docs/readme.txt");
```

For production, pass an OAuth `credentials` provider instead of a static
`accessToken` — it is bridged into the Graph auth provider and refreshes
transparently (see the
[OAuth/PKCE notes](https://github.com/rocketbean/genera#authentication) in the
main README).

## At a glance

|                       |                                                                  |
| --------------------- | ---------------------------------------------------------------- |
| **Runtime**           | Node + browser                                                   |
| **Addressing**        | path-native (Graph `:/path:` syntax)                             |
| **Capabilities**      | SignedUrl (sharing link), Stream, Copy, Move, Stat, CreateDirectory, DeleteDirectory |
| **Native** (`.native`)| Graph `Client`                                                   |

Files over 4 MB (and streamed uploads) automatically use a Graph upload session
with ranged chunk PUTs; tune the chunk size with `chunkSize` (a multiple of 320 KiB).

## Configuration

| Option        | Type                                | Notes                                                        |
| ------------- | ----------------------------------- | ------------------------------------------------------------ |
| `credentials` | `CredentialProvider<OAuthCredential>` | OAuth provider — bridged into the Graph auth provider.     |
| `accessToken` | `string`                            | A static access token (alternative to `credentials`).        |
| `client`      | Graph `Client`                      | Escape hatch / test seam — bring your own configured client. |
| `chunkSize`   | `number`                            | Bytes per upload-session chunk. Default 1.6 MiB.             |

> Full docs — every option, the complete capability matrix, auth, and the
> isomorphism rules — live in the
> [Genera README](https://github.com/rocketbean/genera#readme) and
> [`docs/capability-matrix.md`](https://github.com/rocketbean/genera/blob/main/docs/capability-matrix.md).

## License

MIT © rocketbean
