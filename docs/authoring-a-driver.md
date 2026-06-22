# Authoring a driver

A Genera driver maps the portable `StorageDriver` contract onto one provider. If
it passes the conformance kit, it's a drop-in for every other driver. This guide
takes you from the template to a certified driver.

## 1. Start from the template

Copy `packages/genera-driver-template` to `packages/genera-<provider>` and rename
it. Then:

- Declare the provider SDK as a **`peerDependency`** (+ `peerDependenciesMeta.optional`
  if you want it opt-in) and a `devDependency`. This keeps the core dependency-light.
- Add `@rocketbean/genera` as a `peerDependency` (`workspace:^`) and a `devDependency`.
- Point `tsup`'s `external` at the SDK so it isn't bundled.

## 2. Implement the contract

Extend `BaseDriver<TNative>` (it gives you root-scoping via `resolve`/`unresolve`):

```ts
export class MyDriver extends BaseDriver<MyClient> {
  readonly capabilities = new Set([Capability.Copy, Capability.Stat /* … */]);
  readonly environments = new Set<Environment>(["node", "browser"]);

  get native(): MyClient { return this.client; }

  async put(path, data, opts) { /* toBytes(data) → SDK upload */ }
  async get(path) { /* SDK download → Uint8Array */ }
  async *list(prefix, opts) { /* page the SDK; yield StorageEntry, hide cursors */ }
  async delete(path) { /* idempotent: missing path is a no-op */ }
  async exists(path) { /* HEAD/metadata, false on not-found */ }
  async resolveNativeId(path) { /* the provider's native id for this path */ }
}
```

Rules that the conformance kit enforces:

- **Use `this.resolve(path)`** for every key, and `this.unresolve(key)` when
  returning paths — this applies the multi-tenant `root` prefix.
- **`delete` is idempotent** — swallow the provider's not-found error.
- **`get` on a missing object throws `NotFoundError`** (`code: "NOT_FOUND"`).
- **Map provider errors** to the Genera taxonomy: 404 → `NotFoundError`,
  403 → `PermissionError`, 401 → `AuthError`, 409 → `AlreadyExistsError`,
  429 → `RateLimitError`, 502/503/504 → `UnavailableError`. The last two let the
  built-in retry layer fire.
- **`list`** groups one level by default (synthesize `directory` entries from key
  prefixes) and returns every file under the prefix when `{ recursive: true }`.
- Use the web-standard `toBytes(data)` helper so `string | Uint8Array |
  ArrayBuffer | Blob | ReadableStream` inputs all work, in both runtimes.

Only implement the optional methods (`copy`/`move`/`stat`/`getSignedUrl`/
`createDirectory`/`deleteDirectory`) you advertise in `capabilities` — they must agree.

## 3. Addressing flavor

- **key-native** (S3, GCS, Azure): the resolved path *is* the object key.
- **path-native** (Dropbox, OneDrive): trivial translation (e.g. prepend `/`).
- **id-native** (Google Drive, Box): paths are opaque ids — use the core
  `PathResolver` (cached resolve-or-create, ambiguity policy) and return ids from
  `resolveNativeId`.

## 4. Auth

Take a `CredentialProvider` (e.g. the `OAuthCredentialProvider` from the auth
layer) and fetch a fresh credential per request — never manage refresh inline.

## 5. Certify it

Run the shared conformance kit against your driver. With no public emulator,
prove it offline against an injected fake client and gate a live run on env vars:

```ts
import { describeConformance } from "@rocketbean/genera/conformance";

describeConformance("MyProvider (fake)", () => new MyDriver({ client: fakeClient() }));

if (process.env.MYPROVIDER_TEST_TOKEN) {
  describeConformance("MyProvider (live)", () => new MyDriver({ /* live */ }));
}
```

Isomorphic drivers (`environments` includes `"browser"`) should also run the kit
in a browser (`*.browser.test.ts`, see the `vitest-browser` setup), authenticating
the browser-safe way — presigned URLs / SAS / user OAuth, never raw keys.

When it's green, add a changeset and publish (see the release docs).
