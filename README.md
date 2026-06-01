# Series-Parallel Graph Scheduler

A local, filesystem-backed scheduler for coordinating many Codex sessions,
scripts, or human operators against one JSON series-parallel work graph.

The scheduler is built for trusted operator-supervised work. It claims only
ready leaf tasks, records leases and status transitions in the graph file,
keeps work inspectable as plain JSON, can spawn background Codex workers, and
can serve a local browser visualizer.

Public behavior is documented in
[`docs/compatibility-boundaries.md`](docs/compatibility-boundaries.md). Security
assumptions are documented in [`docs/security.md`](docs/security.md). Test and
release gates are documented in [`docs/testing.md`](docs/testing.md), with the
release hygiene bar in [`docs/quality-bar.md`](docs/quality-bar.md). Release
notes are recorded in [`CHANGELOG.md`](CHANGELOG.md). Graph authoring guidance
for humans and agents is in
[`docs/graph-authoring.md`](docs/graph-authoring.md). Maintainer module
boundaries and extension points are mapped in
[`docs/architecture.md`](docs/architecture.md). Operational recovery steps are
in [`docs/runbook.md`](docs/runbook.md). Goal-driven planner response contracts
are documented in
[`docs/planner-output-schema.md`](docs/planner-output-schema.md), with
planning approval and failure boundaries in
[`docs/planning-safety-and-approval.md`](docs/planning-safety-and-approval.md)
and acceptance workflows in
[`docs/goal-driven-acceptance-contract.md`](docs/goal-driven-acceptance-contract.md).
Dynamic predecessor, sibling, and report-summary context rules are in
[`docs/dynamic-context-flow.md`](docs/dynamic-context-flow.md).
Visualizer GUI documentation and direction are in
[`docs/visualizer-gui.md`](docs/visualizer-gui.md).

## Quickstart

Use Node.js `20.x`, `22.x`, or `24.x`. The repository sets
`engine-strict=true`, so `npm ci` fails during dependency installation on
unsupported Node versions instead of allowing later runtime surprises.

Install dependencies and build the TypeScript entry points:

```bash
npm install
npm run build
```

This repository currently checks in named graph files:

- `examples/goal-git-footprint.graph.json`: a small metadata-rich graph showing
  goal, planner, and Git footprint fields.
- `plan-example.graph.json`: a completed demo graph with renderer document
  content.
- `plan-scheduler-priority.graph.json`: the active priority-selection graph for
  this repository.

The scheduler and renderer default to `plan.graph.json` when no graph is
selected. That default filename is part of the compatibility contract, but this
checkout does not include that file. Use `--graph`, set `PLAN_GRAPH`, or create
your operating graph at `plan.graph.json`.

There are two supported starts. The static graph path keeps the historical
workflow: author or copy a graph JSON file, validate it, then claim or run ready
leaves. The goal-first path starts with `plan --goal`, writes a normal graph
artifact, then uses the same validation, worker, renderer, and visualizer
commands against that artifact.

Static graph path:

Read the active graph without mutating it:

```bash
npm run summary -- --graph ./plan-scheduler-priority.graph.json
npm run ready -- --graph ./plan-scheduler-priority.graph.json
node scripts/plan-scheduler.mjs diagnostics --graph ./plan-scheduler-priority.graph.json
```

Then run workers or use the visualizer against that same graph path when the
ready list and diagnostics look correct.

Goal-first path, review before execution:

```bash
node scripts/plan-scheduler.mjs plan --goal "Ship a searchable audit log" --graph /tmp/spg-audit-log/plan.graph.json --plan-only
node scripts/plan-scheduler.mjs summary --graph /tmp/spg-audit-log/plan.graph.json
node scripts/plan-scheduler.mjs ready --graph /tmp/spg-audit-log/plan.graph.json
npm run worker -- --graph /tmp/spg-audit-log/plan.graph.json --session codex-A --once --cwd "$PWD"
```

Goal-first path, write the graph and run one worker immediately:

```bash
node scripts/plan-scheduler.mjs plan --goal "Ship a searchable audit log" --graph /tmp/spg-audit-log/plan.graph.json --then-run --session codex-A --once --cwd "$PWD"
```

`--plan-only` is the safer default for operator review. `--then-run` is an
explicit convenience mode: it writes and reloads the generated graph first, then
invokes the existing worker runtime.

Render the demo graph to an HTML file:

```bash
npm run render -- --graph ./plan-example.graph.json --out /tmp/spg-plan-example.html
```

Open the local visualizer workbench for the active graph:

```bash
npm run serve -- --graph ./plan-scheduler-priority.graph.json --cwd "$PWD" --port 8787
```

Then open:

```text
http://127.0.0.1:8787
```

`serve` runs until stopped with `Ctrl-C`.

The workbench shows graph shape, ready leaves, active workers, diagnostics,
recent events, goal/planner metadata, and Git footprint summaries. It can also
preview `plan --goal` output through `POST /api/goal/plan` with `dryRun: true`,
or save a validated plan-only graph for the graph currently being served.

Validate the decomposed goal and Git metadata example:

```bash
npm run summary -- --graph ./examples/goal-git-footprint.graph.json
```

## Operating Model

A plan graph has one root and a node map:

- `series` nodes expose the first child subtree that is not done.
- `parallel` nodes expose ready leaves from every unfinished child subtree.
- Leaf `task` nodes are the normal claimable units of work.
- `gate` and unknown node kinds are tolerated as metadata-bearing nodes; graph
  traversal visits each child in listed order when present.

