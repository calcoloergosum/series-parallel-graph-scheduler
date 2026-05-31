# Maintainer Architecture

This document maps the scheduler codebase for maintainers. It explains where
changes belong, which modules should stay pure, which modules are allowed to
touch the filesystem, network, HTTP, or child processes, and how new commands or
graph fields should be added without blurring module ownership.

For public behavior guarantees, use
[`compatibility-boundaries.md`](compatibility-boundaries.md). For mutation field
ownership, use [`mutation-ownership.md`](mutation-ownership.md). For test
placement, use [`testing.md`](testing.md).

## Source And Build Layout

TypeScript source lives under `scripts/*.ts`. The runtime JavaScript output goes
to `dist/` because Node package binaries and compatibility wrappers execute
plain JavaScript, not TypeScript source:

- `npm run build` removes `dist/`, runs `tsc`, copies `prompts/` to
  `dist/prompts/`, and marks built CLI files executable.
- `package.json` binaries point at `dist/scripts/plan-scheduler.js` and
  `dist/scripts/render-plan.js`.
- `scripts/plan-scheduler.mjs` and `scripts/render-plan.mjs` are compatibility
  wrappers that import the built files from `dist/`.
- Tests that exercise real CLI behavior run against `dist/` so package and
  wrapper behavior match what operators run.

Keep `scripts/*.ts` as the source of truth. Treat `dist/` as generated output:
build it before running wrappers or package binaries, but do not make manual
source changes there.

## Dependency Direction

Keep dependencies flowing from contracts and pure logic outward to runtimes and
entry points. Read this as a layer map: modules in lower layers can be imported
by modules in higher layers, but lower layers should not reach upward into
runtime orchestration.

```text
Layer 0: contracts
Layer 1: shared-utils, numeric-args, operational-events, runtime-paths,
         graph-traversal, sp-layout
Layer 2: graph-io, node-mutations, notification
Layer 3: cli, worker, visualizer, visualizer-*, render-plan
Layer 4: plan-scheduler
Layer 5: .mjs wrappers and npm/package entry points
```

The important rule is not the exact order of every import inside a layer. The
rule is that core contracts and pure graph logic must not import runtime
orchestration. Runtime modules can depend on pure modules. Entry-point modules
wire concrete filesystem, process, HTTP, and network behavior into handler
interfaces.

## Module Boundaries

