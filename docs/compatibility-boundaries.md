# Compatibility Boundaries

This document is the public compatibility contract for the scheduler CLI, graph files, workers, visualizer, renderer, package binaries, reports, and generated artifacts. Hardening work may tighten invalid inputs, but valid workflows described here should keep working unless an operator explicitly approves a breaking change.

The scheduler graph format remains plain JSON. This document does not introduce a new schema version; it defines the behavior that tests, README examples, and operator workflows should preserve.

Compatibility version: `0.1`. This version follows the package version in
`package.json` until the project adopts a separate graph schema version. A
breaking compatibility change requires a new compatibility version, an explicit
migration note in this document, a matching changelog entry under
`Compatibility And Migration Notes`, and tests updated in the same change set.
Warning-only graph validation changes must also be named in the changelog before
release so operators can find non-fatal graph behavior changes quickly.

## Versioned Compatibility Matrix

This matrix is the index of stable public surfaces for compatibility version
`0.1`. Owner docs describe operator-facing behavior; test references name the
authoritative coverage that should fail when the surface regresses.

| Surface | Stable items | Owner docs | Test reference |
| --- | --- | --- | --- |
| npm scripts | `ready`, `summary`, `serve`, `worker`, `render`, `schema:graph`, `smoke:migration`, `smoke:package`, `clean`, `format:check`, `audit:dependencies`, `lint`, `check`, `release:check`, `typecheck`, `build`, `test`, `coverage:core`, `test:visualizer`, `stress:deterministic`, `benchmark:lock-contention` | `README.md` "Command Entry Points"; `docs/testing.md`; `docs/lock-contention-benchmark.md` | `tests/package-smoke.test.mjs` "package npm scripts and bins target migrated build output"; `tests/fixtures/cli-goldens.json`; `scripts/migration-smoke.mjs`; `scripts/package-smoke.mjs` |
| Package binaries | `spg-scheduler`, `spg-render-plan` | `README.md` "Command Entry Points" | `tests/package-smoke.test.mjs` "built package bin entry points smoke test scheduler and renderer CLIs" |
| Compatibility wrappers | `node scripts/plan-scheduler.mjs ...`, `node scripts/render-plan.mjs ...`, `node scripts/sp-layout.mjs` as a layout wrapper | `README.md` "Command Entry Points"; this document "Stable CLI Surface" | `tests/package-smoke.test.mjs`; `scripts/migration-smoke.mjs` |
| Scheduler commands | `plan`, `ready`, `summary`, `diagnostics`, `events`, `claim`, `start`, `renew`, `reset`, `reset-subtree`, `reset-reachable`, `done`, `block`, `answer`, `fail`, `decompose`, `apply-preview`, `reject-preview`, `prompt`, `worker`, `reconcile`, `release-expired`, `serve`, `help` | `README.md` "Scheduler Commands" and "Goal-Driven Planning"; `docs/operational-events.md`; this document "Stable CLI Surface" | `tests/fixtures/cli-goldens.json`; `tests/cli-goldens.test.mjs`; `tests/scheduler-mutations.test.mjs`; `tests/worker-runtime.test.mjs`; `tests/validation-contracts.test.mjs`; `tests/visualizer-renderer.test.mjs` |
| Scheduler flags | `--graph`, `--goal`, `--title`, `--dry-run`, `--plan-only`, `--then-run`, `--node`, `--event`, `--limit`, `--session`, `--run`, `--lease`, `--reason`, `--report`, `--report-body`, `--question`, `--answer`, `--responder`, `--kind`, `--child`, `--child-json`, `--template`, `--cwd`, `--once`, `--quiet`, `--idle-ms`, `--timeout-ms`, `--codex-command`, repeated `--codex-arg`, `--isolation`, `--remote`, `--workspace-root`, `--workspace-retention`, `--planner-mode`, `--planner-adapter`, `--planner-fixture`, `--planner-template`, `--planner-failure-policy`, repeated `--planner-allowed-kind`, `--planner-request-id-prefix`, `--port`, `--host`, `--visualizer-write-token`, `--unsafe-visualizer-write`, `--help` | `README.md`; `docs/operational-events.md`; this document "Stable CLI Surface", "Goal-Driven Mode Compatibility Note", and "Worker Execution Contract" | `tests/fixtures/cli-goldens.json`; `tests/cli-goldens.test.mjs`; `tests/worker-runtime.test.mjs`; `tests/visualizer-renderer.test.mjs` |
| Renderer flags and positional arguments | `--graph`, `--output`, `--out`, first positional graph path, second positional output path | `README.md` "Renderer Usage"; this document "Renderer Output Locations" | `tests/visualizer-renderer.test.mjs` static renderer tests; `scripts/migration-smoke.mjs` |
| Environment variables | `PLAN_GRAPH`, `SLACK_WEBHOOK_URL`, `SPG_SLACK_TIMEOUT_MS`, `SPG_DEBUG`, `SPG_GRAPH_LOCK_TIMEOUT_MS`, `SPG_GIT_CACHE_LOCK_TIMEOUT_MS` | `README.md`; `docs/security.md`; this document "Stable CLI Surface" | `tests/cli-goldens.test.mjs`; `tests/visualizer-renderer.test.mjs`; `tests/validation-contracts.test.mjs` |
| JSON stdout shapes | Successful JSON from `plan`, `ready`, `summary`, `diagnostics`, `events`, `claim`, `start`, `renew`, `reset`, `reset-subtree`, `reset-reachable`, `done`, `block`, `answer`, `fail`, `decompose`, `apply-preview`, `reject-preview`, `worker`, `reconcile`, and `release-expired` | This document "JSON Output Shapes"; `docs/operational-events.md` | `tests/fixtures/cli-goldens.json`; `tests/cli-goldens.test.mjs`; `tests/validation-contracts.test.mjs` |
| Graph JSON format | Top-level graph metadata, `scheduler`, `document`, `graph.root`, `graph.nodes`, node status/kind/lease/history/report/ref fields, unknown metadata preservation, validation errors and warnings | `README.md` "Graph Validation"; `docs/graph-authoring.md`; `docs/mutation-ownership.md`; this document "Graph State Semantics" | `tests/validation-contracts.test.mjs`; `tests/fixtures/graphs/*`; `tests/graph-contracts.typecheck.ts` |
| Graph behavior | Series/parallel/gate readiness, busy and terminal statuses, lease ownership and expiry, status transitions, reset scopes, decomposition, reconciliation, composition output refs | `README.md` "Operating Model"; this document "Graph State Semantics"; `docs/mutation-ownership.md`; `docs/worker-isolation-remote-cache.md` | `tests/scheduler-mutations.test.mjs`; `tests/worker-runtime.test.mjs`; `tests/validation-contracts.test.mjs` |
| Prompt variables | `cwd`, `graphPath`, `nodeId`, `runId`, `session`, `reportPath`, `schedulerCommand`, `planTitle`, `planDescription`, `nodeTitle`, `nodeKind`, `nodeStatus`, `nodeJson`, `readyJson`, `summaryJson` | `README.md` "Worker Usage"; this document "Worker Execution Contract"; `prompts/codex-worker-task.md` | `tests/worker-runtime.test.mjs` "prompt command renders an external template"; `scripts/migration-smoke.mjs` |
| Worker execution | Shared-cwd worker mode, Git-only isolation mode, report generation, Codex command invocation, streaming/quiet behavior, heartbeat renewal, workspace-retention controls | `README.md` "Worker Usage"; `docs/worker-isolation-remote-cache.md`; this document "Worker Execution Contract" | `tests/worker-runtime.test.mjs`; `tests/cli-goldens.test.mjs` worker CLI tests |
| Visualizer routes | `GET /`, `GET /index.html`, `GET /api/graph`, `GET /api/workers`, `GET /api/summary`, `GET /api/ready`, `GET /api/diagnostics`, `GET /api/events`, `GET /api/prompt`, `GET /events`, `POST /api/answer`, `POST /api/goal/plan`, `POST /api/node/claim`, `POST /api/node/start`, `POST /api/node/renew`, `POST /api/node/done`, `POST /api/node/block`, `POST /api/node/answer`, `POST /api/node/fail`, `POST /api/node/reset`, `POST /api/node/reset-subtree`, `POST /api/node/reset-reachable`, `POST /api/node/decompose`, `POST /api/node/apply-preview`, `POST /api/node/reject-preview`, `POST /api/node/regenerate-preview`, `POST /api/graph/reconcile`, `POST /api/leases/release-expired`, `POST /api/workers/start`, `POST /api/workers/stop`, `POST /api/workers/stop-all` | `README.md` "Visualizer Safety"; `docs/security.md`; this document "Visualizer Contract" | `tests/visualizer-renderer.test.mjs` visualizer API and payload tests; `tests/visualizer-browser.test.mjs`; `scripts/migration-smoke.mjs` |
| Renderer outputs | Static HTML output resolution, atomic replacement, escaped document text, safe href handling, structural tables, and planar graph SVG | `README.md` "Renderer Usage"; this document "Renderer Output Locations" | `tests/visualizer-renderer.test.mjs` static renderer and planar SVG tests; `scripts/migration-smoke.mjs` |
| Reports and generated artifacts | `reports/<safe-node-id>-<safe-run-id>.md`, manual report writes, `dist/`, copied prompts, optional generated `plan.html`, graph lock metadata, two-space graph JSON with trailing newline | `README.md`; this document "Reports" and "Generated Artifacts"; `docs/output-safety-audit.md` | `tests/validation-contracts.test.mjs`; `tests/worker-runtime.test.mjs`; `tests/package-smoke.test.mjs` |
| Operational events | Graph history names, worker-manager names, lock diagnostic names, stable fields, redaction rules | `docs/operational-events.md`; this document "Graph State Semantics" | `tests/validation-contracts.test.mjs`; `tests/scheduler-mutations.test.mjs`; `tests/visualizer-renderer.test.mjs`; `tests/worker-runtime.test.mjs`; `tests/graph-contracts.typecheck.ts` |

## Stable CLI Surface

Keep these entry points working:

- npm scripts: `ready`, `summary`, `serve`, `worker`, `render`,
  `schema:graph`, `smoke:migration`, `smoke:package`, `clean`,
  `format:check`, `audit:dependencies`, `lint`, `check`, `release:check`,
  `typecheck`, `build`, `test`, `coverage:core`, `test:visualizer`,
  `stress:deterministic`, and `benchmark:lock-contention`.
- package binaries: `spg-scheduler` and `spg-render-plan`.
- compatibility wrappers: `node scripts/plan-scheduler.mjs ...` and `node scripts/render-plan.mjs ...`.
- built commands: `node dist/scripts/plan-scheduler.js ...` and `node dist/scripts/render-plan.js ...`.

Keep these scheduler command names compatible:

- `plan`
- `ready`
- `summary`
- `diagnostics`
- `events`
- `claim`
- `start`
- `renew`
- `reset`
- `reset-subtree`
- `reset-reachable`
- `done`
- `block`
- `answer`
- `fail`
- `decompose`
- `apply-preview`
- `reject-preview`
- `prompt`
- `worker`
- `reconcile`
- `release-expired`
- `serve`
- `help`

Stable scheduler flags include `--graph`, `--goal`, `--title`, `--dry-run`,
`--plan-only`, `--then-run`, `--node`, `--event`, `--limit`, `--session`,
`--run`, `--lease`, `--reason`, `--report`, `--report-body`, `--question`,
`--answer`, `--responder`, `--kind`, `--child`, `--child-json`, `--template`,
`--cwd`, `--once`, `--quiet`, `--idle-ms`, `--timeout-ms`, `--codex-command`,
repeated `--codex-arg`, `--isolation`, `--remote`, `--workspace-root`,
`--workspace-retention`, `--planner-mode`, `--planner-adapter`,
`--planner-fixture`, `--planner-template`, `--planner-failure-policy`,
repeated `--planner-allowed-kind`, `--planner-request-id-prefix`, `--port`,
`--host`, `--visualizer-write-token`, `--unsafe-visualizer-write`, and
`--help`.
Stable renderer flags include `--graph`, `--output`, and `--out`.

Stable environment variables:

- `PLAN_GRAPH`: default graph path for scheduler and renderer commands when `--graph` or a renderer positional graph path is not supplied.
- `SLACK_WEBHOOK_URL`: enables Slack notifications for `done`, `block`, `answer`, `fail`, `decompose`, `apply-preview`, `reject-preview`, and `regenerate-preview`; when unset, successful JSON includes a skipped Slack result instead of failing.
- `SPG_SLACK_TIMEOUT_MS`: Slack notification timeout in milliseconds; default `5000`.
- `SPG_DEBUG=1`: prints stack traces with CLI errors.
- `SPG_GRAPH_LOCK_TIMEOUT_MS`: graph lock wait timeout in milliseconds;
  default `5000`.
- `SPG_GIT_CACHE_LOCK_TIMEOUT_MS`: Git cache lock wait timeout in milliseconds;
  default `60000`.

CLI graph path resolution is stable:

- Scheduler commands resolve `--graph`, then `PLAN_GRAPH`, then `plan.graph.json`, from the package root.
- Renderer commands resolve `--graph`, then the first positional argument, then `PLAN_GRAPH`, then `plan.graph.json`, from the package root.

Changes that rename commands, remove flags, change flag meanings, remove package binaries, change npm-script entry-point behavior, or change environment variable meanings are breaking changes.

### Goal-Driven Mode Compatibility Note

Goal-driven planning is an opt-in mode layered on top of the existing graph
executor. Existing static graph workflows do not need graph changes, and
`plan.graph.json` remains a supported source of truth for operators that prefer
to author or maintain the graph directly.

The goal-driven contract separates graph creation from graph execution:

- `plan --goal "..."` is the graph-creation command. It accepts a root goal,
  asks the planner to produce an initial series-parallel graph, validates the
  result with the existing graph validator, and writes a graph JSON file.
- `worker`, `claim`, `start`, `done`, `block`, `fail`, `decompose`,
  `apply-preview`, `reject-preview`,
  `reconcile`, `release-expired`, `serve`, and the read-only inspection
  commands execute, inspect, recover, or mutate an existing graph file. They do
  not create a new graph from `--goal`.

When `plan --goal` is used without an explicit graph output path, it writes the
generated graph under `runs/goals/<timestamp>-<safe-goal-slug>/plan.graph.json`
relative to the package root. The timestamp makes repeated planning runs
non-destructive; the slug is only an operator hint and must use the same safe
path-token policy as reports and isolated worker paths. If the operator wants
the generated graph to be the default graph for later commands, they must pass
`--graph plan.graph.json` to the planning command intentionally.

For the `plan` command only, `--graph PATH` names the graph file to create. This
does not change existing graph-selection semantics for the already documented
scheduler commands: for those commands, `--graph` still selects the input graph,
then `PLAN_GRAPH`, then `plan.graph.json`. A later renderer still follows its
separate `--graph`, positional graph path, `PLAN_GRAPH`, then
`plan.graph.json` resolution order.

Generated graph replay is ordinary static graph execution. After graph
creation, operators can run existing commands against the generated file:

```bash
node scripts/plan-scheduler.mjs plan --goal "Ship a searchable audit log"
node scripts/plan-scheduler.mjs summary --graph runs/goals/20260531T000000Z-ship-a-searchable-audit-log/plan.graph.json
node scripts/plan-scheduler.mjs worker --graph runs/goals/20260531T000000Z-ship-a-searchable-audit-log/plan.graph.json --session codex-A --once
```

For immediate execution, operators can opt in with `--then-run`. The command
writes the generated graph first, then invokes the same worker runtime used by
the existing `worker` command. Plain `plan` and explicit `--plan-only` stop
after writing the graph for review.

Resume behavior also uses the generated graph file as the durable source of
truth. If a worker stops, an operator resumes by passing the same generated
graph path to `worker`, `serve`, `ready`, `diagnostics`, or recovery commands.
The original `--goal` text is planner input, not a resume handle. Re-running
`plan --goal` creates a new planning artifact by default and must not overwrite
an existing graph unless a future explicit overwrite flag says so.

| Mode | Opt-in signal | Graph path meaning | Default path | Creates graph? | Executes graph? | Resume or replay |
| --- | --- | --- | --- | --- | --- | --- |
| Static graph mode | Any existing scheduler command without `--goal` | `--graph` selects the input graph; fallback is `PLAN_GRAPH`, then `plan.graph.json` | `plan.graph.json` from the package root | No | Yes, for mutating and worker commands | Re-run the same command with the same graph path |
| Goal planning mode | `plan --goal "..."` or `plan --goal "..." --plan-only` | `--graph` names the graph file to create for this command only | `runs/goals/<timestamp>-<safe-goal-slug>/plan.graph.json` | Yes | No | Resume by using the written graph path with existing commands |
| Goal planning and execution mode | `plan --goal "..." --then-run` | `--graph` names the graph file to create, then the worker input graph | `runs/goals/<timestamp>-<safe-goal-slug>/plan.graph.json` | Yes | Yes, through the existing worker runtime | Resume by using the written graph path with existing commands |
| Generated graph replay mode | Existing scheduler command with `--graph <generated-plan.graph.json>` | `--graph` selects the generated graph as input | None beyond the existing scheduler fallback if omitted | No | Yes | Re-run `worker`, `serve`, `diagnostics`, or recovery commands with the same generated graph path |

Goal-driven behavior must remain additive. Introducing `--goal` must not make
existing `--graph` commands plan implicitly, change the default graph selection
for static workflows, or require existing `plan.graph.json` files to adopt
planner metadata.

The initial generated topology is not fixed. `ROOT -> PLAN` remains a valid
minimal generated graph, but `plan --goal` may also write a validated,
decomposed series-parallel graph directly. Consumers must inspect the written
graph rather than assume a `PLAN` node. The user-visible acceptance workflows
for plan-only, approve-before-run, auto-decompose, and static replay are
defined in
[`goal-driven-acceptance-contract.md`](goal-driven-acceptance-contract.md).

Planner approval and execution boundaries are part of the compatibility
contract. Dry-run planning must not mutate the graph or start workers.
Auto-save may write only validated planner output through the normal locked
graph writer. Worker execution requires either a separate approve-before-run
step against a saved graph or the explicit `--then-run` opt-in on the planning
command. Regenerate flows must create a new proposal instead of silently
overwriting accepted graph state. Detailed failure and security rules live in
[`planning-safety-and-approval.md`](planning-safety-and-approval.md).

## JSON Output Shapes

Commands that currently print JSON should continue to print a single JSON value to stdout:

- `ready`: array of ready leaf objects with at least `id`, `kind`, and `status`; `title`, `question`, `answer`, and `answeredAt` are present when known on the node.
- `plan`: object with at least `graphPath`, `mode`, `dryRun`, `written`,
  `rootId`, `nodeCount`, `nextCommands`, `validation`, `summary`, and `graph`.
  Plain `plan` and `--plan-only` report `mode: "plan-only"` and do not start a
  worker. `--then-run` reports `mode: "plan-then-run"` and includes
  `execution`, using the same result shape as `worker` when execution starts.
  If worker setup fails after the graph is written, the JSON result still
  reports the graph path and an `execution.failed` error before the command
  exits non-zero.
- `summary`: object with at least `totalNodes`, `root`, and `counts`; `graphVersion`, `title`, and `description` are present when known on the graph.
- `diagnostics`: object with at least `generatedAt`, `summary`,
  `nextReady`, `leases`, `blocked`, `failed`, `isolation`, and `actions`;
  `graphPath` and `lock` are present when known. `leases` has `active` and
  `expired`; `isolation` has `activeWorkers`, `missingOutputRefs`, and
  `unresolvedBufferConflicts`. Diagnostic node `isolation` details may include
  `gitFootprint`; consumers should apply the same `gitFootprint` then
  `outputRef` fallback used by the visualizer when rendering commit and
  line-change summaries.
- `events`: array of newest-first event objects with at least `at`, `event`,
  `nodeId`, `timestamps`, and `details`; `status`, `session`, and `runId` are
  present when recorded on the history entry. `--node`, `--event`, and
  `--limit` filter the exported history without mutating graph state. The
  export is event-time only: it must not backfill current node fields such as
  `outputRef`, `gitFootprint`, `diffStat`, changed files, or current status
  onto older history entries.
- `claim`: object with at least `nodeId`, `runId`, `lease`, `releasedExpired`, and `summary`; `title` is present when known. `lease` has at least `session`, `runId`, `claimedAt`, and `expiresAt`.
- `start`: object with at least `nodeId`, `status`, and `summary`; `title` is present when known.
- `renew`: object with at least `nodeId`, `lease`, and `summary`. Renewed leases keep `session`, `runId`, `claimedAt`, `expiresAt`, and add or update `renewedAt`.
- `reset`: object with at least `nodeId`, `status`, `resetAncestors`, and `summary`.
- `reset-subtree` and `reset-reachable`: object with at least `nodeId`, `resetNodes`, and `summary`.
- `done`, `block`, and `fail`: object with at least `nodeId`, `status`, `summary`, and `slack`; `title` is present when known.
- `answer`: object with at least `nodeId`, `status`, `answer`, `summary`, and `slack`.
- `decompose`: object with at least `nodeId`, `children`, `summary`, and `slack`.
- `apply-preview`: object with at least `nodeId`, `children`, `summary`, and `slack`.
- `reject-preview`: object with at least `nodeId`, `status`, `childIds`, `summary`, and `slack`.
- `regenerate-preview`: object with at least `nodeId`, `status`, `childIds`, `summary`, and `slack`.
- `worker`: object with at least `session`, `idle`, and `results`. In `--once` idle mode the shape is `{ session, idle: true, results: [] }`. Finalized result entries include at least `nodeId`, `runId`, `status`, `summary`, `code`, and `slack`. If a Codex run changed the node state itself, a result may include `note` instead of `summary` and `slack`.
- `reconcile`: object with at least `changed` and `summary`.
- `release-expired`: object with at least `released` and `summary`.

