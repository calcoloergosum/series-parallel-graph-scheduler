# Testing Architecture

This map defines the test layers for the scheduler, what each layer is
responsible for proving, and which checks are authoritative. The goal is to keep
coverage deterministic while preventing every new behavior from being copied
into another broad end-to-end test.

## Authoritative Checks

Run these checks from the repository root:

| Check | Command | Proves | Required in CI |
|---|---|---|---|
| Dependency install | `npm ci` | Lockfile is complete and reproducible on a clean checkout. | Yes |
| Formatting | `npm run format:check` | Source, docs, prompts, tests, and package metadata use LF endings, final newlines, and no trailing whitespace. | Yes |
| Lint | `npm run lint` | Source scripts, tests, and ESLint configuration satisfy the repository lint policy with zero warnings. | Yes |
| TypeScript contracts | `npm run typecheck` | TypeScript source and typed contract fixtures compile under strict settings without emitting build output. | Yes |
| Dependency policy | `npm run audit:dependencies` | Production dependency surface stays empty, dev dependency licenses stay on the allowlist, and `npm audit --audit-level=moderate` reports no vulnerabilities. | Yes |
| Build | `npm run build` | TypeScript builds to `dist/`, prompts are copied, and package binaries are executable. | Yes |
| Behavior tests | `npm test` | Runs `typecheck`, `build`, and the focused Node suites, including `tests/regressions.test.mjs`, without the Chromium-only browser suite. | Yes |
| Core coverage | `npm run coverage:core` | Runs the Node test suite through c8 and enforces per-file branch/function coverage for `scripts/graph-traversal.ts`, `scripts/node-mutations.ts`, `scripts/graph-io.ts`, `scripts/cli.ts`, `scripts/worker.ts`, and `scripts/visualizer.ts`. | Yes |
| Visualizer browser tests | `npm run test:visualizer` | Starts the local visualizer server and drives the real HTML in Chromium to answer blocked work, observe SSE updates, start/stop managed workers, and check representative graph layouts for visible, unclipped, non-overlapping SVG content without live Codex or Slack. | Yes in GitHub CI after installing Playwright Chromium |
| Migration smoke | `npm run smoke:migration` | Real built entry points can operate on relative and absolute graph paths, run a harmless worker, render HTML, and start `serve`. | Yes, where server binding is supported |
| Package dry run | `npm run release:check` | The package builds, `npm pack --dry-run` contains the expected release files, source/runtime artifacts are excluded, and checklist evidence lists version, changelog status, package files, and built binaries. | Yes |
| Lock contention benchmark | `npm run benchmark:lock-contention` | Measures p50, p95, and max latency for concurrent graph mutation paths on the current local filesystem. | No, manual release evidence only |

`npm test` is the fastest complete behavior gate because it includes
`typecheck`, rebuilds `dist/`, and then runs the focused Node suites. The full
local release gate is:

```bash
npm ci
npm run format:check
npm run lint
npm run typecheck
npm run audit:dependencies
npm run schema:graph
npm run build
npm test
npm run coverage:core
npx playwright install chromium
npm run test:visualizer
npm run smoke:migration
npm run release:check
```

## Core Coverage Thresholds

`npm run coverage:core` measures the six scheduler modules that carry the most
operator-facing risk: traversal, mutation, graph IO, CLI dispatch, worker
orchestration, and the visualizer server. The command runs against built
`dist/scripts/*.js` files with source maps enabled, so c8 reports the matching
`scripts/*.ts` source names while exercising the same artifacts used by the CLI.

Coverage is enforced per file at 65% branch coverage and 80% function coverage.
Those thresholds are intentionally below the current measured branch/function
baseline to avoid brittle failures from harmless refactors, but high enough that
removing a meaningful parser branch, state-transition path, IO error path,
worker outcome handler, or visualizer request handler will fail the gate. Line
and statement percentages are still printed in the text and lcov reports, but
their thresholds are zero because `visualizer.ts` embeds a large HTML/client
template whose line counts are a weak signal compared with branch and function
coverage.

The command writes human-readable output to stdout and lcov data under
`coverage/core/`. It serializes Node test files under c8 because the coverage
gate runs against the shared built `dist/` tree and many tests spawn built CLI
subprocesses. `coverage/` is ignored because these files are generated evidence,
not source.

The browser-level visualizer suite needs a Playwright-managed Chromium binary.
GitHub CI installs Chromium and treats the browser suite as required. To run it
locally:

```bash
npx playwright install chromium
npm run test:visualizer
```