| Module | Boundary | Side effects |
| --- | --- | --- |
| `scripts/contracts.ts` | Public TypeScript shapes, known statuses and kinds, graph validation, renderer and visualizer payload shapes, visualizer action metadata shapes. | Pure. Validation returns issues and does not read or write files. |
| `scripts/graph-traversal.ts` | Read-only graph queries: node lookup, leaf detection, readiness traversal, working-node list, summaries, ancestor discovery. | Pure after receiving a parsed graph object. |
| `scripts/sp-layout.ts` | Planar graph layout and SVG rendering for renderer and visualizer graph views. | Pure after receiving a parsed graph object. |
| `scripts/numeric-args.ts` | Shared numeric CLI and API argument ranges. | Pure. |
| `scripts/shared-utils.ts` | Small reusable helpers such as error formatting, sleeps, and safe file-name parts. | Mostly pure. `sleep` is timing-related but has no graph side effects. |
| `scripts/operational-events.ts` | Stable operational event names, event taxonomy, and redaction helpers. | Pure. |
| `scripts/graph-io.ts` | Graph and report file I/O, graph validation on read, atomic writes, graph-relative path containment, filesystem locks. | Side-effectful filesystem code. This is the file boundary for graph persistence. |
| `scripts/node-mutations.ts` | Scheduler state transitions: claim, start, renew, done, block, answer, fail, reset variants, decompose, reconcile, release expired leases. | Side-effectful because exported commands acquire locks, read graph files, mutate graph objects, and write files. Transition rules live here. |
| `scripts/notification.ts` | Slack message construction and webhook delivery. | Network side effects only when `SLACK_WEBHOOK_URL` is set. Message formatting is testable through exported helpers. |
| `scripts/cli.ts` | Argument parsing, CLI command dispatch, help text, output shaping, handler interface. | Designed to be mostly testable through injected handlers. It should not directly own filesystem or process behavior beyond resolving CLI paths and printing through `output`. |
| `scripts/worker.ts` | Worker prompt rendering, claim/start/run/finalize loop, lease heartbeat, Codex child-process execution, report formatting. | Side-effectful runtime code. Uses an injected `WorkerRuntime` for graph operations and notifications. |
| `scripts/visualizer.ts` | Compatibility facade for visualizer exports. | Re-exports the visualizer server, payload, worker-manager, host-security, and HTML helpers. |
| `scripts/visualizer-client.ts` | Visualizer HTML, CSS, and browser client script. | Pure string rendering. Browser-side code calls the public visualizer HTTP API and treats server payload text as untrusted. |
| `scripts/visualizer-actions.ts` | Server-computed node action availability, required fields, danger level, confirmation metadata, and lease credential policy hints. | Pure after receiving a parsed graph object. These hints are advisory; mutation guards remain authoritative. |
| `scripts/visualizer-payload.ts` | Visualizer graph payload shaping for SVG, normalized node details, action metadata, attention summaries, diagnostics, events, ready/working lists, summary, and worker-manager status defaults. | Reads graph files and lock state through `graph-io`; otherwise composes lower-layer read-only helpers. |
| `scripts/visualizer-routes.ts` | Local HTTP visualizer server, public routes, SSE, request JSON/query parsing, route-level request validation, write-token enforcement, and broadcast after writes. | Side-effectful HTTP and filesystem watch code. Mutations still go through injected runtime handlers. |
| `scripts/visualizer-worker-manager.ts` | Visualizer-managed scheduler worker process control and worker-start validation. | Side-effectful child-process code. Starts scheduler worker subprocesses instead of importing the worker loop directly. |
| `scripts/render-plan.ts` | Static HTML renderer for graph `document` content and planar SVG output. | Side-effectful CLI entry point: reads graph files and writes HTML. Escaping and rendering helpers should remain local unless tests need a narrower export. |
| `scripts/plan-scheduler.ts` | Main scheduler entry point and composition root. Re-exports public helpers, constructs CLI handlers, builds worker and visualizer runtimes, and handles direct execution. | Side-effectful orchestration. This is where concrete modules are wired together. |
| `scripts/*.mjs` wrappers | Backward-compatible executable paths. | Runtime-only wrappers around built `dist` modules. Keep them thin. |
| `tests/*` | Behavior, contract, CLI, integration, smoke, and browser coverage. | Tests may spawn processes and write temp files, but checked-in fixtures should stay focused. See `docs/testing.md`. |

## Core Data Flow

Read-only commands follow this path:

```text
CLI args
  -> cli.dispatchCliCommand
  -> graph-io.readGraph
  -> contracts.validatePlanGraphFileResult
  -> graph-traversal query
  -> JSON or text output
```

Mutating commands follow this path:

```text
CLI args or visualizer API
  -> cli or visualizer request validation
  -> node-mutations exported command
  -> graph-io.withGraphLock
  -> graph-io.readGraph
  -> transition guard and in-memory mutation
  -> graph-io.writeGraphAtomic
  -> optional renderPlanAfterUpdate
  -> optional notification.sendSlackNotification
  -> JSON response
```

Worker execution adds a child-process step:

```text
worker.runWorker
  -> claimNode
  -> startNode
  -> buildWorkerPrompt
  -> startLeaseHeartbeat
  -> runCodexPrompt
  -> writeReportFile
  -> completeNode or failNode
  -> renderPlanAfterUpdate
```

