# Planning Safety And Approval Boundaries

Goal-driven planner output is untrusted proposal text until scheduler code
validates it, materializes safe node ids, and writes graph state through the
normal locked graph mutation path. These rules apply to any future `plan`
command, planner-backed node decomposition, or visualizer planning flow.

The scheduler must never execute workers from raw planner output. Execution can
only start after a valid graph exists on disk and an operator or authorized
local process invokes the existing worker, claim, start, or visualizer worker
routes against that graph.

The acceptance workflows that exercise those boundaries are documented in
[`goal-driven-acceptance-contract.md`](goal-driven-acceptance-contract.md).

## Operator Approval Modes

Planning flows have four distinct operator modes. Implementations may expose
them with CLI flags, GUI buttons, or both, but the behavior must stay separate.

| Mode | Graph write? | Worker start? | Required boundary |
| --- | --- | --- | --- |
| Dry run | No | No | Return inspectable command JSON, planner diagnostics, validation errors, and any materialized preview ids without changing the graph file. |
| Auto-save | Yes, after validation | No | Save only a validated graph or decomposition through the locked writer. This mode creates durable graph state but does not run workers. |
| Approve-before-run | Existing graph only | Yes, after explicit approval | Reload and validate the saved graph, then use existing worker start controls. The planner proposal is not a run instruction. |
| Regenerate | No change to accepted graph | No | Create a new proposal artifact or response with a new request id. Do not overwrite an accepted graph or pending draft unless the operator explicitly chooses that target. |

Dry-run output may be printed to stdout, returned from a visualizer API route,
or written as an auxiliary artifact such as planner command JSON. It must not
increment `graphVersion`, create leases, create worker workspaces, start child
processes, send Slack mutation notifications, or regenerate renderer HTML as if
a graph mutation occurred.

Auto-save is the first mode allowed to mutate a graph. It must:

- Validate the raw planner response against the planner output contract.
- Reject empty `series` or `parallel` decompositions before any graph write.
- Generate or accept child node ids only after applying the safe id policy.
- Validate the fully materialized graph with the normal graph validator.
- Acquire the graph lock and re-check the current graph version before writing.
- Write through the existing atomic graph writer so partial planner output
  cannot corrupt the graph file.

Approve-before-run is a second explicit approval after auto-save. Starting a
worker pool, claiming work, or invoking a single worker from a planning screen
must call the same existing worker routes and mutation guards used outside
planning. A combined "plan and run" convenience flow is allowed only if it
performs the same two checkpoints internally: validated save first, then an
operator-confirmed worker start against the saved graph.

Worker-assisted decomposition is opt-in through `scheduler.workerPlanner` or
equivalent worker options. `mode: "off"` preserves the existing worker
lifecycle. `mode: "auto-decompose"` asks the planner after claim/start and
before Codex execution; `task` responses continue to Codex, while valid
`series` or `parallel` responses are applied through the normal `decompose`
mutation and the worker does not execute Codex for that parent. `mode:
"ask-approval"` writes an inspectable planner report and blocks the leased node
instead of mutating children, so an operator can approve, reset, or fail it.
The blocked node also stores `pendingPlannerPreview` metadata with the request
id, source and persisted graph versions, proposed kind, child ids, child titles,
deliverables, acceptance criteria, parsed planner response, materialized
decompose mutation, report path, and the node state snapshot required for safe
approval. Applying that stored preview through `apply-preview` delegates to the
same guarded `decompose` mutation path and is rejected if the graph version or
captured node state has changed; the operator must regenerate, reject, or reset
before applying an obsolete preview.
The planner runtime is selected separately with `adapterMode`: `fixture` reads
a local JSON response or request-id map for deterministic tests and demos,
`prompt` renders a prompt through the prompt adapter boundary, and `injected`
is available to API/test callers that provide a runtime directly. Prompt-backed
planning has no built-in external provider in scheduler core. Planner adapter,
fixture path, template path, allowed kinds, and failure-policy configuration are
validated before the worker claims or starts a node.
`failurePolicy: "block"` is the default for planner errors; `failurePolicy:
"fail"` marks the node failed with the planner report attached.
Both paths append `planner-failed` history before the worker continues. Approval
mode appends `planner-preview-rejected` when a valid preview is intentionally
held for manual review, `planner-preview-applied` when the stored preview is
accepted, `planner-preview-rejected` when an operator discards it, and
`planner-preview-regenerated` when newer preview metadata replaces an older
pending preview.