Only leaf nodes are claimed, started, blocked, completed, failed, reset, or
decomposed by normal worker commands. Internal series and parallel nodes become
`done` when all child subtrees are done; `reconcile` applies that rule to an
existing graph.

Claims are leases. `claim` releases expired `claimed` and `running` leases
before choosing work. Active workers renew their own lease while Codex runs, so
a long task is not mistaken for a dead worker.

When several ready leaves are available, automatic `claim` chooses among only
those ready candidates with a deterministic priority tuple:
`depth`, `child_count`, `shared_parent_count_with_current_task`. The scheduler
orders by lower `depth`, then higher `child_count`, then lower
`shared_parent_count_with_current_task`; exact ties use a stable raw node-id
tie-breaker. For example, if `DOCS_QUICK` is ready at depth 2 and
`API_DETAIL` is ready at depth 4, an automatic claim selects `DOCS_QUICK` even
when `API_DETAIL` appears earlier in a traversal or graph file. The deeper node
can still be claimed later when it remains ready.

Read-only ready surfaces use the same default priority order with no current
task context: `ready` stdout, `diagnostics.nextReady`, worker prompt
`readyJson`, and the visualizer ready list all expose the sorted ready list.
Those ReadyNode objects include `depth`, `child_count`, and
`shared_parent_count_with_current_task` as additive metadata. Existing
consumers that only read `id`, `title`, `kind`, and `status` can keep ignoring
the priority fields.

Explicit node claims remain available for operator-directed work:
`claim --node API_DETAIL` bypasses automatic priority ordering, but it does not
bypass readiness. The named node must already be a ready leaf.

Mutating commands write the graph through a filesystem lock and atomic rename,
then regenerate the configured HTML view when the graph contains document
content. Slack is only an attention channel: if `SLACK_WEBHOOK_URL` is set,
`done`, `block`, `answer`, `fail`, `decompose`, `apply-preview`, and
`reject-preview` send compact status notifications. Chat messages include the
event, node id/title, graph version, status counts, and report path when
available; detailed worker output, report
bodies, and operator-provided question/answer/reason text stay in the graph and
reports. Slack delivery is bounded by `SPG_SLACK_TIMEOUT_MS` and reported in
command JSON, but it does not roll back or fail a successful graph mutation.
The graph file remains the source of truth.

## Graph Selection

Use `--graph` for one command:

```bash
npm run ready -- --graph ./plan-scheduler-priority.graph.json
node scripts/plan-scheduler.mjs summary --graph ./plan-scheduler-priority.graph.json
```

Or set the default for a shell:

```bash
export PLAN_GRAPH="$PWD/plan-scheduler-priority.graph.json"
npm run ready
npm run summary
```

If neither `--graph` nor `PLAN_GRAPH` is set, scheduler commands resolve
`plan.graph.json` from the package root. Renderer commands use `--graph`, then a
positional graph path, then `PLAN_GRAPH`, then `plan.graph.json`.

## Goal-Driven Planning

Use `plan --goal` when the graph should be generated from an operator goal
instead of hand-authored first. The `plan` command creates a graph artifact; the
existing scheduler, worker, renderer, and visualizer commands then operate on
that graph path.

Goal planning has two layers:

- `plan --goal` creates or previews an execution graph from an original goal.
- Worker planner preflight can recursively divide an already-ready leaf while
  workers are running, using the normal guarded `decompose` mutation.

Both layers preserve static graph compatibility. Once a graph JSON file exists,
it is just an input graph for `summary`, `ready`, `worker`, `serve`, `render`,
and recovery commands.

CLI review workflow:

```bash
node scripts/plan-scheduler.mjs plan --goal "Ship a searchable audit log" --graph /tmp/spg-audit-log/plan.graph.json --plan-only
node scripts/plan-scheduler.mjs summary --graph /tmp/spg-audit-log/plan.graph.json
node scripts/plan-scheduler.mjs ready --graph /tmp/spg-audit-log/plan.graph.json
npm run worker -- --graph /tmp/spg-audit-log/plan.graph.json --session codex-A --once --cwd "$PWD"
```

GUI review workflow:

```bash
node scripts/plan-scheduler.mjs plan --goal "Ship a searchable audit log" --graph /tmp/spg-audit-log/plan.graph.json --plan-only
npm run serve -- --graph /tmp/spg-audit-log/plan.graph.json --cwd "$PWD" --port 8787
```

Then open `http://127.0.0.1:8787` and review the generated goal, planner
metadata, ready work, diagnostics, and Git footprint summaries before starting
or stopping workers from the visualizer.

For immediate execution, make the opt-in explicit:

```bash
node scripts/plan-scheduler.mjs plan --goal "Ship a searchable audit log" --graph /tmp/spg-audit-log/plan.graph.json --then-run --session codex-A --once --cwd "$PWD"
```

For recursive worker decomposition, enable planner preflight on workers. In
`auto-decompose`, a worker claims and starts a ready leaf, asks the configured
planner boundary whether the leaf is atomic, and either runs Codex for `task`
decisions or applies a valid `series`/`parallel` decomposition for composite
decisions. The parent is not executed in that pass; later worker claims pick up
the generated child leaves. This command shape uses a local fixture planner for
deterministic demos:

```bash
npm run worker -- --graph /tmp/spg-audit-log/plan.graph.json --session codex-A --cwd "$PWD" --planner-mode auto-decompose --planner-adapter fixture --planner-fixture planner-fixture.json
```

Use `--planner-mode ask-approval` when each proposed decomposition should block
with a preview report for an operator to approve or reject. `fixture` reads
local JSON only, while `prompt` requires an injected prompt adapter boundary;
the scheduler core does not include an external model provider integration.

The meaning of `plan.graph.json` depends on the command mode. For `plan
--goal`, `--graph PATH` names the output graph to create. If `--graph` is
omitted, the generated artifact is written under
`runs/goals/<timestamp>-<safe-goal-slug>/plan.graph.json`. For every existing
command such as `summary`, `worker`, `serve`, `render`, `claim`, or `done`,
`--graph PATH` selects an input graph. Resume generated work by reusing the
written graph path; rerunning `plan --goal` creates a new planning artifact.

## Command Entry Points

Prefer npm scripts for ordinary operation during development:

```bash
npm run ready -- --graph ./plan-scheduler-priority.graph.json
npm run summary -- --graph ./plan-scheduler-priority.graph.json
npm run render -- --graph ./plan-example.graph.json
npm run serve -- --graph ./plan-scheduler-priority.graph.json
```

Those scripts rebuild first and then invoke `dist/scripts/*.js`.

Use direct compatibility wrappers when you need commands without an npm script,
or when preserving the historical command shape matters:

```bash
npm run build
node scripts/plan-scheduler.mjs claim --graph ./plan-scheduler-priority.graph.json --session codex-A
node scripts/plan-scheduler.mjs prompt --graph ./plan-example.graph.json --node ROOT --session codex-A
node scripts/render-plan.mjs --graph ./plan-example.graph.json --out /tmp/spg-plan-example.html
```

The wrappers import built files from `dist/`, so run `npm run build` after
changing TypeScript source. Package binaries `spg-scheduler` and
`spg-render-plan` point at the same built files after package installation.
The mutating `claim` example above is a command shape for an operating graph;
use the disposable demo below for a copy/paste mutation flow.

Use the CLI when you need scriptable JSON output, shell pipelines, CI checks, or
copy/pasteable incident commands. Use the visualizer when you need a live local
operator console for graph shape, ready/active work, diagnostics, recent events,
worker logs, and guarded write controls. Both paths call the same scheduler
mutation code and preserve the graph file as the source of truth.

## Disposable Demo

Use a temporary graph when trying mutating commands:

```bash
cat > /tmp/spg-demo.graph.json <<'JSON'
{
  "title": "Demo Plan",
  "description": "A one-task scheduler demo.",
  "graph": {
    "root": "ROOT",
    "nodes": {
      "ROOT": {
        "title": "Run the demo",
        "kind": "series",
        "status": "pending",
        "children": ["A"]
      },
      "A": {
        "title": "Complete one task",
        "kind": "task",
        "status": "pending"
      }
    }
  }
}
JSON
```

Claim, start, complete, and inspect the demo task:

```bash
node scripts/plan-scheduler.mjs claim --graph /tmp/spg-demo.graph.json --session codex-A
node scripts/plan-scheduler.mjs start --graph /tmp/spg-demo.graph.json --node A --session codex-A
SLACK_WEBHOOK_URL= node scripts/plan-scheduler.mjs done --graph /tmp/spg-demo.graph.json --node A --session codex-A --report reports/A.md --report-body "Demo task complete."
npm run summary -- --graph /tmp/spg-demo.graph.json
```

The report path is relative to the graph directory. For the example above, the
report is written under `/tmp/reports/`.

## Scheduler Commands

The disposable demo sequence above is the copy/paste flow. The command lists in
this section are state-dependent command shapes; mutating lines require the node
to be in one of that command's allowed source statuses.

Read-only commands:

```bash
node scripts/plan-scheduler.mjs ready --graph /tmp/spg-demo.graph.json
node scripts/plan-scheduler.mjs summary --graph /tmp/spg-demo.graph.json
node scripts/plan-scheduler.mjs diagnostics --graph /tmp/spg-demo.graph.json
node scripts/plan-scheduler.mjs events --graph /tmp/spg-demo.graph.json --limit 20
node scripts/plan-scheduler.mjs prompt --graph /tmp/spg-demo.graph.json --node A --session codex-A
```

Worker-owned leaf commands:

```bash
node scripts/plan-scheduler.mjs claim --graph /tmp/spg-demo.graph.json --session codex-A
node scripts/plan-scheduler.mjs start --graph /tmp/spg-demo.graph.json --node A --session codex-A
node scripts/plan-scheduler.mjs renew --graph /tmp/spg-demo.graph.json --node A --session codex-A --lease 1800
node scripts/plan-scheduler.mjs done --graph /tmp/spg-demo.graph.json --node A --session codex-A --report reports/A.md
node scripts/plan-scheduler.mjs block --graph /tmp/spg-demo.graph.json --node A --session codex-A --question "Need operator decision"
node scripts/plan-scheduler.mjs fail --graph /tmp/spg-demo.graph.json --node A --session codex-A --reason "Runner failed"
node scripts/plan-scheduler.mjs decompose --graph /tmp/spg-demo.graph.json --node A --session codex-A --kind series --child A1="Draft" --child A2="Verify"
```

Operator and recovery commands:

```bash
node scripts/plan-scheduler.mjs answer --graph /tmp/spg-demo.graph.json --node A --answer "Proceed." --responder jason
node scripts/plan-scheduler.mjs reset --graph /tmp/spg-demo.graph.json --node A --reason "retry"
node scripts/plan-scheduler.mjs reset-subtree --graph /tmp/spg-demo.graph.json --node ROOT --reason "rerun all"
node scripts/plan-scheduler.mjs reset-reachable --graph /tmp/spg-demo.graph.json --node A --reason "rerun downstream"
node scripts/plan-scheduler.mjs reconcile --graph /tmp/spg-demo.graph.json
node scripts/plan-scheduler.mjs release-expired --graph /tmp/spg-demo.graph.json
```

Commands that mutate a leased node require the matching `--session` or `--run`.
`answer`, `reset`, `reset-subtree`, `reset-reachable`, `reconcile`, and
`release-expired` are operator or system commands and do not require lease-owner
credentials.

## Incident Triage

Use `diagnostics` when a graph looks idle, wedged, or unsafe to mutate. It is
read-only JSON, so it can be piped to `jq` or captured in incident notes:

```bash
node scripts/plan-scheduler.mjs diagnostics --graph ./plan-scheduler-priority.graph.json
node scripts/plan-scheduler.mjs diagnostics --graph ./plan-scheduler-priority.graph.json | jq '.actions'
node scripts/plan-scheduler.mjs diagnostics --graph ./plan-scheduler-priority.graph.json | jq '{ready: .nextReady[].id, blocked: [.blocked[].id], failed: [.failed[].id], expired: [.leases.expired[].id]}'
node scripts/plan-scheduler.mjs events --graph ./plan-scheduler-priority.graph.json --limit 20
```

The diagnostic payload contains the normal `summary`, `nextReady`, active and
expired lease lists, blocked/review nodes, failed nodes, graph lock state, and a
short `actions` array. Common recovery flow:

```bash
node scripts/plan-scheduler.mjs diagnostics --graph ./plan-scheduler-priority.graph.json
node scripts/plan-scheduler.mjs release-expired --graph ./plan-scheduler-priority.graph.json
node scripts/plan-scheduler.mjs answer --graph ./plan-scheduler-priority.graph.json --node NODE --answer "Proceed." --responder operator
node scripts/plan-scheduler.mjs reset --graph ./plan-scheduler-priority.graph.json --node NODE --reason "retry after triage"
```

If `.lock.exists` is true, inspect `.lock.owner` before manual cleanup. A stale
lock should only be removed after confirming the owner process is gone; otherwise
wait for the scheduler, renderer, or worker that owns the lock.

Use `events` when diagnostics shows a stuck node and you need the recent audit
trail without parsing each node's `history` array by hand:

```bash
node scripts/plan-scheduler.mjs events --graph ./plan-scheduler-priority.graph.json --node NODE --limit 10
node scripts/plan-scheduler.mjs events --graph ./plan-scheduler-priority.graph.json --event blocked | jq '.[] | {at, nodeId, status, session, runId, details}'
```

Each event record has stable `at`, `event`, `nodeId`, `status`, `session`,
`runId`, `timestamps`, and redacted `details` fields. Check the newest event for
the stuck node first, then use the matching recovery command from
`diagnostics.actions`: `release-expired` for expired leases, `answer` for
blocked questions, or `reset`/`reset-reachable` for failed work that should be
retried.

## Operational Events

Graph history uses stable event names so operators can reconstruct lifecycle
order from a node history or the flattened `events` export. New mutation entries use `claimed`, `running`,
`renewed`, `done`, `blocked`, `answered`, `failed`, `reset`, `decomposed`,
`expired`, `subtree-done`, and `child-reset`. `reset` entries include
`resetScope` to distinguish single-node, subtree, and reachable resets.
Git isolation also reserves `clone-prepared`, `branch-created`,
`output-ref-recorded`, `merge-attempted`, `merge-conflicted`, and
`parent-ref-published` for ref and merge audit trails.
Planner preflight reserves `planner-failed`, `planner-preview-applied`,
`planner-preview-rejected`, and `planner-preview-regenerated` for failed
planner output and approval-gated decomposition preview lifecycle events.

The visualizer worker manager uses `worker-started` and `worker-stopped` in
worker log tails. Lock diagnostics reserve `lock-acquired`, `lock-released`,
`lock-stale-reaped`, and `lock-timeout`.

See [`docs/operational-events.md`](docs/operational-events.md) for the event
taxonomy, stable fields, and redaction rules for secret-shaped values.

## Graph Validation

Every scheduler and renderer load parses JSON first, then validates the graph
before traversal or mutation. Fatal validation errors name the graph path and a
JSON-style issue path such as `$.graph.root` or
`$.graph.nodes.ROOT.children[0]`.

Before running workers on a hand-edited graph, use a read-only load command:

```bash
npm run summary -- --graph ./plan-scheduler-priority.graph.json
```

Swap in the path to the graph you edited.

Validation rejects:

- A graph file that is not a JSON object.
- Missing or invalid `graph`, `graph.root`, or `graph.nodes`.
- A root id that is not present in `graph.nodes`.
- Node values that are not objects.
- `children` values that are not arrays of strings.
- Child ids missing from `graph.nodes`.
- Duplicate child ids in one child list.
- Child-reference cycles.
- Empty `series` or `parallel` nodes.
- Malformed lease, history, or timestamp fields.

