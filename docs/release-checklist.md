# Release Checklist

Use this checklist before tagging or handing a package candidate to another
operator.

## Version And Changelog

- Confirm `package.json` has the intended semver version.
- Add or update the matching `CHANGELOG.md` version section before tagging.
- Summarize every user-visible CLI, graph, renderer, visualizer, worker,
  package, and operator-doc change in that changelog entry.
- Put breaking changes and warning-only graph validation changes under the
  changelog entry's `Compatibility And Migration Notes` heading so operators can
  find them quickly.
- Name compatibility changes and link to updated contract docs when public
  command flags, JSON fields, graph semantics, report paths, prompt variables,
  npm scripts, or package binaries change.
- Confirm `npm run release:check` reports changelog notes for the exact package
  version; a missing versioned changelog entry blocks release verification.

## Clean Checkout Gate

Run from a clean checkout or after confirming unrelated local changes are not
part of the release candidate:

```bash
npm ci
npm run format:check
npm run lint
npm run typecheck
npm run audit:dependencies
npm run schema:graph
npm run build
npm run guardrails
npm test
npm run coverage:core
npx playwright install chromium
npm run test:visualizer
npm run smoke:migration
npm run release:check
```

GitHub CI installs Chromium and treats the real-browser visualizer gate as
required with `SPG_REQUIRE_BROWSER=1`. Browser failures upload the captured log,
page screenshot, failure HTML, and graph snapshot from `ci-artifacts/browser/`.
The complexity guardrail report is advisory unless an urgent threshold is
crossed; use warnings to update `docs/technical-debt.md` or plan follow-up
module splits before they become release blockers.
The dependency audit enforces an empty production dependency surface, checks
dev dependency licenses against the repository allowlist, and runs the
moderate-level npm vulnerability audit.
If a local environment cannot install or launch Chromium, or cannot bind the
smoke test to `127.0.0.1`, record the exact restriction in the release notes or
operator handoff and rerun the affected gate in a supported environment before
treating the release as verified.

## Package Contents

Verify package metadata and generated entry points:

```bash
npm run release:check
```

The command runs complexity guardrails, dependency policy and vulnerability
checks, then prints release dry-run evidence with the package name, version,
tarball size, changelog-note status, built binary targets, inclusion/exclusion
checks, and the full `npm pack --dry-run` file manifest. Capture that output in
the release notes or handoff so the dependency and package content reviews are
auditable without rerunning the command.

The package whitelist in `package.json` should include only runtime files needed
by an installed package:

- `dist/scripts/` and `dist/prompts/`: built command modules and copied worker
  prompts from `npm run build`.
- `prompts/`: runtime prompt templates resolved from the package root.
- `scripts/plan-scheduler.mjs`, `scripts/render-plan.mjs`, and
  `scripts/sp-layout.mjs`: compatibility wrappers for source-checkout command
  shapes.
- `schemas/`: checked-in JSON Schema artifacts for graph editor integration.
- `docs/`, `README.md`, `CHANGELOG.md`, `package.json`, and
  `plan-example.graph.json`: operator documentation and a safe sample graph.
- `examples/`: additional validating example graphs used by docs and operator
  onboarding.

The dry run must not include active operating graphs, generated renderer HTML,
worker reports, run logs, temporary files, lock directories, source TypeScript,
or test-only build output such as `dist/tests/`.

## Commit Boundary

Commit source, docs, tests, fixtures, prompts, package metadata, lockfile
changes, and CI configuration that explain or enforce the release.

Do not commit generated or runtime artifacts:

- `dist/`
- generated renderer HTML such as `plan.html`, `plan-*.html`, or other `*.html`
  outputs
- `reports/`
- `runs/`
- `logs/`
- temporary directories and files
- graph lock directories such as `<graph>.lock/`, `<graph>.lock.reaper/`, and
  `<graph>.lock.reap.*/`
- package tarballs from `npm pack`
