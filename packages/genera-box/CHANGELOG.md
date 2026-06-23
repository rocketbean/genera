# @rocketbean/genera-box

## 1.1.0

### Minor Changes

- Tier 2 large-file / streamed uploads via provider chunked-upload sessions.

  - **Core**: `chunkBytes(data, size)` helper — slices buffers and incrementally
    re-chunks `ReadableStream`s without buffering the whole payload.
  - **Dropbox**: upload sessions (start → append → finish) for `ReadableStream`
    inputs and buffers ≥ 150 MB; true streaming.
  - **OneDrive**: `createUploadSession` + ranged chunk PUTs for streams and buffers
    ≥ 4 MB.
  - **Google Drive**: `ReadableStream` inputs pipe straight to the SDK's resumable
    upload (no full buffering).
  - **Box**: chunked upload sessions (per-part + whole-file SHA-1) for streams and
    large buffers.

  Each driver gains a `chunkSize` option. Backward compatible — small buffered
  uploads keep the single-shot path.

## 1.0.0

### Major Changes

- Genera v1.0 — one API for every cloud storage provider.

  - **Core**: the portable `StorageDriver`/`BaseDriver` contract, capability gating,
    error taxonomy, canonical path engine, `MemoryDriver` + `FsDriver`, and the
    published conformance kit (`@rocketbean/genera/conformance`).
  - **Tier 1 (object storage)**: `@rocketbean/genera-s3` (AWS S3 + Cloudflare R2,
    DigitalOcean Spaces, Backblaze B2, Wasabi, MinIO, IDrive e2), `-gcs`, `-azure`.
  - **Tier 2 (consumer drives)**: `-dropbox` and `-onedrive` (path-native), `-gdrive`
    and `-box` (id-native, via the cached `PathResolver`).
  - **Auth**: OAuth2 + PKCE layer — `OAuthCredentialProvider` (refresh, expiry skew,
    single-flight, revocation), decoupled `OAuthFlow`, pluggable `TokenStore`.
  - **Hardening**: retry/backoff with rate-limit handling, observability hooks,
    AES-256-GCM `EncryptionDriver` (encryption-at-rest), and a cross-provider
    `transfer` migration utility.

### Patch Changes

- Updated dependencies
  - @rocketbean/genera@1.0.0