`prompt` prints rendered prompt text, not JSON. `serve` prints a human-readable URL line and may print a security warning before the URL. `help` prints human-readable usage text. Error messages may become clearer, but successful command stdout should stay machine-readable where it is currently JSON.

`slack` is `{ "skipped": true, "reason": string }`, `{ "sent": true }`, or `{ "failed": true, "reason": string }`. Delivery failures are non-disruptive: if the graph mutation succeeded, the command still exits successfully and reports the notification failure in this field.

Slack notifications are an attention channel, not the audit record. Messages include compact operational pointers: event, node id/title, graph version, status counts, and report path when available. Report bodies, worker stdout/stderr, and operator-provided question, answer, and reason text remain in the graph file and reports by default.

Adding fields to JSON results is compatible. Removing, renaming, retyping, nesting, or changing the meaning of existing successful-output fields is breaking unless covered by the allowed-change list below and tests are updated.

Generated graph JSON follows the same compatibility rule as hand-authored
graphs after it is written. The stable contract is the graph file shape
(`graph.root`, `graph.nodes`, validation, traversal, and mutation semantics),
not a fixed planner topology or a fixed set of planner metadata fields.
Planner-created graphs may include additive `goal`, `planner`,
`plannerDecision`, `decompositionReason`, `contextRefs`, `outputContract`,
`resultSummary`, `workerPlanner`, `pendingPlannerPreview`, `document`, ref, and
`gitFootprint` metadata. Existing readers may ignore those fields. Consumers
must not require a `PLAN` node, a `ROOT -> PLAN` edge, or Git metadata to
replay a generated graph through `summary`, `ready`, `worker`, `serve`,
`diagnostics`, `render`, or recovery commands.

## Graph State Semantics

The existing graph file format must remain compatible:

- Top-level metadata such as `schemaVersion`, `graphVersion`, `title`, `description`, `statusModel`, `scheduler`, and `document` remains allowed.
- `graph.root` points at a node id in `graph.nodes`.
- `graph.nodes` is an object keyed by node id.
- Nodes may include `title`, `kind`, `status`, `children`, `description`, `deliverables`, `acceptanceCriteria`, lease fields, timestamps, `question`, `answer`, `report`, `history`, `pendingPlannerPreview`, Git provenance metadata, and additional metadata.
- Unknown top-level, graph-level, and node-level metadata should be preserved unless a mutation explicitly owns that field.
- Missing node `kind` defaults operationally to `task`; missing `status` defaults operationally to `pending`.
- Known node kinds are `task`, `series`, `parallel`, and `gate`; unknown kinds are tolerated as metadata, with traversal falling back to visiting children in order.
- Known statuses are `pending`, `claimed`, `running`, `blocked`, `review`, `failed`, and `done`; custom statuses may exist in legacy or future graphs and should not make graph loading fail by themselves.

Validation rejects malformed JSON, a missing or invalid `graph` object, a missing or invalid `graph.root`, a missing or invalid `graph.nodes` map, a root id absent from the nodes map, non-object nodes, non-array `children`, child ids absent from `graph.nodes`, duplicate child ids in one child list, child-reference cycles, empty `series` or `parallel` child lists, and malformed lease or timestamp fields. Validation also reports non-fatal warnings separately from errors for unreachable nodes, unknown custom statuses/kinds, and status/kind combinations that the scheduler can still load. Tightening validation for invalid or ambiguous graphs is allowed when the error clearly names the graph path and issue path.

### Graph Fixture Compatibility Matrix

The authoritative validator fixture matrix lives in
`tests/fixtures/graph-validator-outcomes.json` and
`tests/fixtures/graphs/`. Each graph fixture has an expected `errors` array and
`warnings` array so tests can prove that fatal rejection and compatibility
diagnostics stay separate.

Current matrix categories:

| Category | Fixture evidence | Required behavior |
| --- | --- | --- |
| Minimal | `valid-minimal.graph.json` | A graph with only `graph.root`, `graph.nodes`, and one node object loads without errors or warnings. Missing node `kind` and `status` keep their operational defaults. |
| Rich | `valid-basic.graph.json` | A graph using top-level metadata, scheduler config, renderer document content, series and parallel parents, gate nodes, leases, timestamps, and history loads without warnings. |
| Legacy-compatible | `valid-legacy-compatible-warning.graph.json` | Older or custom graph shapes that remain traversable load successfully, preserve unknown metadata, and emit warnings for compatibility risks. |
| Warning-only | `valid-warning-only.graph.json` | A graph with only tolerated compatibility issues has `errors: []`, non-empty `warnings`, and remains accepted by scheduler read paths. |
| Invalid | `invalid-*.graph.json` | Fatal validation issues have non-empty `errors`; scheduler and renderer commands reject before mutating graph files or writing renderer output. |

Accepted legacy-compatible shapes:

- Top-level metadata fields such as `schemaVersion`, `statusModel`, and custom
  metadata objects are allowed and preserved unless a mutation explicitly owns a
  field.
- Graph-level and node-level custom metadata fields are allowed and preserved.
- Missing node `kind` is accepted and defaults operationally to `task`.
- Missing node `status` is accepted and defaults operationally to `pending`.
- Unknown string node kinds are accepted with a warning; traversal still follows
  their `children` in order when children exist.
- Unknown string node statuses are accepted with a warning; they are not treated
  as terminal `done` statuses.
- `task` nodes with non-empty `children` are accepted with a warning and are
  traversed as ordered internal nodes.
- `gate` nodes with non-empty `children` are accepted with a warning and are
  traversed as ordered internal nodes.
- Lease metadata on statuses other than `claimed`, `running`, `blocked`, or
  `review` is accepted with a warning when the lease object itself is valid.
- Unreachable node objects are accepted with a warning so older plans can retain
  parked or historical work without blocking reads.

Intentional validation rejections:

- Malformed JSON.
- Top-level JSON values that are not objects.
- Missing or non-object `graph`.
- Missing, empty, or non-string `graph.root`.
- Missing or non-object `graph.nodes`.
- A root id that is absent from `graph.nodes`.
- Node map values that are not objects.
- `children` values that are not arrays.
- Child entries that are not strings.
- Child ids that are not present in `graph.nodes`.
- Duplicate child ids within one node's `children` array.
- Child-reference cycles, including cycles outside the root-reachable subgraph.
- `series` nodes without at least one valid child.
- `parallel` nodes without at least one valid child.
- Lease values that are not objects.
- Lease objects missing string `session` or `runId`.
- Lease objects missing valid timestamp strings for required `claimedAt` or
  `expiresAt`.
- Lease `renewedAt` values that are present but not valid timestamp strings.
- Node timestamp fields `startedAt`, `completedAt`, `blockedAt`, `answeredAt`,
  `failedAt`, or `expiredAt` that are present but not valid timestamp strings.
- `history` values that are not arrays.
- History entries that are not objects.
- History entries missing a valid timestamp string `at`.
- History `event` values that are present but not strings.

### Graph Field Addition Policy

Graph field additions must be additive first. New top-level, graph-level, or
node-level fields are compatible when old plans still load, existing mutation
ownership rules preserve unknown metadata, and old readers can ignore the new
field without changing readiness, mutation, renderer output location, report
location, or CLI JSON output semantics.

When adding a graph field:

- Document the field in README or owner docs if users can author or inspect it.
- Add TypeScript surface area only where code needs to read or write the field;
  otherwise keep it as preserved metadata.
- Add or update a fixture when the field changes validation behavior, migration
  expectations, renderer behavior, or mutation ownership.
- Prefer a warning-only phase for deprecated or risky legacy shapes before
  making them fatal.
- Keep fatal validation for shapes that are structurally ambiguous, unsafe for
  traversal, or impossible for scheduler and renderer commands to interpret
  consistently.
- Treat removal, renaming, retyping, or changed meaning of existing fields as a
  breaking change requiring operator approval.

Readiness semantics are public behavior:

- Only leaf nodes are claimable and directly mutable by normal worker commands.
- A `series` node exposes the first child whose subtree is not done.
- A `parallel` node exposes all ready leaves under unfinished child subtrees.
- For internal composition nodes, a subtree is not done for readiness until the
  parent node itself has reconciled to `done`; completed children alone do not
  make downstream series siblings ready.
- `done` is the only terminal status.
- `claimed`, `running`, `blocked`, `review`, and `failed` are busy statuses for ready-list purposes.
- Only expired `claimed` and `running` leases are auto-released.
- Internal series or parallel nodes become `done` when every child subtree is
  done and any required composition buffer has published the parent output ref.
- A series parent with child output refs aliases the final child `outputRef` as
  the parent output ref. If any done child needed for that alias lacks
  `outputRef.name`, reconciliation blocks the parent instead of making
  downstream work ready.
- A parallel parent with child output refs merges those refs in child-list order
  from the parent base ref. Clean merges publish a parent output ref; conflicts
  move the parent to `review`; setup failures or missing child output refs move
  it to `blocked`.

Mutation semantics are public behavior:

- Worker-owned leased node mutations require matching `--session` or `--run`.
- `answer` clears the lease and returns a blocked leaf to `pending` while preserving the operator question and answer.
- `reset` clears one leaf, removes its lease/report/timestamps/failure/blocking fields, and reopens completed ancestors.
- Reopening completed composition ancestors after `reset` clears the ancestor
  `outputRef` and `integrationRef` because those refs were derived from the
  reset child subtree.
- `reset-subtree` clears the selected node and child-reachable descendants
  without reopening parents above the selected node. When the selected node or a
  descendant is a composition parent, its derived `outputRef` and
  `integrationRef` are cleared.
- `reset-reachable` clears the selected node, descendants, and later
  execution-reachable series work. The selected subtree is always reset first.
  For each series ancestor on the selected node's path from `graph.root`, later
  siblings and their descendants are also reset. Parallel ancestors do not add
  sibling branches. Selecting the root resets every root-reachable node.
  Selecting a node that is not reachable from `graph.root` resets only that
  node's child-reachable subtree.
- `decompose` replaces a claimed, running, or blocked leaf with a `series` or `parallel` subtree and creates child nodes from `--child` or `--child-json`.
- Manual and API `decompose` child ids follow the graph validator contract:
  child `id` values and `children` references must be non-empty strings that
  name nodes present after the mutation. Existing graph-compatible custom ids
  such as ids with spaces, slashes, or colons remain accepted.
