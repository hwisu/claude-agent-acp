# Repository Instructions

## Version Updates

- Do not upgrade dependencies, SDKs, package-manager metadata, or tool versions to a release that is less than 14 full days old.
- Before changing any version, verify the candidate release date from an authoritative source such as the package registry or upstream release page.
- Prefer pinned versions over `latest` tags or broad semver ranges when updating versions.
- Record the checked release date and source in the change summary whenever a version is bumped.
- This waiting period is required to reduce supply-chain and network-attack exposure from newly published packages.

## Agent guide

An ACP-compatible coding agent powered by the Claude Agent SDK. Source in `src/`,
TypeScript, ESM, Node >= 22.

## Commands

```sh
aube run build         # tsc
aube run test:run      # vitest, single pass
aube run check         # eslint + prettier --check
aube run lint:fix      # eslint --fix
aube run format        # prettier --write
```

CI runs `format:check`, `lint`, `build` and `test:run`. Run `aube run check` before
opening a PR.

## Pull requests

Squash merges use the PR title as the commit subject. Titles should use one of:
`feat`, `fix`, `perf`, `revert`, `docs`, `style`, `chore`, `refactor`, `test`,
`build`, `ci`.

## Releasing

This fork mirrors the pinned Claude Agent SDK version and publishes from an
explicit `v<SDK-version>[-N]` tag or manual workflow. Verify the SDK/package
version with `aube run sync-sdk-version -- --check` before release.
