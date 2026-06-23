# @rocketbean/genera-gdrive

> Google Drive driver for Genera.

A storage driver for **[Genera](https://github.com/rocketbean/genera)** — one API
for every cloud storage provider. Drive it through the same `put / get / list /
delete / exists` contract as every other Genera driver.

## Install

```bash
npm install @rocketbean/genera @rocketbean/genera-gdrive @googleapis/drive
# auth helper (if not already present):
npm install google-auth-library
```

`@googleapis/drive` is a peer dependency.

## Quick start

```ts
import { createStorage } from "@rocketbean/genera";
import { GoogleDriveDriver } from "@rocketbean/genera-gdrive";
import { OAuth2Client } from "google-auth-library";

// clientId + clientSecret from your Google Cloud OAuth 2.0 client.
const auth = new OAuth2Client({
  clientId: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
});

// A refresh token obtained once via the consent flow (access_type=offline,
// scope https://www.googleapis.com/auth/drive). The library refreshes access
// tokens from it automatically.
auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });

const storage = createStorage(new GoogleDriveDriver({ auth }));

await storage.put("docs/readme.txt", "hello");
const bytes = await storage.get("docs/readme.txt"); // Uint8Array
for await (const entry of storage.list("docs")) console.log(entry.path);
await storage.delete("docs/readme.txt");
```

## At a glance

|                       |                                                          |
| --------------------- | -------------------------------------------------------- |
| **Runtime**           | Node only                                                |
| **Addressing**        | id-native — paths are resolved to file ids and cached    |
| **Capabilities**      | Copy, Move, Stat, CreateDirectory, DeleteDirectory, Stream |
| **Native** (`.native`)| `drive_v3.Drive`                                         |

Drive permits same-name siblings in a folder; the `onAmbiguous` policy controls
how that's handled. Streamed uploads pipe straight to the SDK's resumable upload.
Native Google Docs/Sheets must be fetched with the driver's `export(path, mimeType)`
method rather than `get()`.

## Configuration

| Option         | Type                                | Notes                                                       |
| -------------- | ----------------------------------- | ----------------------------------------------------------- |
| `auth`         | `RefreshableAuth`                   | A googleapis auth client (e.g. `OAuth2Client`).             |
| `credentials`  | `CredentialProvider<OAuthCredential>` | OAuth provider; its token is pushed onto `auth` per request. |
| `drive`        | `drive_v3.Drive`                    | Escape hatch / test seam — a fully-configured Drive client. |
| `driveId`      | `string`                            | Shared (Team) drive id — adds the all-drives params.        |
| `rootFolderId` | `string`                            | Scope every path under this folder instead of `"root"`.     |
| `onAmbiguous`  | `"first" \| "error"`                | Same-name-sibling policy. Default `"first"`.                |

> Full docs — every option, the complete capability matrix, auth, and the
> isomorphism rules — live in the
> [Genera README](https://github.com/rocketbean/genera#readme) and
> [`docs/capability-matrix.md`](https://github.com/rocketbean/genera/blob/main/docs/capability-matrix.md).

## License

MIT © rocketbean
