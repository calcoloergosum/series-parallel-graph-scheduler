# Mutation Ownership

Graph mutations must treat the plan JSON as an extensible document. Commands own only the fields needed for their transition and must preserve unrelated top-level, scheduler, document, graph, node, lease, and history metadata.

Mutation rules:

- Prefer in-place updates to existing graph and node objects so unknown metadata stays attached.
- Set only the command-owned status, lease, timestamp, report, blocking, answer, decomposition, or reconciliation fields.
- Delete only fields listed by that command's transition semantics, and record those deletions in the node history `clearedFields` payload.
- When creating nodes from structured input such as `decompose --child-json`, copy through unknown child metadata after validating the owned fields.
- Every history entry for a status-changing mutation should include `previousStatus`, resulting `status`, and command-specific context such as `session`, `runId`, `reason`, `question`, `answer`, `report`, `childIds`, or lease expiry when available.
- Do not use resets as metadata scrubbers. Reset commands clear operational retry fields but preserve unrelated node metadata.
- Git-only isolation ref fields (`baseRef`, `workRef`, `outputRef`,
  `integrationRef`, and `gitFootprint`) are owned by isolated worker and
  composition transitions.
  Worker leaf resets preserve worker-owned refs for audit until a later worker
  run overwrites them.
- Composition parent `outputRef` and `integrationRef` are derived from child
  refs, and composition parent `gitFootprint` is derived from the resulting
  parent output. Resetting a composition subtree, or reopening a completed
  ancestor after a child reset, clears those composition-owned fields because
  they no longer describe the current child subtree. Child worker refs are
  preserved unless the child itself is rerun and records new refs.

## Scheduler Transition Reference

<!-- BEGIN GENERATED: scheduler-transition-table -->
This section is generated from `schedulerTransitionTable` in `scripts/node-mutations.ts`.

| Command | Actor | Scope | Allowed statuses | Target status | Lease requirement | Implementation |
| --- | --- | --- | --- | --- | --- | --- |
| `answer` | operator | blocked leaf | `blocked` | `pending` | does not require owner credentials; clears any lease | `answerNode` |
| `apply-preview` | operator | claimed, running, or blocked leaf with pendingPlannerPreview | `claimed`, `running`, `blocked` | `pending` | uses the guarded decompose mutation path; requires matching lease owner when the preview node is still leased | `applyPlannerPreview` |
| `block` | worker | leaf | `claimed`, `running` | `blocked` | requires matching session or run id when the node is leased; preserves any lease | `blockNode` |
| `claim` | worker | ready leaf; claim also releases expired claimed/running leases before selecting work | `pending`; custom non-busy, non-terminal leaf statuses | `claimed` | creates a new lease; no prior owner required | `claimNode` |
| `decompose` | worker | leaf | `claimed`, `running`, `blocked` | `pending` | requires matching session or run id when the node is leased; clears any lease and creates child nodes | `decomposeNode` |
| `done` | worker | leaf | `claimed`, `running`, `blocked`, `review` | `done` | requires matching session or run id when the node is leased; clears any lease | `completeNode` |
| `fail` | worker | leaf | `claimed`, `running`, `blocked`, `review` | `failed` | requires matching session or run id when the node is leased; clears any lease | `failNode` |
| `reconcile` | system | non-leaf whose child subtrees are all done | `pending`, `claimed`, `running`, `blocked`, `review`, `failed` | `done` | does not inspect or require leases | `reconcileGraphStatus` |
| `reject-preview` | operator | blocked or pending leaf with pendingPlannerPreview | `blocked`, `pending` | `pending` | does not require owner credentials; clears any lease and preview metadata without creating children | `rejectPlannerPreview` |
| `release-expired` | system | nodes with expired leases | `claimed`, `running` | `pending` | requires an expired lease; clears the lease | `releaseExpiredLeases` |
| `renew` | worker | leased leaf | `claimed`, `running`, `blocked`, `review` | `same` | requires an existing lease and matching session or run id | `renewNodeLease` |
| `reset` | operator | leaf | `pending`, `claimed`, `running`, `blocked`, `review`, `failed`, `done`; custom statuses | `pending` | does not require owner credentials; clears any lease | `resetNode` |
| `reset-reachable` | operator | selected node, descendants, and later execution-reachable series work | `pending`, `claimed`, `running`, `blocked`, `review`, `failed`, `done`; custom statuses | `pending` | does not require owner credentials; clears any lease in the reset set | `resetReachable` |
| `reset-subtree` | operator | selected node and child-reachable descendants | `pending`, `claimed`, `running`, `blocked`, `review`, `failed`, `done`; custom statuses | `pending` | does not require owner credentials; clears any lease in the reset set | `resetSubtree` |
| `start` | worker | leaf | `claimed` | `running` | requires matching session or run id when the node is leased; unleased legacy nodes are accepted | `startNode` |
<!-- END GENERATED: scheduler-transition-table -->