Visualizer reads and writes through the same module boundaries as the CLI. Its
worker manager starts scheduler worker processes instead of importing the worker
loop directly, which keeps visualizer process control visible and compatible
with package entry points.

The visualizer payload is public enough for browser code, tests, and local
operator integrations to rely on its minimum shape. Keep the compatibility
contract in [`compatibility-boundaries.md`](compatibility-boundaries.md) aligned
when changing `/api/graph`, `/events`, normalized node details, action metadata,
or worker-manager status fields. Additive fields are compatible; removing or
renaming documented fields is a compatibility change.

## Ready Priority Ownership

Readiness and priority are intentionally separate helper boundaries:

- `scripts/graph-traversal.ts` owns read-only readiness traversal and priority
  helpers. `listReadyLeafNodes` decides which leaves are eligible to claim.
  `buildReadyPrioritySelections`, `compareReadyPriorityCandidates`, and
  `selectReadyNodeByPriority` build and order the deterministic priority tuple.
  Read-only ready surfaces consume `listReadyLeafNodes`, so CLI ready output,
  diagnostics, worker prompt `readyJson`, and visualizer payloads share the
  same sorted order and priority metadata.
- `scripts/node-mutations.ts` owns the mutating claim transition. `claimNode`
  acquires the graph lock, releases expired leases, calls `listReadyLeafNodes`,
  resolves optional current-task context, then uses `selectReadyNodeByPriority`
  for context-aware automatic claims. Explicit `claim --node ID` still bypasses
  priority ordering after readiness has been checked.
- `tests/scheduler-mutations.test.mjs` contains the focused comparator tests at
  the start of the file and the integration coverage proving automatic claims
  still mutate graph state through `claimNode`. Fixture builders used by those
  tests live in `tests/helpers/plan-scheduler-harness.mjs`.

Keep future priority tuple fields centralized in `graph-traversal.ts`. Add the
metadata calculation to `buildReadyPrioritySelections`, add the ordering rule to
`compareReadyPriorityCandidates`, and extend the focused comparator tests before
changing claim behavior. Do not duplicate tuple comparison in CLI, worker,
visualizer, or mutation code; those callers should consume the traversal helper
so display order, diagnostics, and automatic claim behavior cannot drift apart.

The final raw node-id tie-breaker is part of the concurrency contract. Multiple
workers can observe the same ready set before one wins the graph lock, and
object insertion order, traversal order, lease timing, or worker timing must not
decide which equally ranked node is selected. A deterministic final tie-breaker
keeps automatic claims repeatable across processes and makes concurrency
failures auditable from graph history.

## Extension Points

### Adding A Scheduler Command

Add commands in this order:

1. Add the command name to `CliCommand` in `contracts.ts` and `cliCommands` in
   `cli.ts`.
2. If the command mutates graph state, add or update a transition in
   `schedulerTransitionTable` in `node-mutations.ts`.
3. Implement pure parsing in `cli.ts`; keep real graph writes, report writes,
   notifications, and rendering behind `CliCommandHandlers`.
4. Implement graph state changes in `node-mutations.ts` when the command changes
   node or graph status. Use `withGraphLock`, validate status and leaf scope,
   append history, increment `graphVersion`, and preserve unknown metadata.
5. Wire the handler in `plan-scheduler.ts`.
6. If the command is reachable from the visualizer, add request validation in
   `visualizer-routes.ts`, keep token enforcement on write routes, and delegate
   graph mutations through the injected `VisualizerRuntime`.
7. Update `README.md`, `compatibility-boundaries.md`, and CLI help when operator
   behavior changes.
8. Add the lowest useful tests: parser/unit tests for parsing, direct mutation
   tests for state rules, CLI tests for stdout and exit behavior, and visualizer
   tests for HTTP routes.

New commands should not bypass `node-mutations.ts` for graph state changes. That
module is the maintainer-owned place for status guards, lease rules, history
events, and metadata preservation.

### Adding A Visualizer Action Or Route

Add GUI actions in this order:

1. If the action changes scheduler state, add or reuse a CLI/mutation operation
   in `node-mutations.ts` first. The visualizer must not invent a separate
   state transition.
2. Add typed action metadata in `contracts.ts` when the browser payload exposes
   a new action id, danger level, required field, confirmation, or policy
   field.
3. Add action availability in `visualizer-actions.ts`. Use graph traversal and
   transition-table helpers for advisory disabled reasons, and keep lease checks
   consistent with the server mutation guards.
4. Add payload fields in `visualizer-payload.ts` only when the browser needs
   normalized data that should not be recomputed in client code. Redact
   secret-shaped values before returning node details or event-derived fields.
5. Add the HTTP route in `visualizer-routes.ts`. Parse JSON or query fields at
   the route boundary, enforce the visualizer write token for every `POST`
   route, call the injected runtime handler, render after graph writes, and
   broadcast an updated payload over SSE.
6. Add or update browser behavior in `visualizer-client.ts`. Insert graph,
   worker, log, and user-provided text through text-safe DOM APIs.
7. Document route, request, response, and payload compatibility changes in
   `compatibility-boundaries.md`. Update README only when operator-facing
   commands, flags, safety behavior, or startup examples change.
8. Add tests at the matching boundary: payload/action contract tests, route
   validation and token tests, browser interaction tests, and layout checks when
   the UI or SVG geometry changes.

Read-only GUI routes may compose `graph-traversal`, `operational-events`,
`worker`, or payload helpers, but they should not mutate the graph. Write routes
must follow the same mutation, report, render, notification, and history
ownership used by CLI commands.

### Adding A Graph Field

Classify the field before adding code:

- Public contract field: add the TypeScript shape in `contracts.ts`, document it
  in `compatibility-boundaries.md` or a focused doc, and add contract tests.
- Operational mutation field: define which command owns it in
  `mutation-ownership.md`, update mutation code and history payloads, and add
  reset or clearing behavior only when the command owns that cleanup.
- Renderer-only document field: add it under renderer document contracts and
  update `render-plan.ts` escaping and rendering behavior.
- Visualizer-only payload field: add it to the visualizer payload contract and
  tests without changing graph persistence unless it must be stored.
- Internal helper field: prefer keeping it out of the graph file. If it must be
  persisted, preserve unknown metadata and document whether operators may rely on
  it.

Validation in `contracts.ts` should reject malformed graph structure and unsafe
runtime assumptions. It should warn, not fail, for tolerated future metadata
when the scheduler can still operate safely.

### Adding A Node Kind Or Status

Update these areas together:

- `knownNodeKinds` or `knownNodeStatuses` in `contracts.ts`.
- Traversal behavior in `graph-traversal.ts` if readiness or done semantics
  change.
- Transition guards in `node-mutations.ts` if commands can move to or from the
  new status.
- Renderer and visualizer styles if the new value appears in operator-facing
  HTML.
- Compatibility docs and transition tests when public behavior changes.

Unknown kinds and statuses are intentionally tolerated in some paths for
forward compatibility. Do not turn a warning into a hard error unless the graph
would be unsafe or ambiguous to operate.

## Testing Ownership

Use `docs/testing.md` for the full test strategy. The short architecture rule is
to test at the first boundary that can prove the behavior:

- Pure graph behavior belongs in direct imports from built modules.
- CLI argument and stdout behavior belongs in CLI process tests against `dist`.
- Graph mutation behavior belongs in temp-file integration tests.
- Renderer and visualizer escaping should be tested at the HTML or browser
  boundary where the risk appears.
- Worker behavior should use fake Codex commands and temporary graphs unless the
  goal is explicitly to test packaging or operator smoke paths.

Docs-only changes should at least run `npm run format:check`. Changes that alter
commands, contracts, traversal, mutation rules, rendering, worker behavior, or
visualizer APIs should run the relevant checks named in `docs/testing.md`.
