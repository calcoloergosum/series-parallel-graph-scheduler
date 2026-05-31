# Failure Mode Matrix

This matrix defines the expected operator-visible behavior for planner,
scheduler, Git, and GUI-route failures. The graph JSON remains the source of
truth; failures must either leave the graph unchanged or record a valid,
locked history entry that explains the controlled state transition.

| Area | Failure mode | Graph outcome | Visible signal | Recovery |
| --- | --- | --- | --- | --- |
| Planner | Invalid JSON, invalid schema, empty decomposition, unsafe child id, duplicate child id, or child id collision | No child nodes are created and the target remains a leaf. Worker preflight moves the target to `blocked` by default or `failed` when `failurePolicy: "fail"` is configured. | `planner-failed` plus `blocked` or `failed` history entries; planner failure report with validation paths. | Inspect the report. Use `reset --node NODE` to retry the same leaf, `fail --node NODE` if the work should stop, or manually run `decompose` with validated child definitions. |
| Planner | Valid decomposition preview while worker planner mode is `ask-approval` | Target remains a task leaf and moves to `blocked`; no preview child is inserted. | `planner-preview-rejected` plus `blocked` history entries; planner preflight report and `pendingPlannerPreview` include proposed children and decompose mutation. | Approve with `apply-preview --node NODE` while it is fresh, manually `decompose` after edits, regenerate with `reset --node NODE` and rerun the planner, or discard with `reject-preview --node NODE`. |
| Scheduler | Bad manual `decompose` input from CLI or GUI route | Graph file is not written; the target cannot become a half-decomposed node. | Command or route error names the invalid child field; no `decomposed` event. | Correct the child list and retry `decompose`, or reset/fail the node if the current attempt should be abandoned. |
| Scheduler | Lock timeout, stale lock, temp file, or graph validation failure | Previous graph file remains authoritative. Stale-lock cleanup is diagnostic and guarded by lock metadata. | CLI error, `diagnostics.lock`, lock metadata, and optional lock events. | Follow `docs/runbook.md` stale lock or temp-file recovery. Do not delete a live lock. |
| Scheduler | Blocked or failed node prevents readiness | Node stays parked and is excluded from ready leaves. | `diagnostics.blocked`, `diagnostics.failed`, `events --node NODE`. | Use `answer` for a valid blocked question, `reset` for one leaf, `reset-subtree` for a contained branch, or `reset-reachable` when later series work must rerun. |
| Git | Diffstat or footprint collection fails after output ref publication | Completion or parent publication remains successful; Git stats are omitted. | History has `diffStatCollected: false` and `gitFootprintWarning`; visualizer payload includes the warning instead of crashing. | Verify refs manually if needed. Retry only if stats are required; otherwise leave the successful node done. |
| Git | Isolated remote, cache, clone, worktree, push, or missing output-ref failure | Worker fails or blocks without treating partial workspace state as completed output. | Worker report, failed/block history, retained workspace depending on retention policy. | Inspect report and workspace. Fix remote/cache/workspace issue, quarantine only the exact bad path if needed, then `reset --node NODE` and rerun. |
| Git | Parallel integration merge conflict | Parent becomes `review` with retained integration workspace and conflict metadata; completed children stay done. | `merge-conflicted` event, parent report, `integrationRef.status: "conflicted"`, conflicted paths. | Resolve and publish through the documented integration path, or abort/quarantine the workspace and run `reconcile`; use `reset-reachable` only when upstream child output changes. |
| GUI route | Invalid JSON body, missing required body field, invalid numeric field, or invalid child definitions | Graph is not mutated. | HTTP 400 for request validation errors, HTTP 500 for unexpected scheduler/runtime errors; route response contains the error text. | Fix the request and retry, or use the equivalent CLI command for clearer shell diagnostics. |
| GUI route | Write route exposed off loopback without protection | Server refuses startup unless a write token or explicit unsafe flag is supplied. | Startup error naming `--visualizer-write-token` or `--unsafe-visualizer-write`. | Bind to loopback, or provide a write token and pass it from the browser fragment. |
| GUI route | Slack notification delivery fails after a successful mutation | Graph mutation remains committed. | Route or CLI JSON includes `slack.failed`; graph history records the primary mutation. | Fix Slack configuration separately. Do not reset graph state just because notification delivery failed. |

## Operator Checks

Use read-only commands first:

```bash
node scripts/plan-scheduler.mjs diagnostics --graph ./plan-improve.graph.json
node scripts/plan-scheduler.mjs events --graph ./plan-improve.graph.json --node NODE --limit 20
```

Choose the narrowest recovery:

```bash
node scripts/plan-scheduler.mjs reset --graph ./plan-improve.graph.json --node NODE --reason "retry after report inspection"
node scripts/plan-scheduler.mjs reset-subtree --graph ./plan-improve.graph.json --node SUBTREE --reason "discard branch attempt"
node scripts/plan-scheduler.mjs reset-reachable --graph ./plan-improve.graph.json --node UPSTREAM --reason "rerun downstream from changed output"
node scripts/plan-scheduler.mjs decompose --graph ./plan-improve.graph.json --node NODE --session codex-A --run RUN --kind series --child NODE_A="First" --child NODE_B="Second"
```