The test command rebuilds `dist/`, starts and tears down its own visualizer
server, clears `SLACK_WEBHOOK_URL`, and uses fake or idle worker settings so it
does not invoke a live Codex command. If Chromium is not installed locally, the
tests are reported as skipped with the install command above. A release can only
use that as an environment exception when the exact install or browser launch
restriction is recorded and the browser gate is rerun in an environment that
supports Playwright Chromium before verification is complete.

Set `SPG_REQUIRE_BROWSER=1` in required gates so a missing Chromium binary fails
instead of skipping. Set `SPG_BROWSER_ARTIFACT_DIR=<dir>` to persist the
browser screenshot, failure page HTML, and graph snapshot; GitHub CI writes
these files under `ci-artifacts/browser/` and uploads them when the visualizer
gate fails.

The GitHub workflow runs the full required gate above on the supported Node.js
LTS majors declared in `package.json`: `20.x`, `22.x`, and `24.x`, including
`npm run coverage:core`. Node 24 is the newest Active LTS line in the official
Node.js release schedule as of 2026-05-27. Dependency caching is keyed from
`package-lock.json`, and `npm ci` is still the installer so cache hits cannot
hide missing, stale, inconsistent lockfile entries, or unsupported Node
runtimes. Browser and smoke command output is uploaded as an artifact when
either gate fails. Protect pull requests by requiring the
`CI / authoritative release gate` matrix status checks in branch protection.

`npm run smoke:migration` starts the local visualizer server on `127.0.0.1` with
an ephemeral port and then calls its graph API. GitHub-hosted Linux runners
support that bind path, so CI must run the smoke test and fail on smoke
regressions. If a non-GitHub environment forbids local server binding, run every
other command in the gate, record the exact bind restriction in the release or
operator notes, and rerun `npm run smoke:migration` in an environment that
supports `127.0.0.1` before treating the release as verified.

## Test Layers

| Layer | Current location | Responsibility | Add tests here when |
|---|---|---|---|
| Unit | Focused suites import built modules such as `graph-traversal`, `cli`, `contracts`, `sp-layout`, and `render-plan`. | Prove pure helpers and narrow functions: readiness traversal, CLI parsing, validation errors, path resolution, layout geometry, escaping helpers, and summary calculations. | The behavior has no filesystem, process, or HTTP dependency and can be asserted directly from inputs and outputs. |
| Contract | `tests/graph-contracts.typecheck.ts`, `tests/validation-contracts.test.mjs`, and `tests/package-smoke.test.mjs`. | Keep public TypeScript shapes, graph compatibility, CLI output fields, prompt variables, package binaries, npm scripts, visualizer payloads, and renderer document fields stable. | A public field, command, flag, environment variable, JSON result shape, graph semantic, report path rule, or renderer/visualizer route changes. |
| CLI | `tests/cli-goldens.test.mjs` uses `execFile` against `dist/scripts/plan-scheduler.js`, `dist/scripts/render-plan.js`, and package bin paths. | Prove command-line parsing, non-zero failures, graph path resolution, JSON stdout shape, stderr diagnostics, and package entry-point compatibility. | The behavior depends on real process arguments, environment variables, stdout/stderr, exit codes, or built binaries. |
| Integration | `tests/scheduler-mutations.test.mjs`, `tests/worker-runtime.test.mjs`, and `tests/visualizer-renderer.test.mjs` temporary graph tests. | Prove multi-step scheduler semantics with real files: claim/start/done, leases, reset variants, decompose, reconcile, locking, reports, notification hooks, and visualizer APIs. | A behavior crosses module boundaries, mutates graph files, relies on leases or locks, or coordinates scheduler state across more than one command. |
| Smoke | `scripts/migration-smoke.mjs` via `npm run smoke:migration`. | Prove built entry points work together in realistic operator paths without requiring Slack or Codex credentials. | The issue is about packaging, generated `dist/`, wrapper parity, relative versus absolute graph paths, or serve startup. Keep smoke broad and shallow. |
| Documentation examples | `tests/doc-examples.test.mjs`. | Keep README quickstart, disposable demo, renderer, diagnostics, and visualizer startup examples aligned with current CLI flags and JSON or HTTP output contracts. | A README command is meant to be copied by operators, especially command flags, graph path resolution, renderer output, diagnostics fields, or serve startup behavior. |
| Browser and DOM | Browser-like coverage lives in `tests/visualizer-renderer.test.mjs` through visualizer HTML script execution, escaped renderer output checks, and HTTP calls to the local server. Real-browser interaction and layout coverage lives in `tests/visualizer-browser.test.mjs`. | Prove the local visualizer payload, action metadata, answer and worker APIs, server-sent-event shell assumptions, client-side escaping, static renderer escaping, Chromium-visible visualizer interactions, and SVG layout invariants. | The behavior touches HTML insertion, browser-visible text, local API routes, worker-manager forms, rendered graph output, or visual geometry. Prefer focused DOM or browser tests over duplicating scheduler integration flows. |
| Security | Current coverage is in the focused Node suites and `scripts/migration-smoke.mjs`. | Prove malformed graph rejection, report path containment, visualizer host warnings, request validation, worker command size limits, Slack isolation, and HTML escaping. | User-controlled input reaches the filesystem, child processes, HTTP APIs, generated HTML, Slack text, graph JSON, or process environment. |
| Regression | `tests/regressions.test.mjs`; no snapshot suite. | Preserve a previously fixed user-visible failure with the smallest fixture that would fail if the bug returned. | A bug fix would otherwise rely on a large integration test or a broad smoke path. Name the test after the user-visible failure, not the implementation detail. |

