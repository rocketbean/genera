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
corepack pnpm changeset version   # applies bumps, writes CHANGELOGs, consumes .changeset/*
# review & commit the version bumps, then:
corepack pnpm release             # = pnpm -r build && changeset publish
```

`changeset publish` publishes every package whose version isn't yet on npm.

## Publishing prerequisites (gated on credentials)

- An **npm automation token** with publish rights to the `@rocketbean` scope,
  exposed as `NPM_TOKEN` (CI) or via `npm login` locally.
- Scoped packages publish publicly via `publishConfig.access: "public"` (already set)
  and `.changeset/config.json` `access: "public"`.
- In CI, prefer **npm provenance** (`npm publish --provenance` with OIDC), and run
  the publish from the changesets release action on `main`.

> The actual `npm publish` is the only step that can't run without registry
> credentials — everything up to it (versioning, changelogs, build, `npm pack`
> dry-runs) works locally.

## Sanity checks before publishing

```bash
corepack pnpm changeset status              # what will bump
corepack pnpm -r build && corepack pnpm -r test
corepack pnpm --filter @rocketbean/genera-s3 exec npm pack --dry-run   # files that ship
```
