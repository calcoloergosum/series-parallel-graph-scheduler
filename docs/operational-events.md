# Operational Events

Operational event names are the stable audit vocabulary for graph history, worker manager activity, Slack notifications, server actions, and lock diagnostics. New code should import `operationalEvents` from `scripts/operational-events.ts` instead of spelling event names inline.

Event names are lowercase kebab-case and should not be renamed once released. Adding fields is compatible; removing, renaming, or changing the meaning of a stable field requires a compatibility note and tests.

## Event Export

Use the read-only `events` command to inspect recent graph history as a flat,
machine-readable stream:

```bash
node scripts/plan-scheduler.mjs events --graph ./plan-improve.graph.json --limit 20
node scripts/plan-scheduler.mjs events --graph ./plan-improve.graph.json --node NODE --limit 10
node scripts/plan-scheduler.mjs events --graph ./plan-improve.graph.json --event blocked
```

Each exported entry has stable top-level fields:

| Field | Meaning |
| --- | --- |
| `at` | Primary event timestamp copied from the history entry. |
| `event` | Stable event name. |
| `nodeId` | Node that owns the source history entry. |
| `status` | Event status when present, otherwise the node's current status. |
| `session` | Worker or operator session when present. |
| `runId` | Worker run id when present. |
| `timestamps` | Timestamp-like fields from the event, including `at`, `blockedAt`, `completedAt`, `failedAt`, `renewedAt`, and `leaseExpiresAt`. |
| `details` | Remaining event metadata after operational redaction. |

The command returns newest events first. `--limit` defaults to 50 and accepts
1..10000. `--node` filters to one node history, and `--event` filters by event
name.

To triage a stuck graph, run `diagnostics` first and then inspect events for the
node called out by `.leases.expired`, `.blocked`, `.failed`, or
`.isolation.unresolvedBufferConflicts`:

```bash
node scripts/plan-scheduler.mjs diagnostics --graph ./plan-improve.graph.json | jq '.actions'
node scripts/plan-scheduler.mjs events --graph ./plan-improve.graph.json --node NODE --limit 10
```

Use the newest event's `status`, `session`, `runId`, and `details` to decide the
next operator action. Expired `claimed` or `running` events normally point to
`release-expired`; `blocked` events need an `answer` or a reset; `failed`,
`merge-conflicted`, or missing-output events usually need the referenced report
or workspace inspected before retrying with `reset` or `reset-reachable`.

## Graph History Events

Graph history entries always include `at` and `event`.

| Event | Meaning | Stable fields |
| --- | --- | --- |
| `claimed` | A worker claimed a ready leaf and created a lease. | `previousStatus`, `status`, `session`, `runId`, `leaseExpiresAt` |
| `running` | A claimed leaf entered worker execution. | `previousStatus`, `status`, `session`, `runId`, `startedAt` |
| `renewed` | A worker extended an owned lease. | `status`, `session`, `runId`, `renewedAt`, `leaseExpiresAt` |
| `done` | A worker completed a leaf. | `previousStatus`, `status`, `session`, `runId`, `completedAt`, `report`, `clearedFields` |
| `blocked` | A worker paused a leaf for operator input. | `previousStatus`, `status`, `session`, `runId`, `blockedAt`, `blockedReason`, `question` |
| `answered` | An operator answered a blocked leaf and returned it to pending. | `previousStatus`, `status`, `answer`, `responder`, `answeredAt`, `clearedFields` |
| `failed` | A worker marked a leaf failed. | `previousStatus`, `status`, `session`, `runId`, `failedAt`, `failureReason`, `report`, `clearedFields` |
| `reset` | An operator reset one node, a subtree, or execution-reachable work. | `previousStatus`, `status`, `resetScope`, `reason`, `rootId`, `clearedFields` |
| `decomposed` | A worker replaced a leaf with a child graph. | `previousStatus`, `status`, `previousKind`, `kind`, `childIds`, `session`, `runId`, `clearedFields` |
| `expired` | The scheduler released an expired claimed or running lease. | `previousStatus`, `status`, `session`, `runId`, `leaseExpiresAt`, `expiredAt`, `clearedFields` |
| `subtree-done` | Reconciliation marked an internal subtree done. | `previousStatus`, `status`, `completedAt`, `childIds` |
| `child-reset` | A leaf reset reopened a completed ancestor. | `previousStatus`, `status`, `childId`, `clearedFields` |
| `clone-prepared` | An isolated worker prepared a local clone from the bare repository cache. | `session`, `runId`, `remote`, `bareRepo`, `cloneCwd`, `baseRef` |
| `branch-created` | An isolated worker created or checked out the per-run work branch. | `session`, `runId`, `cloneCwd`, `baseRef`, `workRef` |
| `output-ref-recorded` | An isolated worker recorded the output ref produced by a completed run. | `session`, `runId`, `workRef`, `outputRef`, `commit`, `report` |
| `merge-attempted` | A parallel parent buffer attempted to merge a child output ref. | `parentId`, `integrationRef`, `baseRef`, `childId`, `childOutputRef`, `childOrderIndex` |
| `merge-conflicted` | A parallel parent buffer merge encountered conflicts and left the parent unresolved. | `parentId`, `integrationRef`, `baseRef`, `childId`, `childOutputRef`, `childOrderIndex`, `conflictedPaths`, `result` |
| `parent-ref-published` | A composition parent published the output ref used by downstream isolated work. | `parentId`, `kind`, `integrationRef`, `outputRef`, `commit`, `result` |

Composition buffers also use `blocked` when required child refs or integration setup are missing. `blocked` and `review` composition parents are parked until an operator resets the parent or affected subtree; reconciliation does not keep retrying the same unresolved buffer.

`resetScope` is `node`, `subtree`, or `reachable`. Operators can reconstruct a task lifecycle by reading a node history in order and following `child-reset`, `subtree-done`, and isolation ref events on ancestors. `remote` fields on isolation events must use the redacted display value, while `bareRepo`, `cloneCwd`, `baseRef`, `workRef`, `outputRef`, and `integrationRef` fields are inspectable local paths or Git refs.

## Worker And Lock Events

The visualizer worker manager emits `worker-started` and `worker-stopped` entries in worker log tails. These entries include worker identity, session, process id when available, cwd, stop signal, exit code, or spawn error.

Lock event names are reserved for structured lock diagnostics:

- `lock-acquired`
- `lock-released`
- `lock-stale-reaped`
- `lock-timeout`

Current lock errors still include human-readable owner metadata. Future structured lock logs should use these names and the stable fields listed in `operationalEventTaxonomy`.

## Secret Handling

Graph history event details pass through operational redaction before they are appended, and the `events` command redacts again while exporting. The redactor masks Slack webhook URLs, bearer tokens, URL userinfo such as `https://user:token@example/repo.git`, and common `token`, `password`, `secret`, `api_key`, and `authorization` assignments. Primary node fields such as `question`, `answer`, and `failureReason` still store the operator-provided value because they are part of task state; event payloads are the safer audit stream for broad inspection.