## Layer Rules

- Prefer the lowest layer that proves the behavior. Do not add a CLI test for a
  pure parser branch if a unit assertion can prove the same thing.
- Use one integration test for a workflow and unit or contract tests for edge
  cases inside that workflow.
- Keep smoke tests broad and shallow. They should answer "does the packaged tool
  still work?" rather than exhaustively checking scheduler semantics.
- Security-sensitive behavior needs a focused negative test at the boundary that
  rejects or escapes the input.
- Public compatibility changes need contract documentation and tests in the
  same change.
- New tests should be deterministic: no live Slack webhook, no live Codex
  process, no dependency on wall-clock timing without a short polling helper, and
  no writes outside a temporary directory.

## GUI And Visualizer Changes

Future GUI work should test the boundary that owns the behavior:

- Payload and action metadata: add contract or integration assertions in
  `tests/graph-contracts.typecheck.ts` and
  `tests/visualizer-renderer.test.mjs` when `/api/graph`, `/events`,
  normalized node details, `actionPolicy`, `actions`, diagnostics, recent
  events, or worker-manager status fields change. Run `npm run typecheck` for
  the type contract and `npm test` for the Node suites.
- HTTP routes: add `tests/visualizer-renderer.test.mjs` coverage for each new
  route, including success responses, malformed JSON or query validation,
  write-token rejection when the route is a `POST`, render-after-update when
  graph state changes, and SSE broadcast when browser state should refresh. Run
  `npm test`; use `npm run coverage:core` when the route change also alters one
  of the covered scheduler modules named in the authoritative checks table.
- Browser interactions: add `tests/visualizer-browser.test.mjs` coverage when a
  user workflow changes in the real page, such as answering a blocked node,
  starting or stopping managed workers, selecting actions, or observing SSE
  updates. Run `npx playwright install chromium` once locally if needed, then
  `npm run test:visualizer`.
- Visual layout: extend the representative layout fixtures in
  `tests/visualizer-browser.test.mjs` when SVG geometry, graph filtering,
  sizing, labels, or status styling changes. The browser layout check should
  prove every expected leaf and frame renders, the SVG has non-empty dimensions,
  graph elements stay inside rendered bounds, node rectangles do not overlap,
  and node labels are not clipped. Run `npm run test:visualizer`; set
  `SPG_REQUIRE_BROWSER=1` for required local gates and
  `SPG_BROWSER_ARTIFACT_DIR=<dir>` when screenshots, failure HTML, and graph
  snapshots should be kept.
- Documentation examples: update `tests/doc-examples.test.mjs` only when README
  visualizer commands, startup flags, or operator-copyable examples change. Run
  `npm test`.

Do not use the browser suite to re-prove scheduler transition semantics already
covered by `tests/scheduler-mutations.test.mjs`. For a new GUI action, prove the
mutation rule at the scheduler layer, the route/request contract at the
visualizer server layer, and only the visible user flow in Chromium.

## Documentation Example Policy

README command examples fall into two classes:

- Runnable examples are mirrored in `tests/doc-examples.test.mjs` when they can
  be executed deterministically with temporary graph files, no live Slack
  webhook, no live Codex process, and loopback-only server binding.
- Non-runnable examples stay in docs only when they are explicitly covered by
  one of the categories below. The substitute column names the required
  lower-risk check that proves the same command shape or operator contract.

