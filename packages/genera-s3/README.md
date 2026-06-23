# @rocketbean/genera-s3

> One driver for **AWS S3, Cloudflare R2, DigitalOcean Spaces, Backblaze B2, Wasabi, MinIO, and IDrive e2** — they differ only in client config.

A storage driver for **[Genera](https://github.com/rocketbean/genera)** — one API
for every cloud storage provider. Drive it through the same `put / get / list /
delete / exists` contract as every other Genera driver.

## Install

```bash
npm install @rocketbean/genera @rocketbean/genera-s3 \
  @aws-sdk/client-s3 @aws-sdk/lib-storage @aws-sdk/s3-request-presigner
```

The `@aws-sdk/*` packages are peer dependencies, so the core stays light and you
control the SDK version.

## Quick start

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

await storage.put("docs/readme.txt", "hello");
const bytes = await storage.get("docs/readme.txt"); // Uint8Array
for await (const entry of storage.list("docs")) console.log(entry.path);
await storage.delete("docs/readme.txt");
```

## At a glance

|                       |                                              |
| --------------------- | -------------------------------------------- |
| **Runtime**           | Node + browser                               |
| **Addressing**        | key-native (path = object key)               |
| **Capabilities**      | SignedUrl, Stream, Copy, Move, Stat          |
| **Native** (`.native`)| `S3Client`                                   |

> **Browser:** never embed long-lived access keys. Use presigned URLs (generated
> server-side) or short-lived STS credentials.

## Configuration

| Option           | Type                              | Notes                                                             |
| ---------------- | --------------------------------- | ----------------------------------------------------------------- |
| `bucket`         | `string` **(required)**           | The bucket every operation targets.                               |
| `region`         | `string`                          | AWS: the real region. R2: `"auto"`. Others: any value the endpoint accepts. |
| `endpoint`       | `string`                          | Omit for AWS; set for every S3-compatible provider.               |
| `forcePathStyle` | `boolean`                         | Required by MinIO/R2/B2/Wasabi/IDrive; optional for AWS/Spaces.    |
| `credentials`    | `CredentialProvider<S3Credentials>` | Wrap static keys with `staticCredentials({...})`.               |
| `client`         | `S3Client`                        | Escape hatch — bring your own configured client (ignores the above). |

### Provider matrix

| Provider      | `endpoint`                                  | `region` | `forcePathStyle` |
| ------------- | ------------------------------------------- | -------- | ---------------- |
| AWS S3        | _(default)_                                 | region   | `false`          |
| Cloudflare R2 | `https://<acct>.r2.cloudflarestorage.com`   | `auto`   | `true`           |
| DO Spaces     | `https://<region>.digitaloceanspaces.com`   | region   | either           |
| Backblaze B2  | `https://s3.<region>.backblazeb2.com`       | region   | `true`           |
| Wasabi        | `https://s3.<region>.wasabisys.com`         | region   | `true`           |
| MinIO         | `http://localhost:9000`                     | any      | `true`           |
| IDrive e2     | `https://<region>.idrivee2-XX.com`          | region   | `true`           |

> Full docs — every option, the complete capability matrix, auth, and the
> isomorphism rules — live in the
> [Genera README](https://github.com/rocketbean/genera#readme) and
> [`docs/capability-matrix.md`](https://github.com/rocketbean/genera/blob/main/docs/capability-matrix.md).

## License

MIT © rocketbean