Regenerate creates a replacement proposal, not an implicit edit to accepted
state. If regeneration happens while a draft is open, the UI should show the
new request id and planner provenance so the operator can compare it with the
previous draft. If accepted graph state has changed since the previous draft,
regeneration must use the latest graph snapshot or clearly report that the
draft was based on an older version.

## Failure Behavior

Planning failures must leave an inspectable record without corrupting graph
state.

| Failure | Required behavior |
| --- | --- |
| Invalid planner output | Reject before graph mutation. Return structured validation errors with paths into the planner response and include the planner request id when known. |
| Empty decomposition | Reject before graph mutation. Do not convert the target leaf into an empty `series` or `parallel` node. |
| Unsafe or conflicting planner ids | Reject planner ids that are empty, path-like, control-character-bearing, duplicate among siblings, collide with existing nodes, or fail the scheduler safe-token policy. Prefer scheduler-generated ids when the planner cannot prove determinism. This restriction is for planner output; manual/API `decompose` keeps the graph-validator boundary of non-empty string ids that reference nodes after mutation. |
| Conflicting graph version | Abort the save or approval apply and return the observed version, current version, and target node id or graph path. The operator must regenerate or reapply against the current graph. |
| Materialized graph validation error | Reject before write and return both planner validation diagnostics and graph validator diagnostics. |
| Graph lock timeout or write failure | Leave the previous graph file as source of truth. Return normal command JSON or an error that names the graph path and operation; do not treat the proposal as accepted. |

For goal planning that creates a new graph path, a failure may write an
auxiliary proposal or command JSON artifact under the run directory, but it must
not leave a partially valid `plan.graph.json` at the target path. For
decomposition of an existing node, a failure may append an explicit planning
failure history entry only if that append is itself a valid locked graph
mutation; otherwise the failure must be reported in command JSON or a separate
artifact.

The acceptance rule is simple: if planner output is invalid, no ready leaf
created by that output may be claimable, and no worker command may be started
from it.

## Security Notes

Generated prompts and planner responses cross a trust boundary. They may
contain misleading instructions, Markdown, shell snippets, links, fake JSON,
HTML-like text, or text that attempts to override scheduler rules. Scheduler
code must parse only the documented JSON contract and treat all free-form
planner text as data.

Planner request construction should minimize sensitive context. Include file
paths, node excerpts, report summaries, and graph excerpts only when needed for
the planning task. Do not include secrets, environment variables, Slack webhook
URLs, credential-bearing remotes, or full worker logs in planner prompts.

Planner text rendered in the visualizer must be inserted with the same escaping
and text-safe DOM practices used for graph titles, worker output, and event
details. The visualizer must not execute planner-provided HTML, scripts, inline
event handlers, or links as trusted UI code.

Every visualizer route that saves planner output, decomposes a node from a
planner proposal, starts workers after approval, discards a draft, or
regenerates a persisted planning artifact is a write route. It must stay behind
the same visualizer write-token boundary as existing `POST` routes when the
server is exposed beyond loopback, and it must use the injected runtime
mutation handlers rather than writing graph files directly.

Planner provenance is useful audit metadata but not proof of safety. Fields
such as `planner.name`, `planner.model`, `requestId`, `rationale`, and
`contextRefs` help operators inspect why a plan exists; they do not bypass
validation, approval, graph locks, lease checks, or visualizer token checks.