- `decompose --child ID=Title` and `--child ID:Title` create task/pending children.
- `decompose --child-json` accepts an array of objects with string `id` and `title`; optional `kind`, `status`, string-array `children`, and additional child metadata are preserved on created child nodes.
- If a blocked leaf has `pendingPlannerPreview`, `decompose` also verifies that
  the current `graphVersion`, blocked-node state, requested kind, and child
  definitions still match the stored preview. Stale approval previews are
  rejected and must be regenerated or reset before applying.
- `apply-preview` reads `pendingPlannerPreview.decompose` and invokes the same
  guarded decomposition mutation. It does not bypass lease ownership, graph
  version, node-state, or child-definition checks.
- `reject-preview` clears the stored preview and related blocked/lease fields
  without creating child nodes. It is valid only for blocked or pending leaf
  nodes that still carry `pendingPlannerPreview`.
- `regenerate-preview` runs the configured planner fixture for the latest node
  snapshot and stores a replacement `pendingPlannerPreview`. The target remains
  a blocked leaf until the operator applies, rejects, resets, or regenerates
  the preview again.
- The stricter safe-token id policy is planner-only. It applies to planner-provided
  ids and scheduler-generated planner child ids, not to manual/API child ids.
- Mutation ownership rules for preserving unknown metadata and documenting cleared fields are maintained in [Mutation Ownership](mutation-ownership.md).

Status transitions are defined by command. Worker-owned commands require matching `--session` or `--run` when a node has a lease; unleased legacy nodes in an otherwise allowed source status can still be mutated, except `renew`, which requires an existing lease. Operator and system commands do not require worker owner credentials.

| Command | Actor | Scope | Allowed source status | Result status | Lease behavior |
| --- | --- | --- | --- | --- | --- |
| `claim` | worker | ready leaf; releases expired `claimed`/`running` leases before selecting work | `pending` known status; custom non-busy, non-terminal leaf statuses remain ready-compatible | `claimed` | creates a new lease |
| `start` | worker | leaf | `claimed` | `running` | preserves lease; requires owner if leased |
| `renew` | worker | leased leaf | `claimed`, `running`, `blocked`, `review` | unchanged | requires existing lease and owner; updates expiry |
| `done` | worker | leaf | `claimed`, `running`, `blocked`, `review` | `done` | requires owner if leased; clears lease |
| `block` | worker | leaf | `claimed`, `running` | `blocked` | requires owner if leased; preserves lease |
| `answer` | operator | blocked leaf | `blocked` | `pending` | clears lease without owner credentials |
| `fail` | worker | leaf | `claimed`, `running`, `blocked`, `review` | `failed` | requires owner if leased; clears lease |
| `reset` | operator | leaf | any known status; custom statuses are also reset | `pending` | clears lease without owner credentials |
| `reset-subtree` | operator | selected node and child-reachable descendants | any known status; custom statuses are also reset | `pending` | clears leases in the reset set without owner credentials |
| `reset-reachable` | operator | selected node, descendants, and later execution-reachable series work | any known status; custom statuses are also reset | `pending` | clears leases in the reset set without owner credentials |
| `decompose` | worker | leaf | `claimed`, `running`, `blocked` | selected node returns to `pending` as a `series`/`parallel` parent | requires owner if leased; clears lease and creates children |
| `apply-preview` | operator | claimed, running, or blocked leaf with `pendingPlannerPreview` | `claimed`, `running`, `blocked` | selected node returns to `pending` as a `series`/`parallel` parent | delegates to `decompose`; requires matching owner if leased |
| `reject-preview` | operator | blocked or pending leaf with `pendingPlannerPreview` | `blocked`, `pending` | `pending` | clears lease and preview metadata without owner credentials |
| `regenerate-preview` | operator | claimed, running, or blocked leaf | `claimed`, `running`, `blocked` | `blocked` | requires matching owner if leased; stores fresh preview metadata without creating children |
| `reconcile` | system | non-leaf whose child subtrees are all `done`; composition buffers publish parent refs before downstream readiness | any non-`done` status except parked blocked/review/failed buffers until reset | `done`, `blocked`, or `review` | does not inspect leases |
| `release-expired` | system | nodes with expired leases | `claimed`, `running` | `pending` | clears only expired `claimed`/`running` leases |

Operational event names are a compatibility surface. Graph history mutation
events use `claimed`, `running`, `renewed`, `done`, `blocked`, `answered`,
`failed`, `reset`, `decomposed`, `expired`, `subtree-done`, and `child-reset`.
Git isolation graph history events use `clone-prepared`, `branch-created`,
`output-ref-recorded`, `merge-attempted`, `merge-conflicted`, and
`parent-ref-published`.
Planner preflight graph history events use `planner-failed`,
`planner-preview-applied`, `planner-preview-rejected`, and
`planner-preview-regenerated`.
Worker-manager events use `worker-started` and `worker-stopped`. Lock
diagnostic events reserve `lock-acquired`, `lock-released`,
`lock-stale-reaped`, and `lock-timeout`. Event names should not be renamed once
released; adding fields is compatible. Stable fields and redaction rules are
documented in [`operational-events.md`](operational-events.md).

Changes to readiness, status transitions, lease ownership, reset scope, or decomposition behavior require tests. If the changed behavior appears in README command examples or operating-model prose, update README too.

## Visualizer Contract

The current visualizer parity work is additive. It does not remove scheduler
commands, change CLI flags, alter successful CLI JSON stdout shapes, or change
the graph mutation semantics documented above. GUI and HTTP write paths invoke
the same scheduler mutation handlers and graph lock as the CLI; the graph file
remains the source of truth.

The local visualizer started by `serve` should keep these routes:

- `GET /` and `GET /index.html`: HTML application.
- `GET /api/graph`: visualizer payload JSON.
- `GET /api/workers`: worker-manager status JSON.
- `GET /api/summary`: same graph summary JSON shape as the CLI.
- `GET /api/ready`: same ready leaf JSON shape as the CLI.
- `GET /api/diagnostics`: same diagnostics JSON shape as the CLI.
- `GET /api/events`: same operational event export JSON shape as the CLI, with optional `limit`, `node`, and `event` query parameters.
- `GET /api/prompt`: rendered prompt preview as plain text, with required `node` and optional `session`, `run`, `template`, `cwd`, and `report` query parameters.
- `POST /api/workers/start`: starts managed workers and returns `{ started, workerManager }`.
- `POST /api/workers/stop`: stops one managed worker and returns `{ worker, workerManager }`.
- `POST /api/workers/stop-all`: stops managed workers and returns `{ stopped, workerManager }`.
- `POST /api/goal/plan`: previews or writes a goal-generated graph for the graph currently served by the visualizer and returns a plan result with `graphPath`, `mode`, `dryRun`, `written`, `rootId`, `nodeCount`, `validation`, `summary`, and `graph`.
- `POST /api/node/claim`, `/start`, `/renew`, `/reset`, `/reset-subtree`, and `/reset-reachable`: mutate nodes and return the same result shapes as the matching CLI commands.
- `POST /api/node/done`, `/block`, `/answer`, `/fail`, `/decompose`, `/apply-preview`, `/reject-preview`, and `/regenerate-preview`: mutate nodes and return scheduler mutation result shapes, including `slack`.
- `POST /api/graph/reconcile`: reconciles completed graph subtrees and returns the same result shape as the `reconcile` CLI command.
- `POST /api/leases/release-expired`: releases expired leases and returns the same result shape as the `release-expired` CLI command.
- `POST /api/answer`: legacy browser-flow alias for `POST /api/node/answer`.
- `GET /events`: server-sent events carrying visualizer payload JSON.

The `/api/graph` and `/events` payload should keep at least `graph`,
`graphSvg`, `nodes`, `nodeHistoryLimit`, `actionPolicy`, `attention`,
`diagnostics`, `gitFootprint`, `recentEvents`, `ready`, `working`, `summary`,
and `workerManager`. New top-level payload fields are additive; removing or
renaming these fields is a route compatibility change and requires tests.

`actionPolicy` and each node's `actions` array are additive visualizer metadata.
Older visualizer clients may ignore them. They describe UI availability and
confirmation hints only; server-side scheduler mutation guards remain
authoritative.

`nodes` is a normalized array for browser detail rendering without reparsing
the SVG. Each entry keeps at least `id`, `title`, `kind`, `status`,
`description`, `goal`, `goalText`, `planner`, `plannerDecision`,
`decompositionReason`, `pendingPlannerPreview`, `contextRefs`,
`outputContract`, `resultSummary`, `children`, `deliverables`,
`acceptanceCriteria`, `lease`, `refs`, `git`, `gitFootprint`,
`gitFootprintWarning`, `gitDiffStat`, `changedFiles`, `workspace`,
`workspaceDisplay`, `report`, `question`, `answer`, `answeredBy`,
`blockedReason`, `failureReason`, `timestamps`, `history`, `historyCount`, and
`historyLimit` when those values are known on the graph node. These normalized
planner and Git fields are display/provenance data; scheduler mutations still
read the graph node state and enforce the graph validator and mutation guards.
`refs` groups `baseRef`, `workRef`, `outputRef`, `integrationRef`, and
`gitFootprint`.
Visualizer consumers that render commit ids, branch names, refs, line-change
counts, or changed file rows should prefer the normalized `git` object. `git`
uses `insertions` consistently even when older graph metadata used `additions`,
sorts changed file rows deterministically, and caps the row payload with
`changedFilesLimit`, `changedFilesTotal`, and `changedFilesTruncated` so browser
renderers do not parse raw Git metadata or manage large lists themselves.
`workspaceDisplay` and `git.remoteDisplay`, `git.workspaceDisplay`, and
`git.bareRepoDisplay` are display-only redacted values. `timestamps` groups the
node lifecycle timestamps such as `startedAt`, `completedAt`, `blockedAt`,
`answeredAt`, `failedAt`, and `expiredAt`. The `history` array is the latest
`historyLimit` entries, not the full node history; `historyCount` reports the
full graph history length for that node. Detail fields are JSON data, not
pre-escaped HTML. Browser renderers must insert text with `textContent` or
equivalent escaping. Secret-shaped strings in detail payloads pass through the
operational redaction rules before being exposed.

Each node detail also includes `actions`, a server-computed prediction of
selected-node operations. Action entries keep `id`, `label`, `danger`,
`requiredFields`, optional `disabledReason`, and confirmation metadata for
danger-level destructive actions. When the visualizer request has no worker
`session` or `runId`, lease-protected worker actions for leased nodes are
disabled with a credential reason. The scheduler mutation guards remain
authoritative and may still reject an action whose availability was predicted
by the visualizer payload.