Validation also produces non-fatal warnings for tolerated compatibility cases,
including unreachable nodes, unknown custom statuses or kinds, and lease/status
combinations the scheduler can still load.

See [`docs/graph-authoring.md`](docs/graph-authoring.md) for valid `series`,
`parallel`, `gate`, and `task` node guidance, a nested series-parallel example,
blocked and answered metadata, extensible metadata rules, and common invalid
graph mistakes with corrected versions.

For editor integration, point JSON tooling at
[`schemas/plan-graph.schema.json`](schemas/plan-graph.schema.json). Regenerate
it after graph contract or validator changes with:

```bash
npm run schema:graph
```

Useful fixtures live under `tests/fixtures/graphs/`:

```bash
npm run summary -- --graph tests/fixtures/graphs/valid-basic.graph.json
npm run summary -- --graph tests/fixtures/graphs/invalid-missing-root.graph.json
```

The second command is expected to fail; it is useful when checking diagnostics.

## Visualizer Usage And Safety

The visualizer is a trusted local operator tool. It can show the rendered graph,
summary counts, ready leaves, active and attention-needed nodes, blocked
questions, report paths, diagnostics, recent operational events, worker process
ids, goal and planner metadata, Git isolation refs, Git footprint summaries, and
recent worker output. Its Worker Manager can start and stop local scheduler
worker processes, and its write routes expose the same node and recovery
mutations as the CLI.

Default loopback mode:

```bash
npm run serve -- --graph ./plan-scheduler-priority.graph.json --cwd "$PWD" --port 8787
```

The default host is `127.0.0.1`. Binding to a non-loopback host refuses to start
unless write routes are protected with a token or unsafe mode is explicitly
enabled.

Common local workflow:

1. Start the console with `npm run serve -- --graph ./plan-improve.graph.json --cwd "$PWD" --port 8787`.
2. Open `http://127.0.0.1:8787`.
3. Use the graph filters and search box to narrow by ready work, active work,
   attention items, ids, titles, statuses, sessions, paths, or log text.
4. Check Diagnostics and Recent Events before recovery actions.
5. Answer blocked nodes from the Active Sessions answer form, or start/stop
   workers from Worker Manager when the graph is ready for automated work.

Token-protected non-loopback mode, for cases where another trusted machine must
reach the console:

```bash
npm run serve -- --graph ./plan-scheduler-priority.graph.json --host 0.0.0.0 --port 8787 --visualizer-write-token "replace-with-a-token"
```

Read-only graph and worker state are still visible to clients that can reach the
server. The token gates write routes only; it is not a login system. For browser
write controls, put the token in the URL fragment:

```text
http://HOST:8787/#write-token=TOKEN
```

The browser stores that fragment token locally and sends it as
`X-SPG-Visualizer-Token` on write requests. The fragment itself is not sent in
HTTP requests.

Node action examples through the visualizer API:

```bash
curl -sS -X POST http://127.0.0.1:8787/api/node/claim \
  -H "content-type: application/json" \
  -d '{"nodeId":"NODE","session":"operator"}'

curl -sS -X POST http://127.0.0.1:8787/api/node/reset \
  -H "content-type: application/json" \
  -d '{"nodeId":"NODE","reason":"retry after review"}'
```

When the server was started with `--visualizer-write-token`, include the token
header on write requests:

```bash
curl -sS -X POST http://HOST:8787/api/node/answer \
  -H "content-type: application/json" \
  -H "X-SPG-Visualizer-Token: TOKEN" \
  -d '{"nodeId":"NODE","answer":"Proceed.","responder":"operator"}'
```

The node routes are `claim`, `start`, `renew`, `done`, `block`, `answer`,
`fail`, `reset`, `reset-subtree`, `reset-reachable`, `decompose`,
`apply-preview`, and `reject-preview`. Leased worker-style actions still
require the matching `session` or `runId`, just like the CLI. Graph-level
recovery routes are `/api/graph/reconcile` and
`/api/leases/release-expired`. Goal planning uses `POST /api/goal/plan`; with
`dryRun: true` it previews the generated graph, and without dry run it replaces
the graph currently served by the visualizer with the validated plan-only graph.

Explicit unsafe mode is only for a trusted network boundary where every
reachable client may start and stop workers, mutate graph nodes, and run graph
level recovery mutations. It requires the explicit
`--unsafe-visualizer-write` flag and prints a warning that unauthenticated
write controls are exposed:

```bash
npm run serve -- --graph ./plan-scheduler-priority.graph.json --host 0.0.0.0 --port 8787 --unsafe-visualizer-write
```

See [`docs/security.md`](docs/security.md) before exposing the visualizer beyond
loopback. See [`docs/visualizer-gui.md`](docs/visualizer-gui.md) for the
operator-console documentation and design direction.

## Worker Usage

The worker command claims a ready leaf, starts it, renders a prompt from
`prompts/codex-worker-task.md`, runs a child command, writes a report, and marks
the node `done` or `failed`.

Run one real Codex worker and exit. This requires the Codex CLI and a ready
node:

```bash
npm run worker -- --graph ./plan-scheduler-priority.graph.json --session codex-A --once --cwd "$PWD"
```

By default the child command is:

```bash
codex exec "<rendered prompt>"
```

Run a harmless worker against the disposable demo graph:

```bash
node scripts/plan-scheduler.mjs reset --graph /tmp/spg-demo.graph.json --node A --reason "worker demo"
SLACK_WEBHOOK_URL= npm run worker -- --graph /tmp/spg-demo.graph.json --session codex-A --once --quiet --codex-command node --codex-arg=-e --codex-arg="process.exit(0)"
```

Run several background workers. This also requires the Codex CLI and ready work:

```bash
mkdir -p runs/logs
npm run worker -- --graph ./plan-scheduler-priority.graph.json --session codex-A --cwd "$PWD" > runs/logs/codex-A.log 2>&1 &
npm run worker -- --graph ./plan-scheduler-priority.graph.json --session codex-B --cwd "$PWD" > runs/logs/codex-B.log 2>&1 &
npm run worker -- --graph ./plan-scheduler-priority.graph.json --session codex-C --cwd "$PWD" > runs/logs/codex-C.log 2>&1 &
```

### Git-Isolated Workers

Shared-cwd workers remain available with `--isolation off`, the default. Isolated
worker operation is intentionally Git-only: there is no non-Git isolation mode
and `--cwd` is not a fallback for isolated workers.

Git isolation requires a concrete remote in `scheduler.remote` so the worker can
prepare its local bare repository cache and per-run clones automatically:

```json
{
  "scheduler": {
    "remote": "git@github.com:example/repo.git"
  }
}
```

Set `scheduler.remote` in the graph before starting a pool, or pass a temporary
worker override with `--remote`:

```bash
npm run worker -- --graph ./plan-scheduler-priority.graph.json --session codex-A --once --isolation git
npm run worker -- --graph ./plan-scheduler-priority.graph.json --session codex-B --once --isolation git --remote git@github.com:example/repo.git
```

In `--isolation git`, the worker validates the remote before claim, initializes
or refreshes `runs/git/cache/repo.git`, creates a fresh clone under
`runs/workspaces/<safe-session>/<safe-node-id>/<safe-run-id>`, checks out a
unique `spg/node/<node-id>/<run-id>` branch, runs the child command inside that
clone, auto-commits any dirty workspace changes on successful exit, and records
the clone, base ref, work ref, and output ref in the report. Operators do not
pre-create the cache repository or workspaces.

Parent composition is buffered through Git refs instead of a shared branch.
`series` parents pass each child output ref to the next child and publish the
parent output as an alias of the final child output. `parallel` parents start all
children from the same composition base, then merge child output refs in
`children` order into a dedicated parent integration ref. Merge conflicts leave
the parent blocked or in review with the integration workspace and child refs in
the report; see [`docs/runbook.md`](docs/runbook.md) for recovery.

Worker options:

- `--once`: claim at most one node and exit.
- `--quiet`: capture child output in the report without streaming it live.
- `--node ID`: target one ready node.
- `--cwd PATH`: set the child process working directory; default is the graph
  directory.
- `--template PATH`: use a custom Markdown prompt template; relative paths
  resolve from the graph directory.
- `--timeout-ms MS`: fail the worker run if the child exceeds the runtime.
- `--lease SECONDS`: override the graph scheduler lease duration.
- `--codex-command PATH`: use a different child command.
- `--codex-arg ARG`: repeat to customize child args. Use
  `--codex-arg=--flag` when the value starts with `-`.
- `--isolation off|git`: choose shared-cwd or Git-backed isolated worker mode.
- `--remote URL`: temporary Git remote override for `--isolation git`; otherwise
  the worker reads `scheduler.remote`.
- `--workspace-root PATH`: parent directory for Git-isolated per-run clones.
- `--workspace-retention on-failure|always|never`: clone cleanup policy for
  Git-isolated runs.
- `--planner-mode off|auto-decompose|ask-approval`: opt into planner preflight
  before Codex execution. `auto-decompose` applies valid `series` or `parallel`
  fixture/prompt decisions; `ask-approval` blocks with a preview report and
  `pendingPlannerPreview` metadata. Preview approval through `apply-preview`
  or `decompose` is rejected if the graph version or blocked-node state changed
  after the preview was stored. Use `reject-preview` to discard the stored
  preview without creating child nodes.
- `--planner-adapter none|fixture|prompt`: choose the planner runtime boundary.
  `fixture` reads local JSON and never uses the network. `prompt` requires an
  injected prompt adapter; the scheduler core does not hard-code a provider.
- `--planner-fixture PATH`: local planner response object or request-id map for
  deterministic demos and tests; relative paths resolve from the graph
  directory.
- `--planner-template PATH`: custom planner prompt template for prompt-backed
  adapters; relative paths resolve from the graph directory.
- `--planner-failure-policy block|fail`: convert planner runtime/validation
  failures to blocked nodes by default, or failed nodes when set to `fail`.
- `--planner-allowed-kind task|series|parallel`: repeat to constrain accepted
  planner response kinds.
- `--planner-request-id-prefix TEXT`: request id prefix for planner preflight.

Worker planner preflight records per-node `workerPlanner` metadata with attempt
history, durable decisions, and the configured attempt limit. `task` decisions
are reused on later claims so execution does not repeatedly ask the planner.
Set `scheduler.workerPlanner.maxAttempts` to control retry limits; the default
is `1`, and exhausted attempts block or fail according to
`planner-failure-policy`.

Default worker reports go to:

```text
reports/<safe-node-id>-<safe-run-id>.md
```

