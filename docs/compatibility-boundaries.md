# Compatibility Boundaries

This note defines public behavior that should remain compatible while validation, locking, visualizer, worker, and TypeScript hardening work proceeds. The scheduler graph format is still plain JSON; this note is not a new schema version.

## Stable CLI Surface

Keep these entry points working:

- npm scripts: `ready`, `summary`, `serve`, `worker`, `render`, `smoke:migration`, `typecheck`, `build`, and `test`.
- package binaries: `spg-scheduler` and `spg-render-plan`.
- compatibility wrappers: `node scripts/plan-scheduler.mjs ...` and `node scripts/render-plan.mjs ...`.
- built commands: `node dist/scripts/plan-scheduler.js ...` and `node dist/scripts/render-plan.js ...`.

Keep these scheduler command names compatible:

- `ready`
- `summary`
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
- `prompt`
- `worker`
- `reconcile`
- `release-expired`
- `serve`
- `help`

Stable flags include `--graph`, `--node`, `--session`, `--run`, `--lease`, `--reason`, `--report`, `--report-body`, `--question`, `--answer`, `--responder`, `--kind`, `--child`, `--child-json`, `--template`, `--cwd`, `--once`, `--quiet`, `--idle-ms`, `--codex-command`, `--codex-arg`, `--port`, and `--host`.

Changes that rename commands, remove flags, change flag meanings, or move examples from source wrappers to `dist/` only require README updates and test updates.

## JSON Output Shapes

Commands that currently print JSON should continue to print a single JSON value to stdout:

- `ready`: array of ready leaf nodes with at least `id`, `title`, `kind`, `status`, and optional `question`, `answer`, `answeredAt`.
- `summary`: object with at least `graphVersion`, `title`, `description`, `totalNodes`, `root`, and `counts`.
- `claim`: object with at least `nodeId`, `title`, `runId`, `lease`, `releasedExpired`, and `summary`.
- `start`, `done`, `block`, and `fail`: object with at least `nodeId`, `status`, `title`, and `summary`. `done`, `block`, and `fail` also include `slack`.
- `answer`: object with at least `nodeId`, `status`, `answer`, `summary`, and `slack`.
- `renew`: object with at least `nodeId`, `lease`, and `summary`.
- `reset`: object with at least `nodeId`, `status`, `resetAncestors`, and `summary`.
- `reset-subtree` and `reset-reachable`: object with at least `nodeId`, `resetNodes`, and `summary`.
- `decompose`: object with at least `nodeId`, `children`, `summary`, and `slack`.
- `worker`: object with at least `session`, `idle`, and `results`.
- `reconcile`: object with at least `changed` and `summary`.
- `release-expired`: object with at least `released` and `summary`.

`prompt` prints rendered prompt text, not JSON. `serve` prints a human-readable URL line. Error messages may become clearer, but successful command stdout should stay machine-readable where it is currently JSON.

Adding fields to JSON results is compatible. Removing, renaming, retyping, or nesting existing fields requires tests to be updated and README examples to be reviewed.

## Graph State Semantics

The existing graph file format must remain compatible:

- Top-level metadata such as `schemaVersion`, `graphVersion`, `title`, `description`, `statusModel`, `scheduler`, and `document` remains allowed.
- `graph.root` points at a node id in `graph.nodes`.
- `graph.nodes` is an object keyed by node id.
- Nodes may include `title`, `kind`, `status`, `children`, `description`, `deliverables`, `acceptanceCriteria`, lease fields, timestamps, `question`, `answer`, `report`, `history`, and additional metadata.
- Unknown top-level, graph-level, and node-level metadata should be preserved unless a mutation explicitly owns that field.
- Missing node `kind` defaults operationally to `task`; missing `status` defaults operationally to `pending`.
- Known node kinds are `task`, `series`, `parallel`, and `gate`; unknown kinds are tolerated as metadata, with traversal falling back to visiting children in order.
- Known statuses are `pending`, `claimed`, `running`, `blocked`, `review`, `failed`, and `done`; custom statuses may exist in legacy or future graphs and should not make graph loading fail by themselves.

Readiness semantics are public behavior:

- Only leaf nodes are claimable and directly mutable by normal worker commands.
- A `series` node exposes the first child whose subtree is not done.
- A `parallel` node exposes all ready leaves under unfinished child subtrees.
- `done` is the only terminal status.
- `claimed`, `running`, `blocked`, `review`, and `failed` are busy statuses for ready-list purposes.
- Only expired `claimed` and `running` leases are auto-released.
- Internal series or parallel nodes become `done` when every child subtree is done.

