# pi-image-tools (vendored)

Source copied from [MasuRii/pi-image-tools](https://github.com/MasuRii/pi-image-tools).

- Upstream tag: `v1.4.0`
- Upstream commit: `b8977bbb4f416fd63db7c7c602db6dfe7b17f62c`

This fork pins the copy instead of installing the npm package, so upgrades are
manual. To upgrade, re-copy `src/` from the new tag and re-apply the fork-local
edits below.

## Fork-local edits

1. `@earendil-works/pi-coding-agent` imports point at the fork's own
   `src/index.ts` (relative), so the bundle reuses the host module instead of
   pulling a second copy of the package.
2. Constructor parameter properties were expanded to explicit fields
   (`erasableSyntaxOnly` is on in this repo).
3. Registered in `packages/coding-agent/src/extensions/index.ts` as a built-in
   extension. Loaded by every build, including `pie`.

`@mariozechner/clipboard` stays an optional runtime dependency, reached through
`createRequire`; the macOS/Windows command providers work without it.