`workerManager` status keeps at least `defaults`, lifecycle counts, and
`workers`. `defaults` keeps `cwd`, `sessionPrefix`, `codexCommand`,
`isolation`, `workspaceRoot`, and `workspaceRetention`. Worker entries keep at
least `id`, `session`, `status`, `startedAt`, and `logTail`; `pid`, `cwd`,
`isolation`, `remote`, `workspaceRoot`, `workspaceRetention`, `finishedAt`,
`stoppingAt`, `durationMs`, `exitCode`, `signal`, `error`, and
`recentFailureReason` are present when known.

Visualizer request contracts:

- `POST /api/node/claim` and legacy alias `POST /api/claim` accept JSON with optional string `nodeId`, optional string `session`, optional numeric `leaseSeconds` or `lease`, and optional boolean `resolveBaseRef`.
- `POST /api/node/start` and legacy alias `POST /api/start` accept JSON with string `nodeId`, optional string `session`, and optional string `runId` or `run`.
- `POST /api/node/renew` and legacy alias `POST /api/renew` accept JSON with string `nodeId`, optional string `session`, optional string `runId` or `run`, and optional numeric `leaseSeconds` or `lease`.
- `POST /api/node/done` and legacy alias `POST /api/done` accept JSON with string `nodeId`, optional string `session`, optional string `runId` or `run`, optional string `report`, and optional `reportBody` or `report-body`. Report bodies are written through the scheduler report writer, constrained to the graph directory, before the node is completed.
- `POST /api/node/block` and legacy alias `POST /api/block` accept JSON with string `nodeId`, optional string `session`, optional string `runId` or `run`, optional string `question`, and optional string `reason`.
- `POST /api/node/answer` and its legacy alias `POST /api/answer` accept JSON with string `nodeId`, string `answer`, and optional string `responder`.
- `POST /api/node/fail` and legacy alias `POST /api/fail` accept JSON with string `nodeId`, optional string `session`, optional string `runId` or `run`, optional string `reason`, and optional string `report`.
- `POST /api/node/reset`, `/reset-subtree`, and `/reset-reachable` plus legacy aliases `POST /api/reset`, `/api/reset-subtree`, and `/api/reset-reachable` accept JSON with string `nodeId` and optional string `reason`.
- `POST /api/node/decompose` and legacy alias `POST /api/decompose` accept JSON with string `nodeId`, optional string `session`, optional string `runId` or `run`, optional string `kind`, and `children`, an array of child node objects with string `id` and `title`.
- `POST /api/node/apply-preview` and legacy alias `POST /api/apply-preview` accept JSON with string `nodeId`, optional string `session`, and optional string `runId` or `run`.
- `POST /api/node/reject-preview` and legacy alias `POST /api/reject-preview` accept JSON with string `nodeId`, optional string `reason`, and optional string `responder`.
- `POST /api/node/regenerate-preview` and legacy alias `POST /api/regenerate-preview` accept JSON with string `nodeId`, optional string `session`, optional string `runId` or `run`, optional string `requestId`, optional string `plannerFixturePath`, and optional string `report`.
- `POST /api/graph/reconcile` and `POST /api/leases/release-expired` do not require a body.
- `POST /api/goal/plan` accepts JSON with string `goal`, optional string `title`, optional boolean `dryRun` or `preview`, and optional string `plannerFixturePath`, `planner-fixture`, or `fixturePath`. Dry runs do not mutate the graph. Non-dry-run requests replace the graph currently served by the visualizer with a validated plan-only generated graph.
- `POST /api/workers/start` accepts JSON with optional `count`,
  `sessionPrefix`, `cwd`, `codexCommand`, `codexArgs`, `idleMs`, `timeoutMs`,
  `leaseSeconds`, `templatePath`, `nodeId`, `quiet`, `once`, `isolation`,
  `remote`, `workspaceRoot`, and `workspaceRetention`.
- `POST /api/workers/stop` accepts JSON with string `id`.
- `POST /api/workers/stop-all` does not require a body.
- `GET /api/events` applies the same `--limit` numeric bounds as the CLI.
- `GET /api/prompt` resolves `template` from the graph directory and defaults `cwd` to the graph directory, matching the CLI prompt command.
- `/events` emits server-sent events whose `data:` payload is the same minimum shape as `/api/graph`.

Visualizer response and error conventions:

- Successful read routes return direct JSON resources, not an envelope:
  `/api/graph` returns the visualizer payload and `/api/workers` returns
  worker-manager status.
- Successful mutation routes return the action result directly with any useful
  refreshed state beside it. Scheduler-backed mutations return raw scheduler
  results plus non-blocking Slack delivery status when applicable; worker
  manager actions return `{ started, workerManager }`, `{ worker,
  workerManager }`, or `{ stopped, workerManager }`.
- Slack notification results are never top-level route failures after a graph
  mutation succeeds. They remain embedded as `slack` with `sent`, `skipped`, or
  `failed` details so the UI can show the operation result and notification
  status separately.
- Expected request, validation, and lease/ownership failures return HTTP 400
  with `text/plain; charset=utf-8` and a single actionable message. Existing
  tests that assert plain-text validation errors should remain valid unless a
  route is intentionally migrated with tests.
- Write-token authorization failures return HTTP 403 with
  `text/plain; charset=utf-8`; clients should display the message as a global
  operator error because the request did not reach route validation.
- Unknown routes return HTTP 404 with plain text. Unexpected failures return
  HTTP 500 with plain text beginning `Unexpected visualizer error:` followed by
  the error message, not a stack trace.
- If a future visualizer route needs structured validation details, it may use a
  JSON error body with at least `{ "error": { "message": string, "field"?:
  string } }`; clients must still handle plain-text errors because 403 and
  existing validation routes depend on them.
- Client UI should show route-specific validation and mutation failures next to
  the related form when there is one, and show authorization, read, SSE, or
  unexpected failures as global operator errors. Clients must read JSON success
  bodies as data and convert non-2xx text or JSON error bodies to one display
  message without parsing stack traces.

Security assumptions are public:

- `serve` binds to `127.0.0.1` by default.
- Binding to `localhost`, `127.0.0.1`, `::1`, or `[::1]` is treated as local.
- Binding to any other host refuses startup unless `--visualizer-write-token` is provided or `--unsafe-visualizer-write` is explicitly set.
- Binding to any other host prints a warning because write routes can start and stop local worker processes, mutate graph nodes, and run graph-level recovery mutations.
- With `--visualizer-write-token`, all visualizer `POST` routes return HTTP 403 unless the request includes either `X-SPG-Visualizer-Token: TOKEN` or `Authorization: Bearer TOKEN`.
- Without `--visualizer-write-token`, loopback mode and explicit unsafe mode keep the existing unauthenticated trusted-client behavior.
- Visualizer HTML and client renderers must escape graph text, worker log text, and user-provided values before inserting them into the page.

Visualizer HTML, styling, layout, and client-side ergonomics may change as long as these routes, methods, request fields, response shapes, and security assumptions stay compatible. Endpoint changes require tests and README updates when operator usage changes.

Route and payload compatibility is covered by the Node visualizer suite and the
type contract. `tests/visualizer-renderer.test.mjs` exercises the read-only
parity routes, write-token protection, planner/Git payload rendering, action
metadata, `/api/goal/plan`, and generated graph replay through visualizer
routes. `tests/graph-contracts.typecheck.ts` keeps the public payload and
metadata interfaces type-checked.

## Worker Execution Contract

The worker command should continue to:

- Claim one ready leaf, start it, render a prompt, run Codex, write a report, and mark the node `done` or `failed`.
- Use `--session` or default `codex-worker`.
- Honor `--once`, `--quiet`, `--cwd`, `--node`, `--idle-ms`, `--lease`, `--template`, `--codex-command`, and repeated `--codex-arg`.
- Honor planner preflight flags `--planner-mode`, `--planner-adapter`,
  `--planner-fixture`, `--planner-template`, `--planner-failure-policy`,
  repeated `--planner-allowed-kind`, and `--planner-request-id-prefix`.
- Default Codex invocation to `codex exec "<rendered prompt>"`.
- Treat `--codex-arg` as a repeated value flag. If no custom `--codex-command` is supplied and the first codex arg starts with `-`, the worker prepends `exec` so model and sandbox flags still call `codex exec`.
- Validate the worker process boundary before claiming work: command, cwd, and argument values must be non-empty strings without null bytes; command and cwd values are capped at 4096 characters; Codex args are capped at 64 entries and 4096 characters per entry.
- Validate planner preflight configuration before claiming work. Enabling
  `auto-decompose` or `ask-approval` requires a usable adapter: `fixture` with a
  local fixture file, `prompt` through an injected prompt adapter or the
  configured Codex command, or an injected planner runtime supplied by API/test
  callers.
- Spawn worker and Codex subprocesses with argument arrays and no shell interpolation. User-controlled command strings, args, remotes, paths, and prompt text must never be concatenated into a shell command by the scheduler.
- Inherit the scheduler process environment for worker and Codex subprocesses. The scheduler is not an environment sandbox; operators should use OS accounts, containers, or wrapper commands to narrow environment access when needed.
- Renew its lease while Codex is running.
- Treat no ready work as `{ idle: true, results: [] }` in `--once` mode.
- Return worker results with `nodeId`, `runId`, `status`, `summary`, `code`, and `slack` when a node is finalized.
- Use the child process working directory from `--cwd`, or the graph directory by default.
- Stream child stdout/stderr to the worker process by default; `--quiet` suppresses live streaming while still capturing output in the report.
- Redact common secret shapes and configured secret-like environment values from generated worker reports, Worker Manager log tails, graph history details, and Slack notification text. Redaction is a sharing safeguard, not a substitute for keeping graph files, reports, logs, and Slack channels private.

The prompt template variables used by `prompts/codex-worker-task.md` are public for custom templates. Keep at least `cwd`, `graphPath`, `nodeId`, `runId`, `session`, `reportPath`, `schedulerCommand`, `planTitle`, `planDescription`, `nodeTitle`, `nodeKind`, `nodeStatus`, `nodeJson`, `readyJson`, and `summaryJson`.

Prompt variable semantics:

- `cwd` is the worker workspace.
- `graphPath` is the resolved graph file path.
- `nodeId`, `nodeTitle`, `nodeKind`, and `nodeStatus` describe the claimed node at prompt-render time.
- `runId` and `session` are the active lease identity when known, or the provided prompt-rendering values.
- `reportPath` is the report path the worker will write and pass back to `done` or `fail`.
- `schedulerCommand` is a runnable Node command for the active scheduler entry point.
- `planTitle` and `planDescription` come from the top-level graph metadata and render as empty strings when absent.
- `nodeJson`, `readyJson`, and `summaryJson` are pretty-printed JSON snapshots at prompt-render time.
- Unknown `{{variableName}}` placeholders are left visible in rendered prompts. This is the documented missing-variable policy for custom templates: typos remain auditable instead of silently producing empty text.

Changes to default worker invocation, prompt variables, report creation, lease heartbeat behavior, or `--once` idle behavior require tests. README examples must be updated if command lines or defaults change.

