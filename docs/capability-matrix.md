# Capability matrix

Every driver implements the five portable operations — `put`, `get`, `list`,
`delete`, `exists` — plus the escape hatches (`native`, `resolveNativeId`). The
table below shows the **optional, capability-gated** operations each driver
advertises, the runtimes it supports, and how it addresses objects.

Calling a capability a driver doesn't advertise throws `OperationNotSupportedError`
— check `disk.capabilities.has(Capability.X)` (or just call and handle the error).

| Driver | Package | Runtime | Addressing | SignedUrl | Stream | Copy | Move | Stat | CreateDir | DeleteDir |
|---|---|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| Memory | `@rocketbean/genera` | node + browser | key | – | – | ✅ | ✅ | ✅ | – | – |
| Filesystem | `@rocketbean/genera/node` | node | key | – | – | ✅ | ✅ | ✅ | ✅ | ✅ |
| S3 family¹ | `@rocketbean/genera-s3` | node + browser | key | ✅ | ✅ | ✅ | ✅ | ✅ | – | – |
| Google Cloud Storage | `@rocketbean/genera-gcs` | node | key | ✅ | – | ✅ | ✅ | ✅ | – | – |
| Azure Blob | `@rocketbean/genera-azure` | node + browser | key | ✅ | – | ✅ | ✅ | ✅ | – | – |
| Dropbox | `@rocketbean/genera-dropbox` | node + browser | path | ✅² | – | ✅ | ✅ | ✅ | ✅ | ✅ |
| OneDrive | `@rocketbean/genera-onedrive` | node + browser | path | ✅² | – | ✅ | ✅ | ✅ | ✅ | ✅ |
| Google Drive | `@rocketbean/genera-gdrive` | node | id | – | – | ✅ | ✅ | ✅ | ✅ | ✅ |
| Box | `@rocketbean/genera-box` | node | id | – | – | ✅ | ✅ | ✅ | ✅ | ✅ |

¹ One driver covers AWS S3, Cloudflare R2, DigitalOcean Spaces, Backblaze B2,
Wasabi, MinIO, and IDrive e2 via `endpoint`/`region`/`forcePathStyle`.

² Dropbox/OneDrive "signed URLs" are **sharing links**, not time-limited presigned
URLs — `expiresIn` is ignored. Documented per-driver.

## Wrapper drivers

`EncryptionDriver` wraps any driver and adds AES-256-GCM encryption-at-rest. It
delegates `Copy`/`Move`/`CreateDir`/`DeleteDir` to the inner driver but **drops**
`Stat`/`SignedUrl`/`Stream` (ciphertext size and bytes differ from plaintext).

## Notes

- **Stream**: only S3 currently advertises true multipart/streaming upload. Other
  drivers buffer; per-provider streaming is incremental.
- **Copy/Move** on Azure, OneDrive, Google Drive, and Box are currently
  download+re-upload (portable); server-side copy is an optimization.
- **resolveNativeId** returns the provider-native identifier: the object key
  (S3/GCS/Azure/Memory/FS), the path (Dropbox/OneDrive), or the file id (Drive/Box).