| Category | Reason not run directly in CI | Substitute coverage |
|---|---|---|
| `active-graph-mutation` | Mutating examples against `plan-improve.graph.json` would alter the repository's live coordination state. | Run the same command shape against temporary graphs in `tests/doc-examples.test.mjs`, `tests/scheduler-mutations.test.mjs`, or `tests/cli-goldens.test.mjs`. |
| `long-running-daemon` | Foreground visualizer and worker-daemon examples intentionally run until an operator stops them. | Start the service with an ephemeral port or `--once`, assert the API or worker result, then tear it down in tests. |
| `live-codex-worker` | Real Codex worker examples depend on local credentials, installed commands, and model/runtime availability. | Use harmless Node runner commands in worker and smoke tests while preserving the documented `--codex-command` and `--codex-arg` shapes. |
| `environment-gated-release` | Release gates such as browser install, package dry runs, and full CI matrices depend on host tooling and can be slow. | Run them in the release workflow or the named smoke/browser test; document any local environment exception before release verification. |
| `intentional-failure` | Negative examples are supposed to exit non-zero or require tools such as `jq`, so running the literal pipeline would fail the suite for the expected reason. | Assert stderr, exit status, or diagnostic JSON with focused CLI and validation tests. |

## Fixtures vs Inline Graphs

Use the shared in-test `fixtureGraph()` pattern for normal scheduler workflows.
It contains a series root, a parallel branch, and a final gate, so it is the
right default for readiness, claim, lease, reset, decompose, and reconcile tests.

Create or extend a fixture when:

- The same graph shape is needed by three or more tests.
- The graph needs realistic `scheduler`, `document`, lease, report, or history
  metadata.
- The behavior depends on series-parallel topology rather than a single malformed
  field.
- A helper such as `withTempGraph()` can hide repetitive setup while preserving
  readable assertions.

Use an inline graph when:

- The test is for one malformed field, one edge-case child list, or one public
  JSON shape.
- The minimal graph makes the failure easier to see than a shared fixture would.
- The test mutates a fixture in a table of invalid cases and asserts the same
  validation contract for every case.

Do not add checked-in JSON fixture files for one-off cases. Temporary graph
files created under `mkdtemp()` are preferred because graph mutation tests should
own their input and leave no repository artifacts behind.

## Duplicate Pattern Guardrails

- Parser behavior belongs in parser tests; downstream command tests should cover
  only one representative parser path.
- Graph validation failures should be table-driven from one valid base graph
  where possible.
- CLI tests should assert stable fields, exit behavior, and important messages;
  avoid asserting entire JSON payloads unless the full shape is the contract.
- Integration tests should avoid repeating `ready -> claim -> start -> done`
  unless the asserted state transition is materially different.
- Browser or DOM tests should reuse visualizer payload builders and assert
  escaped output or API response shape, not scheduler traversal semantics already
  covered elsewhere.
- Smoke tests should not become a second integration suite. Add a smoke step only
  when a packaging or real-entry-point failure would not be caught by `npm test`.

## Historical Regressions

Add historical bug coverage to `tests/regressions.test.mjs` when the failure was
visible to an operator or maintainer and the fix would otherwise be protected
only by a broad integration path. Keep the test name in this form:
`regression: <user-visible failure>`. Good names describe the symptom, such as
`regression: blocked parallel work does not hide ready sibling work`, rather
than the function or branch that caused it.

Regression tests should use the smallest graph and command sequence that would
have failed before the fix. Prefer shared harness helpers such as
`withTempGraph()`, `fixtureGraph()`, and direct module calls. Do not copy a full
CLI, worker, or visualizer workflow into the regression file unless the bug was
specifically in that public boundary. When a regression grows into general
coverage for a feature, move the broad behavior to the owning domain suite and
leave only the historical failure case in `tests/regressions.test.mjs`.

## Missing Test Categories

These categories are named in the quality bar but are not yet fully represented:

- Broader visual regression coverage for visualizer layout. The current
  real-browser suite asserts core panels and captures a temporary screenshot, but
  it does not compare screenshots.
- A formal CI-gated concurrency stress suite beyond the current double-claim,
  lock timeout, deterministic stress, and manual lock-contention benchmark
  cases.
- A transition-table contract suite that enumerates every allowed and important
  disallowed status transition.
- Broader coverage reporting outside the six core scheduler modules. The
  release gate intentionally starts with branch and function thresholds for the
  modules where coverage gives the strongest maintenance signal.