### Git-Only Worker Isolation Contract

Detailed remote resolution, validation, cache path, and failure behavior is
specified in [Worker Isolation Remote And Cache Design](worker-isolation-remote-cache.md).

Isolated worker operation is Git-only. It requires a concrete
`graph.scheduler.remote` value, referred to in operator-facing docs and errors
as `scheduler.remote`. The value is the remote URL used to seed and refresh the
local repository cache for isolated workers. Placeholder text, an omitted
remote, or a non-Git workspace path is invalid for isolated worker operation and
must fail before the scheduler claims or starts a node.

Non-Git isolation is intentionally unsupported. `--isolation off` is the legacy
shared-cwd mode, not an isolation mode, and `--cwd` must not be documented or
implemented as a substitute for Git-backed clones.

The worker subcommand owns repository preparation for isolated operation. An
operator should not have to pre-create the cache repository or clone workspaces:
before running the child command, the worker initializes or refreshes the local
bare repository from `scheduler.remote`, then creates a fresh local clone for
the claimed run.

Isolation paths are graph-directory relative unless configured otherwise by a
future documented option:

- Bare repository cache: `runs/git/cache/repo.git`.
- Per-run workspace root: `runs/workspaces`.
- Per-run workspace:
  `runs/workspaces/<safe-session>/<safe-node-id>/<safe-run-id>`.

Operator-facing examples must show how to set `scheduler.remote`, may show
`--remote` as a per-process override, and must state that cache and clone setup is
automatic once a concrete Git remote is available.

Each isolated worker run checks out a unique node branch and publishes the
resulting node output ref without pushing directly to the shared base branch:

```text
spg/node/<node-id>/<run-id>
```

Node ids and run ids used in filesystem paths are sanitized with the same safe
path-token policy used by report paths; the worker session is sanitized with
the same policy. Git ref names must be valid Git refs; implementations may
either reject unsafe node/run ids for isolated execution or map them to stable
safe ref tokens, but the mapping must be recorded in the worker report and
graph history.

The final per-run workspace directory is a reservation boundary. The worker
must create it with an atomic create operation after claim and before clone, and
must reject any pre-existing final directory unless an explicit retry or cleanup
mode owns its removal. This makes the workspace identity a function of session,
node id, and run id and prevents two concurrent workers from receiving the same
working directory.

Isolated operation records Git ref metadata directly on graph nodes. These
fields are optional so existing graphs continue to load and mutate safely:

```json
{
  "baseRef": {
    "name": "refs/remotes/origin/main",
    "commit": "0123456789abcdef0123456789abcdef01234567",
    "source": "graph-default",
    "resolvedAt": "2026-05-27T00:00:00.000Z"
  },
  "workRef": {
    "name": "refs/heads/spg/node/NODE/run_20260527_000000_NODE_abc123",
    "runId": "run_20260527_000000_NODE_abc123",
    "session": "codex-A",
    "createdAt": "2026-05-27T00:00:00.000Z"
  },
  "outputRef": {
    "name": "refs/heads/spg/node/NODE/run_20260527_000000_NODE_abc123",
    "commit": "fedcba9876543210fedcba9876543210fedcba98",
    "runId": "run_20260527_000000_NODE_abc123",
    "session": "codex-A",
    "report": "reports/NODE-run_20260527_000000_NODE_abc123.md",
    "producedAt": "2026-05-27T00:05:00.000Z"
  },
  "integrationRef": {
    "name": "refs/heads/spg/integration/PARENT/run_20260527_000000_PARENT_def456",
    "kind": "parallel",
    "status": "clean",
    "inputRefs": [
      {
        "nodeId": "LEFT",
        "outputRef": "refs/heads/spg/node/LEFT/run_20260527_000000_LEFT_111111"
      }
    ],
    "publishedOutputRef": "refs/heads/spg/integration/PARENT/run_20260527_000000_PARENT_def456"
  }
}
```

`baseRef.name`, `workRef.name`, `outputRef.name`, and `integrationRef.name`
are the exact refs consumers use with the local bare repository. Use fully
qualified refs where possible. If an implementation accepts a short branch name,
it must record the resolved fully qualified ref before running or publishing
work. `commit` records the resolved object id when known; downstream resolution
must use `name` and may use `commit` only as an integrity check.

`baseRef.source` explains why the input was selected. Initial implementations
should use one of `explicit`, `graph-default`, `parent-base`,
`series-predecessor`, or `parent-output`. Future source strings are allowed and
must be preserved by mutation commands.

Git footprint metadata is additive graph state for diagnostics and visualizer
consumers that need commit and line-change summaries without re-running Git for
every payload. The canonical node field for this display/provenance metadata is
`gitFootprint`. `outputRef.name` is the source of truth for published work and
completion readiness; `outputRef.commit` is an optional integrity/display
commit. Legacy `outputRef.diffStat`, `outputRef.files`, and
`outputRef.collectedAt` fields remain valid compatibility metadata, but new
mutation paths should write collected stats to `node.gitFootprint` instead of
requiring or mirroring them under `outputRef`. Readers must still fall back to
`outputRef.commit`, `outputRef.diffStat`, `outputRef.files`, and
`outputRef.collectedAt` when `gitFootprint` is absent. This lets older isolated
runs show a commit and line-change counts when only `outputRef` metadata exists.
`gitFootprintWarning` records a best-effort stats collection failure after the
ref was published; it must not make completion, reconcile, or reset flows fail,
and it should be cleared by reset or by a later successful collection.

Operational event exports do not synthesize this current node metadata onto
history entries. Event payloads may include `diffStat`, `gitFootprint`, or
warning fields only when the producer wrote those fields to that exact history
entry. Diagnostics and visualizer node details remain the current-state surfaces
for `node.gitFootprint` and legacy `outputRef` fallback display.

The stable `node.gitFootprint` shape is:

```json
{
  "gitFootprint": {
    "baseRef": {
      "name": "refs/remotes/origin/main",
      "commit": "0123456789abcdef0123456789abcdef01234567"
    },
    "headRef": {
      "name": "refs/heads/spg/node/NODE/run_20260527_000000_NODE_abc123",
      "commit": "fedcba9876543210fedcba9876543210fedcba98"
    },
    "branch": "spg/node/NODE/run_20260527_000000_NODE_abc123",
    "commit": "fedcba9876543210fedcba9876543210fedcba98",
    "diffStat": {
      "filesChanged": 2,
      "insertions": 42,
      "deletions": 7,
      "totalChanges": 49,
      "binaryFiles": 0
    },
    "files": [
      {
        "path": "scripts/contracts.ts",
        "oldPath": "scripts/types.ts",
        "changeType": "renamed",
        "insertions": 20,
        "deletions": 3,
        "totalChanges": 23,
        "binary": false
      }
    ],
    "collectedAt": "2026-05-27T00:05:01.000Z"
  }
}
```

Stable field meanings:

- `baseRef`: ref and commit used as the diff base. It normally matches
  `node.baseRef`, or the parent composition base for aggregate nodes.
- `headRef`: ref and commit used as the diff head. It normally matches
  `node.outputRef` for completed leaves or published parent refs.
- `branch`: display branch or short ref name for the head when available.
- `commit`: display head commit. It should match `headRef.commit` and
  `outputRef.commit` when those fields are present.
- `diffStat.filesChanged`, `diffStat.insertions`, `diffStat.deletions`, and
  `diffStat.totalChanges`: numeric summary fields for visualizer consumers.
  `totalChanges` is `insertions + deletions`. `binaryFiles` is optional and
  counts files whose line-level stats are unavailable. Legacy metadata may use
  `additions` instead of `insertions`; readers should treat it as the same
  line-increase count when `insertions` is absent.
- `files`: file-level stats sorted by path unless a producer documents another
  deterministic order. Stable field names are `path`, `oldPath`, `changeType`,
  `insertions`, `deletions`, `totalChanges`, and `binary`. Binary file line
  counts may be `null`; otherwise `totalChanges` is `insertions + deletions`.
  Legacy file metadata may use `additions` instead of `insertions`.
- `collectedAt`: timestamp for when Git metadata was collected. It may differ
  slightly from `outputRef.producedAt` because collection can happen after the
  output ref is recorded.

Aggregate footprint rules:

- Task leaves record the exact diff from their resolved `baseRef` commit/ref to
  their `outputRef` commit/ref. If no worktree changes were committed, the
  footprint can still record the commit with a zero-count `diffStat`.
- Series parents use the first child subtree's resolved base as `baseRef` and
  the final child subtree's published output as `headRef`, `branch`, and
  `commit`. When Git can compute the parent range, `diffStat` and `files` are
  the net diff from the series base to the final head. When only child
  footprints are available, an implementation may publish a summed summary but
  must preserve child footprints for audit; consumers must treat summed series
  file stats as display metadata rather than an exact per-file net diff.
- Parallel parents use the parent composition base as `baseRef` and the clean
  integration output as `headRef`, `branch`, and `commit`. `diffStat` and
  `files` describe the final integrated tree relative to the parent base, not
  each child branch independently. While a parallel parent is `blocked` or
  `review`, it may omit parent `gitFootprint` and rely on child footprints plus
  `integrationRef` conflict metadata.
- Gate parents do not create Git changes by themselves. A gate with one
  upstream output may alias that upstream footprint; a gate that only controls
  readiness may omit `gitFootprint`. If a future gate performs a concrete Git
  validation or publication step, its footprint follows the same base/head rules
  as a task leaf.
- Resetting or rerunning a node invalidates its `gitFootprint` and any aggregate
  parent footprints derived from it in the same way it invalidates derived
  `outputRef` and `integrationRef` metadata.
- Graph-level git summaries keep all node footprints in their audit `nodes`
  list, but `diffStat` and `changedFiles` aggregate only the highest available
  measurable footprint in each subtree. A measurable parent footprint, whether
  a real merge diff or an explicit child aggregate, counts instead of its
  descendants. A parent that only has a commit or output ref without stats does
  not mask child stats. This keeps diagnostics and visualizer totals from
  counting both parent aggregates and child source footprints.

Task base refs are resolved at claim/start time in this order:

- An explicit node `baseRef.name`, when already present, wins and is re-resolved
  against the local bare repository before checkout.
- The root task or the first child subtree of the root starts from
  `scheduler.baseRef` when present; otherwise it starts from the fetched remote
  default branch. The resolved ref is recorded as `baseRef` with source
  `graph-default`.
- In a `series` parent, a child after the first starts from the previous sibling
  subtree's `outputRef.name`. Missing predecessor `outputRef.name` is a hard
  readiness error for isolated operation, even if the predecessor status is
  `done`.
- The first child of any `series` parent starts from the parent task base ref.
  If the `series` parent itself has a series predecessor, this means the first
  child starts from that predecessor's output.