Report paths are graph-directory relative unless an absolute path inside the
graph directory is supplied. Paths that escape the graph directory are rejected.

## Renderer Usage

The renderer reads graph `document` content and writes a static HTML plan view
with an embedded planar SVG.

Render with npm:

```bash
npm run render -- --graph ./plan-example.graph.json --out /tmp/spg-plan-example.html
```

Render with the compatibility wrapper:

```bash
npm run build
node scripts/render-plan.mjs --graph ./plan-example.graph.json --out /tmp/spg-plan-example.html
```

Renderer input resolution is, in order: `--graph`, the first positional
argument, `PLAN_GRAPH`, then `plan.graph.json`. Relative graph paths resolve
from the package root, matching scheduler commands.

Renderer output resolution is, in order: `--output`, `--out`, the second
positional argument, `graph.scheduler.htmlView`, then `plan.html`. Relative
output paths resolve from the input graph directory; absolute output paths are
used as supplied. Output files are replaced atomically, so a render failure
leaves any existing HTML file untouched. A graph without `document` content
cannot be rendered as static documentation and does not write an output file.

After scheduler mutations, the scheduler regenerates the configured HTML view
only when the graph has a `document` field.

## Checks

Authoritative local checks:

```bash
npm ci
npm run format:check
npm run lint
npm run check
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

Run `npm run check` before handing off changes. It runs the newline and
trailing-whitespace policy, ESLint, and TypeScript `--noEmit` checks in that
order. `npm run lint` covers `scripts/**/*.ts`, `scripts/**/*.mjs`,
`tests/**/*.ts`, `tests/**/*.mjs`, and `eslint.config.mjs`; it intentionally
ignores `dist/`, `reports/`, `runs/`, `logs/`, rendered plan HTML, and other
runtime outputs.

The lint policy is deliberately small: ESLint recommended rules, TypeScript
recommended rules, and a few consistency rules that catch common review noise
and likely bugs such as loose equality, missing braces, implicit coercion,
undefined JavaScript names, and unused TypeScript symbols. Formatting remains
limited to line endings, final newlines, and trailing whitespace so the project
does not require a broad formatter migration.

`npm run audit:dependencies` enforces an empty production dependency surface,
checks dev dependency licenses against the repository allowlist, and runs the
moderate-level npm vulnerability audit.

`npm test` runs typecheck, build, and the Node behavior suite. The smoke test
exercises real built entry points with relative and absolute graph paths, a
harmless worker, renderer output, and visualizer startup. See
[`docs/testing.md`](docs/testing.md) for the test-layer map, CI artifact
capture, and the release gate. GitHub CI installs Chromium and treats the
real-browser visualizer check as required; a local environment exception is only
valid when the exact browser or bind restriction is recorded and the check is
rerun in a supported environment before release verification is complete.
Use [`docs/release-checklist.md`](docs/release-checklist.md) before tagging or
handing off a package candidate; it covers version notes, build and smoke gates,
package dry-run contents, and the expected commit boundary. `npm run
release:check` runs dependency policy checks and prints the package version,
changelog-note status, built binary targets, content checks, and the full
dry-run package manifest for that checklist.

## Files

- `plan-example.graph.json`: completed sample graph with renderer document
  content.
- `plan-scheduler-priority.graph.json`: active priority-selection graph.
- `examples/goal-git-footprint.graph.json`: validated metadata example for
  goal-first plans and Git-aware visualizer fields.
- `prompts/codex-worker-task.md`: default worker prompt template.
- `scripts/plan-scheduler.ts`: scheduler CLI, exports, and visualizer server
  integration.
- `scripts/render-plan.ts`: static HTML renderer.
- `scripts/*.mjs`: compatibility wrappers and smoke harnesses; wrappers import
  built files from `dist/`.
- `scripts/contracts.ts`: public TypeScript contracts and graph validation.
- `scripts/node-mutations.ts`: scheduler transition implementation.
- `scripts/graph-io.ts`: graph reads, validation, locking, atomic writes, and
  report path containment.
- `scripts/benchmark-lock-contention.ts`: manual release benchmark for p95 graph
  mutation latency under lock contention.
- `eslint.config.mjs`: lightweight lint policy for source scripts and tests;
  generated output and runtime artifacts stay ignored.
- `tests/package-smoke.test.mjs`: npm script, package bin, and built entry
  smoke contracts.
- `tests/validation-contracts.test.mjs`: graph validation, schema, graph IO,
  locks, report containment, and operational event contracts.
- `tests/scheduler-mutations.test.mjs`: readiness, scheduler lifecycle,
  transition, reset, decompose, and preview approval behavior.
- `tests/cli-goldens.test.mjs`: CLI parsing, command failures, help, and golden
  output contracts.
- `tests/worker-runtime.test.mjs`: worker prompt, isolation, Git runtime, Codex
  process, lease heartbeat, and output-ref behavior.
- `tests/visualizer-renderer.test.mjs`: visualizer server APIs, Slack
  notifications, layout, HTML escaping, and static renderer behavior.
- `tests/regressions.test.mjs`: focused historical bug regressions.
- `tests/doc-examples.test.mjs`: README quickstart, disposable demo,
  diagnostics, renderer, and visualizer-startup example smoke tests.
- `tests/visualizer-browser.test.mjs`: optional Chromium visualizer suite.
- `docs/compatibility-boundaries.md`: public compatibility contract.
- `docs/architecture.md`: maintainer module boundaries and extension points.
- `docs/graph-authoring.md`: graph authoring guidance for humans and agents.
- `docs/security.md`: trust model and safe operator checklist.
- `docs/testing.md`: test architecture and release gate.
- `docs/release-checklist.md`: release checklist and package contents review.
- `docs/quality-bar.md`: quality and release hygiene bar.
- `docs/operational-events.md`: operational event names and history fields.
- `docs/visualizer-gui.md`: visualizer operator-console documentation and
  design direction.
- `docs/lock-strategy-decision.md`: graph lock design decision.
- `docs/lock-contention-benchmark.md`: manual graph lock contention benchmark.
- `docs/mutation-ownership.md`: graph field ownership rules for scheduler
  mutations.
- `docs/output-safety-audit.md`: output escaping and report-safety audit.
- `docs/runbook.md`: troubleshooting and recovery steps for operators.
- `docs/dynamic-context-flow.md`: bounded predecessor, sibling, and report
  summary context for workers and planners.
- `docs/technical-debt.md`: maintainability debt register and complexity
  guardrails.
- `docs/worker-isolation-remote-cache.md`: Git-isolated worker remote and cache
  contract.

## Troubleshooting

For detailed symptoms, diagnosis commands, and recovery actions, see
[`docs/runbook.md`](docs/runbook.md).

`ENOENT: no such file or directory, open '.../plan.graph.json'`

Pass `--graph`, set `PLAN_GRAPH`, or create your operating graph at
`plan.graph.json`.

`Cannot find module '../dist/scripts/plan-scheduler.js'`

Run `npm run build` before using `node scripts/plan-scheduler.mjs` or
`node scripts/render-plan.mjs`.

`No ready nodes`

Run `diagnostics` to inspect next-ready work, blocked and failed leaves,
expired leases, and graph lock state. If work should be available, run
`release-expired` for expired claimed/running leases, answer or reset blocked
nodes, inspect and reset failed nodes, or run `reconcile` if internal parent
statuses look stale.

`Node lease is owned by another session`

Use the claiming `--session` or `--run`, or ask the operator to reset, answer,
or release expired work when appropriate.

`Invalid graph file ...`

Read the JSON-style issue path in the error. Most failures are missing roots,
missing child ids, non-array `children`, duplicate children, cycles, or malformed
lease/timestamp fields.

`plan.graph.json is missing document content`

The static renderer needs graph `document` content. Use `plan-example.graph.json`
for renderer checks or add a document model to the operating graph.

`serve` refuses a non-loopback host

Use `--visualizer-write-token TOKEN`, keep the default `127.0.0.1`, or pass
`--unsafe-visualizer-write` only on a trusted network.

`Timed out waiting for graph lock`

Run `diagnostics --graph <graph>` and check `.lock.owner`. If no owner process
is alive and the graph is readable, inspect `<graph>.lock/metadata.json` before
removing stale lock directories. Otherwise wait for the active scheduler,
renderer, or worker process to finish.

`Timed out waiting for Git cache lock`

Another `--isolation git` worker is preparing `runs/git/cache/repo.git`.
Inspect `runs/git/cache/.repo.git.lock/owner.json` relative to the graph
directory and wait for the owner process if it is still alive. For slow remote
clones or fetches under heavy worker startup contention, raise
`SPG_GIT_CACHE_LOCK_TIMEOUT_MS` from its default `60000`.

`spawn codex ENOENT`

Install the Codex CLI or pass `--codex-command` with a command available in the
worker environment.

`Worker isolation requires scheduler.remote`

Set `scheduler.remote` in the graph to a concrete Git remote, or pass
`--remote <url>` with `--isolation git`. Git isolation prepares its own cache and
clone; non-Git isolation is intentionally unsupported.

## More Documentation

- Compatibility contract:
  [`docs/compatibility-boundaries.md`](docs/compatibility-boundaries.md)
- Maintainer architecture:
  [`docs/architecture.md`](docs/architecture.md)
- Graph authoring:
  [`docs/graph-authoring.md`](docs/graph-authoring.md)
- Graph JSON Schema:
  [`schemas/plan-graph.schema.json`](schemas/plan-graph.schema.json)
- Security model:
  [`docs/security.md`](docs/security.md)
- Testing and release gate:
  [`docs/testing.md`](docs/testing.md)
- Release checklist:
  [`docs/release-checklist.md`](docs/release-checklist.md)
- Release hygiene and quality bar:
  [`docs/quality-bar.md`](docs/quality-bar.md)
- Operational events:
  [`docs/operational-events.md`](docs/operational-events.md)
- Visualizer GUI:
  [`docs/visualizer-gui.md`](docs/visualizer-gui.md)
- Locking design:
  [`docs/lock-strategy-decision.md`](docs/lock-strategy-decision.md)
- Lock contention benchmark:
  [`docs/lock-contention-benchmark.md`](docs/lock-contention-benchmark.md)
- Mutation ownership:
  [`docs/mutation-ownership.md`](docs/mutation-ownership.md)
- Output safety:
  [`docs/output-safety-audit.md`](docs/output-safety-audit.md)
- Runbook:
  [`docs/runbook.md`](docs/runbook.md)
- Technical debt:
  [`docs/technical-debt.md`](docs/technical-debt.md)
- Worker isolation:
  [`docs/worker-isolation-remote-cache.md`](docs/worker-isolation-remote-cache.md)
