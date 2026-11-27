# Claude

Claude Code integration plugin for Agent of Empires

An [Agent of Empires](https://github.com/agent-of-empires/agent-of-empires)
plugin. It declares a runtime worker that speaks JSON-RPC 2.0 over
newline-delimited JSON on stdio. The worker is a no-op for now: it answers every
request with `-32601`.

## Install into Agent of Empires

```bash
# from a local checkout
aoe plugin install ./claude

# or from GitHub once published
aoe plugin install gh:your-org/claude
```

The host runs the manifest's `[[runtime.build]]` steps at install time and then
launches the plugin-relative worker entrypoint under `.aoe-build/`. Manage the
plugin from the TUI, the web dashboard, or `aoe plugin {enable,disable,update}`.

## Layout

```
aoe-plugin.toml        the manifest (runtime worker)
package.json           build + dev tooling (tsc, eslint, vitest)
tsconfig.json
src/
  index.ts             the JSON-RPC worker loop
  rpc.ts               response builders
scripts/
  write-aoe-wrapper.mjs generates the plugin-relative launcher
test/                  worker-contract and framing tests
test/e2e/              install smoke against the pinned aoe release (npm run test:e2e)
tests/aoe-pin.toml     the single core pin (version + rev)
tests/parity/          parity case list
tests/manifest/        Rust crate that validates the manifest against a pinned core release
```

## Develop

```bash
npm ci          # install deps
npm run lint    # eslint
npm run build   # compile TypeScript to .aoe-build/dist/
npm test        # vitest
```

Validate the manifest against the pinned core release:

```bash
cargo test --locked --manifest-path tests/manifest/Cargo.toml
```

Run the parity checks (manifest crate, then an install smoke against the pinned
core release):

```bash
npm run test:parity
```

The smoke downloads the release tarball into a private temporary directory and
compares it against the `.sha256` file published on the same release URL. That
detects a corrupt download but not a replaced asset. Pinning a sha256 per asset
is deferred.

The core pin lives in `tests/aoe-pin.toml` (`version` and `rev`). To bump it:

1. Set `version` and `rev` in `tests/aoe-pin.toml`.
2. Set the same `rev` in `tests/manifest/Cargo.toml`; the crate test fails if the two differ.
3. Refresh the lockfile: `cargo update -p aoe-plugin-api --manifest-path tests/manifest/Cargo.toml`.
4. Run `npm run test:parity`.

Case list: `tests/parity/cases.toml`.

The worker build output goes to `.aoe-build/` only.

See the [plugin authoring guide](https://agent-of-empires.com/docs/development/writing-plugins/)
and the [plugin API reference](https://agent-of-empires.com/docs/api/plugin-api/).

## Release

release-please opens a `chore(release): X.Y.Z` PR on every push to `main`;
merging it tags and publishes a release with a source archive and its `sha256`.
See [RELEASING.md](RELEASING.md).

## License

MIT
