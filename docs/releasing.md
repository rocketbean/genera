# Releasing

Genera versions and publishes with [Changesets](https://github.com/changesets/changesets).
Packages are versioned **independently**; the private driver-template is ignored.

## Add a changeset (every PR that changes a published package)

```bash
corepack pnpm changeset
```

Pick the affected packages and bump level (patch/minor/major), and write a summary.
This drops a markdown file in `.changeset/`. Commit it with your PR.

## Cut a release

```bash
pnpm changeset version   # applies bumps, writes CHANGELOGs, consumes .changeset/*
# review & commit the version bumps, then:
pnpm release             # = pnpm -r build && pnpm -r publish
```

`pnpm -r publish` publishes every (non-private) package whose version isn't yet on
npm — it's idempotent, skipping already-published versions, and it rewrites the
`workspace:^` deps to real ranges. (Run `corepack pnpm …` if you haven't run
`corepack enable` to put `pnpm` on PATH.)

### Why `pnpm -r publish` instead of `changeset publish`

`changeset publish` probes the account endpoint `/-/npm/v1/user` to check OTP
requirements. **Granular access tokens can't read that endpoint → 403**, and npm
no longer offers classic "Automation" tokens (UI or `npm token create`). `pnpm -r
publish` only does the package-level `PUT`, which a granular token *can* do — so it
works where `changeset publish` fails. Trade-off: no automatic git tags / GitHub
releases (add a `git tag vX.Y.Z` yourself if you want one).

## Publishing prerequisites (gated on credentials)

- A **granular access token** with **Read and write** on the `@rocketbean` packages
  (the only token type npm still issues). For CI it bypasses 2FA; store it as the
  `NPM_TOKEN` repo secret. Locally, `npm config set //registry.npmjs.org/:_authToken
  <token>` (writes to `~/.npmrc`).
- Scoped packages publish publicly via `publishConfig.access: "public"` (already set).

> Everything up to the actual publish (versioning, changelogs, build, `npm pack`
> dry-runs, `@arethetypeswrong/cli`) works without credentials.

## CI (automated)

`.github/workflows/release.yml` runs the changesets action on pushes to `main`: it
opens a "Version Packages" PR when changesets are pending, and — once merged —
runs `pnpm release` to publish. It uses the `NPM_TOKEN` secret and sets
`NPM_CONFIG_PROVENANCE: true` (provenance needs a **public repo**).

### Token-less alternative: npm Trusted Publishing (OIDC)

The most durable CI setup avoids tokens entirely. On npmjs.com, for each package →
**Settings → Trusted Publishers**, add this GitHub repo + the `release.yml` workflow.
Then the workflow publishes via OIDC (no `NPM_TOKEN`), with provenance built in.
Requires npm CLI ≥ 11.5 in CI and a public repo.

## Sanity checks before publishing

```bash
corepack pnpm changeset status              # what will bump
corepack pnpm -r build && corepack pnpm -r test
corepack pnpm --filter @rocketbean/genera-s3 exec npm pack --dry-run   # files that ship
```