- Children of a `parallel` parent all start from the same parent task base ref
  unless a child has an explicit `baseRef.name` override.
- A task after a completed composition parent starts from the composition
  parent's `outputRef.name`, which is produced from `integrationRef` for
  `parallel` parents or from the final child output for `series` parents.

Worker reports must include the node id, run id, report path, redacted remote,
bare repository path, clone cwd, `baseRef.name`, `workRef.name`,
`outputRef.name`, integration result when applicable, and resolved commits when
known. When collected, reports should also include the same `diffStat` and
file-level `files` summary recorded in `gitFootprint`. This links a worker run
to the clone and branch it used, records the
branch it produced, and gives downstream workers the exact ref to clone from.
The raw remote string is allowed only for Git subprocesses; reports, graph
history, diagnostics, visualizer payloads, and logs must use the redacted
display form.

Isolation graph history records these lifecycle events in addition to the
existing status events:

- `clone-prepared`: emitted after the bare repository is ready and the per-run
  clone exists. Stable fields are `session`, `runId`, redacted `remote`,
  `bareRepo`, `cloneCwd`, and `baseRef`.
- `branch-created`: emitted after the worker branch is created or checked out.
  Stable fields are `session`, `runId`, `cloneCwd`, `baseRef`, and `workRef`.
- `output-ref-recorded`: emitted after the worker output ref is written to graph
  metadata. Stable fields are `session`, `runId`, `workRef`, `outputRef`,
  `commit`, and `report`.
- `merge-attempted`: emitted for each parallel child merge attempt. Stable
  fields are `parentId`, `integrationRef`, `baseRef`, `childId`,
  `childOutputRef`, and `childOrderIndex`.
- `merge-conflicted`: emitted when a merge cannot complete cleanly. Stable
  fields are `parentId`, `integrationRef`, `baseRef`, `childId`,
  `childOutputRef`, `childOrderIndex`, `conflictedPaths`, and `result`.
- `parent-ref-published`: emitted when a series alias or clean parallel
  integration result becomes the parent output ref. Stable fields are
  `parentId`, `kind`, `integrationRef`, `outputRef`, `commit`, and `result`.

Composition nodes produce parent output refs through buffer operations instead
of allowing children to update a shared base branch directly:

- A `series` parent passes each child output ref as the next child's input ref.
  When the final child subtree is done, the parent output ref aliases the final
  child output ref. The first implementation should prefer alias metadata over
  renaming child refs so completed child reports remain stable.
- A `parallel` parent treats its resolved composition base as a merge buffer
  base. Children do not see each other's working branches while running; after
  all children are done, the scheduler integrates their output refs into a
  parent-owned integration ref in graph `children` order.

These parent buffers are part of the public contract because downstream isolated
workers consume parent `outputRef.name` rather than inferring Git ancestry or
choosing a branch by convention.

Series parent buffer operation is a public isolation contract:

- The first child subtree of a series parent starts from the series parent's
  resolved composition base. Each later child subtree starts from the immediately
  previous sibling subtree's `outputRef.name`. For a nested composition child,
  use that composition child's parent output ref, not the internal leaf refs.
- Missing, malformed, or ambiguous predecessor `outputRef.name` is a hard
  isolated-readiness error for the next series child. A done predecessor without
  an output ref does not unlock downstream isolated work because the downstream
  base would be unknowable.
- A series parent does not create a merge branch by default. After every child
  subtree is `done`, the scheduler publishes the parent's `outputRef` as a
  metadata alias of the final child subtree's `outputRef`: `outputRef.name` and
  the resolved commit match the final child output exactly, while parent metadata
  records the parent id, final child id, aliased child ref, and publish time.
- Downstream nodes read the series parent's `outputRef.name`, even when that
  name is identical to the final child ref. This keeps the dependency edge
  unambiguous at the graph level while avoiding a redundant Git ref.
- The final child node keeps its original `workRef`, `outputRef`, report path,
  and history. Publishing a series parent alias must not rewrite child refs,
  child reports, or earlier history entries; provenance is preserved by linking
  the parent alias metadata back to the final child.
- Implementations may later add an optional parent-specific branch, tag,
  symbolic ref, or copied ref such as `spg/series/<parent-node-id>/<attempt-id>`.
  That option is compatible only when the graph still preserves the original
  final child `outputRef`, records the rename or copy as alias metadata, and does
  not require old reports to be regenerated or existing child refs to change.
- Re-running or retrying a series alias publication is idempotent when the final
  child output ref and commit are unchanged. If a reset or retry changes the
  final child output, the parent alias may move to the new final output only as
  part of the documented reset/reconcile flow, with prior alias metadata kept in
  history for auditability.

Parallel parent buffer operation is a public isolation contract:

- Parallel children must never merge or push directly into the shared base
  branch. Each child produces its own output ref from the same composition base,
  unless explicit graph metadata overrides that child's input ref.
- After every child subtree is `done` and every child has a recorded output ref,
  the scheduler creates a dedicated parent integration ref by branching from the
  parallel parent's composition base. The integration ref must be distinct from
  the base branch and child output refs. The canonical ref shape for the first
  implementation is
  `refs/heads/spg/integration/<parent-node-id>/<attempt-id>`, and the exact ref
  must be recorded in graph metadata, history, and the buffer report.
- The composition base is the input ref resolved for the parallel parent:
  upstream series predecessor output ref when present, otherwise the enclosing
  parent composition input ref, otherwise the configured graph default/base ref.
  Missing or ambiguous base metadata blocks the buffer before any merge starts.
- Child output refs are merged into the parent integration ref in exactly the
  order listed in the parent node's `children` array. Nested child compositions
  contribute their own parent output ref, not the refs of their internal leaves.
  Reordering by completion time, claim time, lexical node id, or Git ancestry is
  not allowed.
- Each merge attempt records the parent id, integration ref, base ref, child id,
  child output ref, and child order index in graph history and the buffer
  report. A clean final merge publishes that integration ref, or an alias of it,
  as the parallel parent's output ref for downstream work.
- A missing child output ref, failed merge command, or Git conflict leaves the
  parent unresolved and must not mark the parent `done`. The parent enters
  `blocked` when operator input is needed or `review` when a prepared conflict
  workspace is ready to inspect. The actionable details must include the parent
  id, base ref, integration ref or workspace path, child id and output ref that
  failed, merge order index, conflicted paths when Git reports them, and the
  retry/reset command path.
- A blocked merge report must identify the conflicting child refs explicitly:
  include the parent id, redacted remote, bare repository path, integration
  workspace or clone cwd, base ref, integration ref, attempted child order,
  every child output ref considered by the buffer, the child id and output ref
  that conflicted, conflicted paths when available, and the resulting status
  (`blocked`, `review`, or `failed`).
- Retrying a blocked or review parent buffer starts from the same composition
  base and the same child order. A resolved retry may publish a new parent
  output ref, but it must preserve the previous failed attempt metadata for
  auditability.

Existing shared-cwd worker behavior remains available for compatibility when
the worker is not running in isolated mode. Shared-cwd workers continue to use
`--cwd` or the graph directory as described above. They are outside the
Git-only isolation feature, do not satisfy isolated-worker guarantees, and must
not be treated as a non-Git isolation fallback.

### Migration Impact

Existing graphs do not need a migration to keep using the scheduler in
shared-cwd mode. When workers run with the default `--isolation off`, the
presence or absence of `scheduler.remote`, `baseRef`, `workRef`, `outputRef`,
`integrationRef`, or `gitFootprint` must not change claim, prompt, worker cwd,
report, reset, or manual status-command behavior.

Graphs opt in to isolated workers by adding a concrete Git remote under
`scheduler.remote`, then starting workers with `--isolation git`:

```json
{
  "scheduler": {
    "remote": "git@github.com:example/repo.git"
  }
}
```

`scheduler.baseRef` may also be set when the graph should start from a specific
remote branch or ref; otherwise isolated workers use the fetched remote default
branch. Operators should validate the edited graph with `summary`, then run an
isolated worker. They do not add node ref metadata by hand for new work: the
worker and reconciliation paths create `baseRef`, `workRef`, `outputRef`, and
`integrationRef` as isolated runs complete.

`--remote` is a migration and canary aid. It lets one worker process test
isolated operation against a remote without mutating the graph file. Once a
worker pool should consistently use isolation, store the same remote in
`scheduler.remote` so every isolated worker resolves the same repository.

An isolated worker must fail before claim when neither `--remote` nor a
concrete `scheduler.remote` is available, or when the graph still contains
placeholder text. The stable missing-remote prefix is listed below. This is an
intentional compatibility boundary: non-isolated commands keep working, while
isolated commands never silently fall back to shared cwd.

Mixed-mode migration needs an execution boundary. A task completed by a
shared-cwd worker usually has no `outputRef`; a downstream isolated task or
composition parent that needs that predecessor output must block instead of
guessing a Git ref. To migrate in-progress graphs, either continue the affected
subtree in shared-cwd mode, reset the smallest affected downstream scope and
rerun it with isolated workers, or manually add ref metadata only when the
operator can prove the exact Git ref and commit that represent the completed
work.

Composition buffers are native scheduler behavior for isolated execution and
therefore a public contract, not an implementation detail. Their main migration
risks are:

- Legacy completed predecessors may lack `outputRef.name`, which blocks
  downstream isolated readiness.
- Parallel output depends on the parent `children` order; changing child order
  changes the deterministic merge result.
- Merge conflicts leave parent nodes in `blocked` or `review` with retained
  buffer state, so operators must use the documented reset, reconcile, or
  conflict-recovery path instead of marking the parent done by hand.
- Resetting or rerunning a child invalidates derived parent `outputRef` and
  `integrationRef` metadata for ancestor composition nodes.

These risks are managed by requiring explicit refs in graph metadata, recording
buffer attempts in reports and history, and treating missing or conflicting
buffer inputs as blocked/review states rather than as successful readiness.

#### Isolated Worker Operator Controls

The CLI and visualizer Worker Manager expose the same core isolation options.
The CLI contract is:

- `--isolation off|git`: selects worker workspace mode. The default is `off`,
  preserving the existing shared-cwd worker behavior. `git` enables Git-backed
  isolation and makes the worker prepare the bare repository cache and per-run
  clone before the child command starts.
- `--remote URL`: supplies the Git remote for `--isolation git`. This overrides
  `graph.scheduler.remote` for the current worker process only. If omitted, the
  worker reads `graph.scheduler.remote`.
- `--workspace-root PATH`: sets the parent directory for isolated per-run
  clones. The default is `runs/workspaces`, resolved relative to the graph
  directory. The first implementation keeps this path inside the graph
  directory and rejects paths that resolve to the graph file, repository root,
  `.git`, or the bare repository cache.
