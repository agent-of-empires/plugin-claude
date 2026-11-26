# Releasing

Releases use release-please. No PAT and no secret: `GITHUB_TOKEN` does everything.

## One-time prerequisite

Repo owner: Settings, Actions, General, Workflow permissions. Select
"Read and write permissions" and tick "Allow GitHub Actions to create and approve
pull requests". Without both, release-please cannot open its release PR.

## Flow

1. Every push to `main` refreshes one `chore(release): X.Y.Z` PR. It bumps
   `package.json` and `aoe-plugin.toml` and writes `CHANGELOG.md`.
2. GitHub does not start `pull_request` workflows for a PR opened with
   `GITHUB_TOKEN`, so the release PR has no check runs. The `main` rules require
   `Lint, type-check, test` and `Validate manifest`: **close and reopen the
   release PR** to run them, then get code-owner review and merge.
3. Merging creates the `vX.Y.Z` tag and the GitHub Release.
   `release-please.yml` then calls `release.yml` in the same run. It re-runs the
   checks, refuses a tag that disagrees with `package.json` or `aoe-plugin.toml`,
   and attaches `claude-vX.Y.Z.tar.gz` (`git archive`) and its `.sha256`.

## Bootstrap

The manifest `.release-please-manifest.json` names `0.1.0`, but no `v0.1.0` tag
exists yet. Create it once, before the first release PR is merged:

```bash
gh workflow run release.yml -f tag=v0.1.0
```

## Publishing to the featured index

Not automated. Open a hand-written PR against core `plugins/featured.toml` with
the tree hash of the release (`aoe plugin hash`).

## Bumping the host pin

`tests/manifest/Cargo.toml` pins `aoe-plugin-api` by `rev` to a core release
commit. Move the `rev`, run
`cargo test --manifest-path tests/manifest/Cargo.toml`, and commit the updated
`Cargo.lock`.
