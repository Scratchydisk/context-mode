// OpenCode 2 resolves a *local* plugin directory by looking for an `index` or `server` entry inside
// it — `Host.resolve` in packages/plugin/src/host.ts calls `Bun.resolveSync(<dir>/index, <dir>)` and
// `<dir>/server`, and never consults this package's `main` or `exports`. A directory spec without one
// of those entries is dropped in silence (packages/core/src/config/plugin/source.ts: `if
// (!entrypoints.server) return []`).
//
// This file is that entry. It lets `plugins: ["/path/to/context-mode"]` in opencode.json load this
// build directly, instead of OpenCode resolving the bare name "context-mode" on npm — which is
// upstream's published package, whose default export has no `setup` and therefore fails to load
// ("Plugin must export a default definition with an id and an effect or setup function").
export { default } from "./build/adapters/opencode/plugin.js";