- `--workspace-retention on-failure|always|never`: controls clone cleanup after
  a worker run finalizes. The default is `on-failure`, which deletes successful
  clones and keeps failed, timed-out, blocked, review, and conflicted
  workspaces for inspection. `always` keeps every clone. `never` removes clones
  after finalization when removal is possible; reports and output refs remain
  the durable audit trail.

These isolation flags are additive. Existing worker flags remain part of the
public contract and keep their current defaults: `--session`, `--node`,
`--once`, `--quiet`, `--cwd`, `--template`, `--idle-ms`, `--timeout-ms`,
`--lease`, `--codex-command`, repeated `--codex-arg`, `--planner-mode`,
`--planner-adapter`, `--planner-fixture`, `--planner-template`,
`--planner-failure-policy`, repeated `--planner-allowed-kind`, and
`--planner-request-id-prefix`. In `--isolation off`, `--cwd` continues to set
the child process working directory. In
`--isolation git`, the child process working directory is the generated clone;
`--cwd` must not be accepted as a second workspace selector. If an operator
passes both `--cwd` and `--isolation git`, fail before claim/start with:

```text
Cannot combine --cwd with --isolation git; use --workspace-root to choose isolated clone placement.
```

The visualizer Worker Manager should add fields matching the CLI names and
defaults:

- `Isolation`: segmented control or select with `off` and `git`, default `off`.
- `Remote`: text input sent as `remote`; required only when `Isolation` is
  `git` and `graph.scheduler.remote` is missing or placeholder text.
- `Workspace Root`: text input sent as `workspaceRoot`; default
  `runs/workspaces`; enabled only for `git`.
- `Retention`: select sent as `workspaceRetention` with `on-failure`, `always`,
  and `never`; default `on-failure`; enabled only for `git`.

The existing Worker Manager fields stay documented and visible: worker count,
session prefix, repository/shared cwd, command, idle interval, args, `Quiet`,
and `Once`. When `Isolation` is `git`, the repository/shared-cwd field should
be clearly treated as shared-mode only or disabled, because the child command
will run in the generated clone. Managed workers must pass the selected
isolation values to the same worker runtime used by direct CLI workers, using
spawn argument arrays rather than shell interpolation.

Validation for isolated workers must complete before the worker claims a node,
starts a node, creates a clone, or runs the child command. The minimum
validation rules are:

- `--isolation` accepts only `off` or `git`.
- `--workspace-retention` accepts only `on-failure`, `always`, or `never`.
- `--remote` and `graph.scheduler.remote` must be non-empty concrete Git remote
  values. Placeholder strings such as `REQUIRED: ...`, `TODO`, `FIXME`, and
  `replace-me` are invalid.
- The resolved remote used in reports, diagnostics, visualizer payloads, and
  worker logs must be redacted before display when it contains credentials.
- Workspace-root validation must reject empty paths, traversal outside the
  allowed base, and paths that overlap the graph file, repository root, `.git`,
  or bare repository cache.

Operator-facing failures should use these stable message prefixes so tests and
runbooks can key on them:

```text
Worker isolation requires scheduler.remote; set graph.scheduler.remote or pass --remote <url> with --isolation git.
Worker isolation remote fetch failed for <redacted-remote>: <cause>
Worker isolation clone failed for <clone-path> from <bare-repo-path>: <cause>
Worker isolation integration workspace is dirty for <node-id> at <workspace-path>; clean or inspect the workspace before retrying.
```

Fetch and clone failures happen after validation but still before the child
command can modify files. Dirty integration-workspace failures must abort
before merge or conflict-resolution logic overwrites local changes; the
retained workspace path and relevant refs should appear in the report or graph
history without exposing remote credentials.

Isolated recovery and cleanup procedures are documented in
[`runbook.md`](runbook.md). Those procedures rely on stable report and graph
metadata for clone cwd, bare repository path, base ref, work ref, output ref,
integration ref, and merge-conflict details. Implementations must keep enough
metadata for operators to inspect, quarantine, reset, and retry a failed
isolated run without deriving paths from memory or deleting active worker
state.

Security notes for remote URL redaction, credential handling, local clone data,
and report disclosure are documented in [`security.md`](security.md). Changes
that add new report fields, graph history fields, visualizer payloads, or worker
logs containing remote or clone information must preserve those disclosure
rules.

Graphs without `baseRef`, `workRef`, `outputRef`, or `integrationRef` remain
valid legacy graphs. Read-only commands, shared-cwd workers, and existing status
mutation commands must not require or synthesize these fields. Isolated-worker
commands may add or update only the ref fields they own, and reset or
decomposition commands must preserve unrelated node metadata unless their
documented transition explicitly clears stale isolation refs.

## Reports

Report paths are graph-directory relative unless an absolute path inside the graph directory is supplied. Paths that escape the graph directory should continue to be rejected.

Default worker reports go to:

```text
reports/<safe-node-id>-<safe-run-id>.md
```

Report files are Markdown, newline-terminated, and currently include:

- `# <nodeId>: <title>`
- node id
- run id
- command
- args
- cwd
- exit code
- signal
- start and finish timestamps
- duration
- final graph status when available
- optional stdout, stderr, and error sections

Isolated worker reports add an auditable isolation block. Completed task reports
must identify the clone and branch used with these fields:

- `Remote`: the redacted display remote only.
- `Bare repository`: local bare repository cache path.
- `Clone cwd`: per-run clone path used as the child process cwd.
- `Base ref`: resolved base ref name and commit when known.
- `Work ref`: per-run branch name and commit when known.
- `Output ref`: published output ref name and commit when known.
- `Integration result`: `not-applicable` for ordinary task workers, or the
  final buffer result for composition work.

Composition buffer reports use the same isolation fields and add merge
provenance. A blocked merge report must list the ordered child refs that were
considered, the child ref that failed, the integration ref or workspace left for
inspection, conflicted paths when Git reports them, and the resulting status.
No report field may contain an unredacted credential-bearing remote URL.

Manual `done --report --report-body` writes the provided report body before marking the node done. If `--report` or `--report-body` is omitted, no manual report file is created by that command.

Generated worker reports keep dynamic inline values on one Markdown line and wrap stdout, stderr, and errors in fenced `text` code blocks. Fence length expands when captured output itself contains backticks, so process output cannot close the report fence and forge headings or lists. The exact prose inside generated reports may improve, but the path safety behavior, default location, Markdown format, Markdown-safe dynamic body formatting, newline termination, and graph node `report` field should remain compatible. Changing report paths or node report metadata requires README updates and tests.

## Renderer Output Locations

The renderer should keep these inputs and output resolution rules:

- Input graph: `--graph`, first positional argument, `PLAN_GRAPH`, then default `plan.graph.json`.
- Output HTML: `--output`, `--out`, second positional argument, `graph.scheduler.htmlView`, then default `plan.html`.
- Relative graph paths resolve from the package root.
- Relative output paths resolve from the input graph directory.
- Absolute output paths are used as supplied.
- Graphs without `document` content currently fail rendering before any output write.

Renderer HTML is a generated artifact and may be regenerated from graph content. Renderer HTML structure and styles may change. Output path resolution, CLI entry points, atomic output replacement behavior, escaping of document text, safe handling of links, and the presence of a planar graph SVG are public behavior and require tests when changed. README examples must be updated if renderer invocation or default output locations change.

## Generated Artifacts

Generated artifacts are not source contracts, but their locations and safety properties are public:

- `dist/` is generated by `npm run build`; do not require users to edit it directly.
- `dist/prompts/` is copied from `prompts/` during build.
- `plan.html` or `graph.scheduler.htmlView` is regenerated after graph mutations when the graph has `document` content.
- Graph writes are JSON with two-space indentation and a trailing newline.
- Graph updates are protected by a filesystem lock next to the graph and written through a temporary file plus rename.
- Lock metadata may include process id, creation time, graph path, and host for diagnostics.

## Change Policy

Compatibility changes are classified before implementation:

- Breaking changes require explicit operator approval, a new compatibility
  version, a migration note in this document, README updates when operator
  behavior changes, and test updates in the same change set. The migration note
  must name the previous behavior, the new behavior, affected commands or JSON
  fields, and the operator action needed to migrate existing graphs, scripts, or
  reports.
- Additive changes do not require a new compatibility version when they preserve
  all documented valid workflows. Examples include new optional JSON fields, new
  optional CLI flags, new npm scripts, new graph metadata, new visualizer
  payload fields, new warning diagnostics, and stronger tests for existing
  behavior. Additive changes still need owner-doc updates when users can observe
  or depend on the new surface.
- Warning-only changes are compatible when they do not change exit status,
  successful stdout shape, graph mutation results, report path semantics,
  renderer output location, or worker/visualizer side effects. Warnings may be
  added to stderr, diagnostics, visualizer status text, or documentation to
  steer users away from deprecated or risky behavior. A warning-only change must
  describe the future risk and include tests when code emits the warning.

Deprecation is warning-only until behavior changes. Removing a deprecated
surface, changing its successful result shape, or making a formerly valid input
fail is breaking unless the input was already invalid under this document.

## Allowed Behavior Changes

These changes are allowed during hardening without being treated as compatibility breaks:

- Clearer validation errors for invalid input.
- Earlier rejection of invalid graph topology, duplicate node ids, invalid child definitions, malformed JSON bodies, or path escapes.
- More precise non-zero exit behavior for failed CLI commands.
- Additional JSON fields in successful outputs.
- Additional history entries or timestamp fields on graph nodes.
- Preserving more existing metadata during mutations.
- Safer visualizer request size limits, escaping, and error handling.
- Internal refactors, TypeScript type tightening, and test-only helper changes.

When in doubt, preserve valid existing workflows and only make invalid inputs fail sooner or with a clearer message.

## Breaking Changes Requiring Operator Approval

No breaking changes are pre-approved.

These changes require explicit operator approval before implementation:

- Removing or renaming a stable CLI command, npm script, package binary, flag, or environment variable.
- Changing successful JSON output from a documented command by removing, renaming, retyping, nesting, or changing the meaning of existing fields.
- Changing readiness traversal, terminal/busy status semantics, lease ownership checks, lease expiry behavior, or automatic internal-node reconciliation.
- Changing graph mutation semantics for `answer`, `reset`, `reset-subtree`, `reset-reachable`, `decompose`, `apply-preview`, `reject-preview`, or `regenerate-preview`.
- Changing default report location, report path confinement, graph node `report` semantics, or worker-generated Markdown report guarantees.
- Changing worker default invocation, prompt variable names or meanings, report path passed into prompts, lease heartbeat behavior, or `--once` idle shape.
- Removing visualizer routes, changing request fields or response envelopes, weakening local-only security warnings, or presenting the worker manager as safe for untrusted public access without an authentication design.
- Changing renderer input/output resolution, requiring direct edits to `dist/`, or removing the generated planar graph SVG from rendered HTML.

Operator-approved breaking changes must update this document, README examples, and tests in the same change set.