Mutation semantics are public behavior:

- Leased node mutations require matching `--session` or `--run`.
- `answer` clears the lease and returns a blocked leaf to `pending` while preserving the operator question and answer.
- `reset` clears one leaf and reopens completed ancestors.
- `reset-subtree` clears the selected node and child-reachable descendants without reopening parents above the selected node.
- `reset-reachable` clears the selected node, descendants, and later execution-reachable series work.
- `decompose` replaces a claimed or running leaf with a `series` or `parallel` subtree and creates child nodes from `--child` or `--child-json`.

Changes to readiness, status transitions, lease ownership, reset scope, or decomposition behavior require tests. If the changed behavior appears in README command examples or operating-model prose, update README too.

## Visualizer Contract

The local visualizer started by `serve` should keep these routes:

- `GET /` and `GET /index.html`: HTML application.
- `GET /api/graph`: JSON payload.
- `GET /api/workers`: worker-manager status JSON.
- `POST /api/workers/start`: starts managed workers and returns `{ started, workerManager }`.
- `POST /api/workers/stop`: stops one managed worker and returns `{ worker, workerManager }`.
- `POST /api/workers/stop-all`: stops managed workers and returns `{ stopped, workerManager }`.
- `POST /api/answer`: answers a blocked node and returns the same answer result shape as the CLI, including `slack`.
- `GET /events`: server-sent events carrying visualizer payload JSON.

The `/api/graph` and `/events` payload should keep at least `graph`, `graphSvg`, `ready`, `working`, `summary`, and `workerManager`.

Visualizer HTML, styling, layout, and client-side ergonomics may change as long as these routes, methods, request fields, and response shapes stay compatible. Endpoint changes require tests and README updates when operator usage changes.

## Worker Execution Contract

The worker command should continue to:

- Claim one ready leaf, start it, render a prompt, run Codex, write a report, and mark the node `done` or `failed`.
- Use `--session` or default `codex-worker`.
- Honor `--once`, `--quiet`, `--cwd`, `--node`, `--idle-ms`, `--lease`, `--template`, `--codex-command`, and repeated `--codex-arg`.
- Default Codex invocation to `codex exec "<rendered prompt>"`.
- Renew its lease while Codex is running.
- Treat no ready work as `{ idle: true, results: [] }` in `--once` mode.
- Return worker results with `nodeId`, `runId`, `status`, `summary`, `code`, and `slack` when a node is finalized.

The prompt template variables used by `prompts/codex-worker-task.md` are public for custom templates. Keep at least `cwd`, `graphPath`, `nodeId`, `runId`, `session`, `reportPath`, `schedulerCommand`, `planTitle`, `planDescription`, `nodeTitle`, `nodeKind`, `nodeStatus`, `nodeJson`, `readyJson`, and `summaryJson`.

Changes to default worker invocation, prompt variables, report creation, lease heartbeat behavior, or `--once` idle behavior require tests. README examples must be updated if command lines or defaults change.

## Reports

Report paths are graph-directory relative unless an absolute path inside the graph directory is supplied. Paths that escape the graph directory should continue to be rejected.

Default worker reports go to:

```text
reports/<safe-node-id>-<safe-run-id>.md
```

Report files are Markdown, newline-terminated, and currently include:

- `# <nodeId>: <title>`
- run id
- exit code
- start and finish timestamps
- optional stdout, stderr, and error sections

The exact prose inside generated reports may improve, but the path safety behavior, default location, Markdown format, and graph node `report` field should remain compatible. Changing report paths or node report metadata requires README updates and tests.

## Renderer Output Locations

The renderer should keep these inputs and output resolution rules:

- Input graph: `--graph`, first positional argument, `PLAN_GRAPH`, then default `plan.graph.json`.
- Output HTML: `--output`, `--out`, second positional argument, `graph.scheduler.htmlView`, then default `plan.html`.
- Relative output paths resolve from the input graph directory.
- Graphs without `document` content currently fail rendering.

Renderer HTML structure and styles may change. Output path resolution, CLI entry points, and the presence of a planar graph SVG are public behavior and require tests when changed. README examples must be updated if renderer invocation or default output locations change.

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
