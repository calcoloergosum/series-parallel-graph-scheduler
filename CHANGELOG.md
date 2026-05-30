# Changelog

All user-visible CLI, graph, renderer, visualizer, worker, package, and
operator documentation changes must be recorded here before a release is tagged.

## Unreleased

### Added

- Added GUI operator-console parity through the local visualizer: read-only
  endpoints now mirror `summary`, `ready`, `diagnostics`, `events`, and
  `prompt`; protected write endpoints expose node mutations, graph recovery,
  lease release, and Worker Manager start/stop controls.
- Added visualizer payload metadata for operator actions, including per-node
  `actions`, `actionPolicy`, confirmation hints for destructive actions, and
  disabled reasons when a worker-style action needs matching lease credentials.

### Compatibility And Migration Notes

- Existing CLI commands, flags, graph mutation semantics, and successful JSON
  stdout shapes are unchanged. The GUI additions call the same scheduler
  mutation handlers and preserve the graph file as the source of truth.
- The new visualizer routes and payload fields are additive. Existing clients
  that only consume `/api/graph`, `/api/workers`, or `/events` can ignore the
  new action metadata.
- When `serve` is started with `--visualizer-write-token`, every visualizer
  `POST` route returns HTTP 403 unless the request includes
  `X-SPG-Visualizer-Token: TOKEN` or `Authorization: Bearer TOKEN`. Read-only
  visualizer routes remain unauthenticated, including on non-loopback binds.
- No known breaking behavior is introduced by the GUI operator-console parity
  work.

## 0.1.0 - 2026-05-27

### Added

- Documented the public compatibility contract for scheduler commands, flags,
  JSON output, graph semantics, worker prompt variables, visualizer routes,
  reports, renderer behavior, package binaries, and npm scripts.
- Added release-gate evidence for package dry runs, built binary smoke checks,
  graph schema generation, migration smoke checks, coverage thresholds,
  deterministic stress checks, and browser visualizer verification.
- Added operator documentation for graph authoring, testing, security,
  architecture, runbooks, operational events, output safety, lock strategy,
  worker isolation, mutation ownership, technical debt, and release checklists.

### Changed

- The release process now requires a versioned changelog entry before
  `npm run release:check` can pass.
- The package dry-run evidence reports the changelog entry used for the package
  version and includes the changelog in packaged runtime documentation.

### Compatibility And Migration Notes

- Compatibility version `0.1` follows `package.json` until a separate graph
  schema version is introduced.
- Breaking compatibility changes require operator approval, a compatibility
  version update, a migration note in `docs/compatibility-boundaries.md`, tests
  in the same change set, and a changelog entry under this section.
- Warning-only graph validation changes must be named here and linked to the
  compatibility docs so operators can find non-fatal graph behavior changes
  before release.
- No known breaking changes are introduced in `0.1.0`.
