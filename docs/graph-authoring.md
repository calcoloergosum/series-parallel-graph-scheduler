# Graph Authoring Guide

Use this guide when writing or editing a scheduler graph by hand. The graph format is intentionally plain JSON, but the runtime validator enforces the topology and operational fields that the scheduler depends on.

Before starting workers against a new or edited graph, run a read-only load command:

```bash
npm run summary -- --graph ./plan-improve.graph.json
```

`summary` parses the file, runs the same fatal validation used by scheduler and
renderer commands, and exits non-zero on invalid graphs. Replace the path with
the graph you edited; if you want to use the default `plan.graph.json`, create
that file first or set `PLAN_GRAPH` to an existing graph.

## Editor Schema

Use [`schemas/plan-graph.schema.json`](../schemas/plan-graph.schema.json) for
JSON editor completion and validation. Add this to a hand-authored graph file
when your editor supports local JSON Schema references:

```json
{
  "$schema": "./schemas/plan-graph.schema.json",
  "graph": {
    "root": "ROOT",
    "nodes": {
      "ROOT": {
        "title": "Root task",
        "kind": "task",
        "status": "pending"
      }
    }
  }
}
```

Regenerate the checked-in schema after changing TypeScript graph contracts or
validator invariants:

```bash
npm run schema:graph
```

The schema includes editor-friendly examples for `task`, `series`, `parallel`,
and `gate` nodes under `x-spg-nodeExamples`. JSON Schema cannot fully express
node-map reference checks or arbitrary cycle detection, so those runtime-only
hard errors are listed in `x-spg-validatorInvariants` and enforced by
`validatePlanGraphFileResult`.

## Required Shape

Every graph file must be a JSON object with this minimum structure:

```json
{
  "title": "Plan title",
  "description": "Short operator context",
  "graph": {
    "root": "ROOT",
    "nodes": {
      "ROOT": {
        "title": "Root",
        "kind": "series",
        "status": "pending",
        "children": ["A"]
      },
      "A": {
        "title": "First task",
        "kind": "task",
        "status": "pending"
      }
    }
  }
}
```

`graph.root` must be a non-empty string and must name an object in `graph.nodes`. `graph.nodes` must be an object keyed by node id. Each node value must be an object.

## Node Kinds

Known node kinds are `series`, `parallel`, `gate`, and `task`.

`series` nodes run child subtrees in order. They must have a non-empty `children` array. The ready list exposes the first child subtree that is not done.

`parallel` nodes run child subtrees independently. They must have a non-empty `children` array. The ready list exposes ready leaves from every unfinished child subtree.

`task` nodes are normal worker units. A task should usually be a leaf with no `children`; leaf tasks are the units workers claim. A task with children is not a fatal validation error, but it produces a warning and the scheduler visits each child in listed order during readiness traversal. It does not get first-unfinished-child gating unless its kind is `series`.

`gate` nodes are checkpoint leaves. Use a gate as a claimable task when separate branches need explicit integration or operator review before later work opens. A gate with children is not a fatal validation error, but it produces a warning and the scheduler visits each child in listed order during readiness traversal. It does not get first-unfinished-child gating unless its kind is `series`.

Missing `kind` defaults operationally to `task`. Unknown custom kind strings are allowed with a warning; if a custom-kind node has children, readiness traversal falls back to visiting each child in listed order.

## Status And Metadata

Known statuses are `pending`, `claimed`, `running`, `blocked`, `review`, `failed`, and `done`.

Missing `status` defaults operationally to `pending`. Custom status strings are allowed with a warning. `done` is the only terminal status. `claimed`, `running`, `blocked`, `review`, and `failed` are busy statuses and are not listed as ready.

The validator is not a full schema lock. Unknown top-level fields, graph-level fields, and node-level fields are preserved unless a mutation command explicitly owns that field. This keeps metadata such as `schemaVersion`, `statusModel`, `scheduler`, `document`, labels, priority, owners, and links extensible.

Goal-driven planner output is a proposal format, not graph state. The planner
schema and examples are documented in
[`docs/planner-output-schema.md`](planner-output-schema.md). Scheduler code must
validate a planner response and materialize safe child node ids before writing
new `graph.nodes` entries.
Planning approval modes, dry-run behavior, regeneration, and invalid-output
failure handling are documented in
[`docs/planning-safety-and-approval.md`](planning-safety-and-approval.md).

Planner-created nodes may use additive metadata fields such as `goal`,
`planner`, `contextRefs`, `outputContract`, and `resultSummary`. These fields
are optional, remain unknown-metadata compatible for older readers, and are
preserved by graph reads and writes unless a future mutation explicitly owns
one of them.

Git-only worker isolation uses optional node ref metadata fields named
`baseRef`, `workRef`, `outputRef`, `integrationRef`, and `gitFootprint`.
Existing graphs do not need these fields, and ordinary graph validation does not
require them. When present, their compatibility contract is documented in
`docs/compatibility-boundaries.md`.

To opt a graph into Git-isolated workers, add a concrete remote under
`scheduler.remote` and then run workers with `--isolation git`:

```json
{
  "scheduler": {
    "remote": "git@github.com:example/repo.git"
  }
}
```

Do not add `workRef`, `outputRef`, or `integrationRef` by hand for new work.
The isolated worker and composition reconciliation paths record those fields as
they prepare clones, publish task output refs, and publish parent buffer refs.
`gitFootprint` is likewise worker- or reconciler-produced provenance metadata;
operators should only edit it when repairing a graph from externally verified
Git refs and commits.
Graphs without `scheduler.remote` remain valid for read-only commands and
shared-cwd workers, but `--isolation git` fails before claim unless a concrete
remote is supplied with `--remote`.

Fields with scheduler meaning must keep the validated shape when present:

- `children`: array of string node ids.
- `lease`: object with non-empty string `session` and `runId`, plus timestamp strings `claimedAt` and `expiresAt`; optional `renewedAt` must also be a timestamp.
- `startedAt`, `completedAt`, `blockedAt`, `answeredAt`, `failedAt`, `expiredAt`: timestamp strings.
- `history`: array of objects; each entry needs timestamp string `at`, and `event` must be a string when present.

Timestamp strings must parse as ISO-like timestamps such as `2026-05-27T00:00:00.000Z` or `2026-05-27T09:00:00+09:00`.

## Valid Nested Example

This example includes a series root, a parallel fanout, branch-local series work, a gate, a blocked node, and a previously answered node.

```json
{
  "graphVersion": 7,
  "title": "Release Plan",
  "description": "Build two branches, integrate, then ship.",
  "statusModel": ["pending", "claimed", "running", "blocked", "review", "failed", "done"],
  "scheduler": {
    "leaseSeconds": 1800
  },
  "graph": {
    "root": "ROOT",
    "nodes": {
      "ROOT": {
        "title": "Release flow",
        "kind": "series",
        "status": "pending",
        "children": ["DISCOVERY", "BUILD", "INTEGRATION_GATE", "SHIP"]
      },
      "DISCOVERY": {
        "title": "Confirm scope",
        "kind": "task",
        "status": "done",
        "completedAt": "2026-05-27T00:20:00.000Z",
        "report": "reports/DISCOVERY.md"
      },
      "BUILD": {
        "title": "Parallel build",
        "kind": "parallel",
        "status": "pending",
        "children": ["WEB_BRANCH", "API_BRANCH"]
      },
      "WEB_BRANCH": {
        "title": "Web branch",
        "kind": "series",
        "status": "pending",
        "children": ["WEB_COPY", "WEB_IMPL"]
      },
      "WEB_COPY": {
        "title": "Resolve copy",
        "kind": "task",
        "status": "pending",
        "question": "Should the CTA say Start or Launch?",
        "answer": "Use Launch.",
        "answeredAt": "2026-05-27T01:30:00.000Z",
        "answeredBy": "operator",
        "history": [
          {
            "at": "2026-05-27T01:25:00.000Z",
            "event": "blocked",
            "blockedReason": "needs_copy_decision"
          },
          {
            "at": "2026-05-27T01:30:00.000Z",
            "event": "answered",
            "responder": "operator"
          }
        ]
      },
      "WEB_IMPL": {
        "title": "Implement web",
        "kind": "task",
        "status": "pending"
      },
      "API_BRANCH": {
        "title": "API branch",
        "kind": "series",
        "status": "pending",
        "children": ["API_SCHEMA", "API_IMPL"]
      },
      "API_SCHEMA": {
        "title": "Finalize schema",
        "kind": "task",
        "status": "blocked",
        "blockedAt": "2026-05-27T01:45:00.000Z",
        "blockedReason": "needs_contract_decision",
        "question": "Should v1 expose beta fields?",
        "lease": {
          "session": "codex-B",
          "runId": "run_api_schema",
          "claimedAt": "2026-05-27T01:40:00.000Z",
          "expiresAt": "2026-05-27T02:40:00.000Z"
        }
      },
      "API_IMPL": {
        "title": "Implement API",
        "kind": "task",
        "status": "pending"
      },
      "INTEGRATION_GATE": {
        "title": "Integration gate",
        "kind": "gate",
        "status": "pending"
      },
      "SHIP": {
        "title": "Ship release",
        "kind": "task",
        "status": "pending"
      }
    }
  },
  "owner": "release-team"
}
```

In this graph, `BUILD` cannot open until `DISCOVERY` is done. `WEB_BRANCH` and `API_BRANCH` can progress independently under `BUILD`. `INTEGRATION_GATE` cannot become ready until both build branches are done, and `SHIP` cannot become ready until the gate is done.

The answered `WEB_COPY` node remains `pending` because the operator answer returned it to the ready queue. The blocked `API_SCHEMA` node is busy and does not stop unrelated ready leaves in other parallel branches.

## Common Mistakes

Invalid: `children` is a string.

```json
{
  "kind": "series",
  "children": "A"
}
```

Correct:

```json
{
  "kind": "series",
  "children": ["A"]
}
```

Invalid: a `series` or `parallel` node has no children.

```json
{
  "kind": "parallel",
  "children": []
}
```

Correct:

```json
{
  "kind": "parallel",
  "children": ["LEFT", "RIGHT"]
}
```

Invalid: a child id is referenced but missing from `graph.nodes`.

```json
{
  "ROOT": {
    "kind": "series",
    "children": ["A", "MISSING"]
  },
  "A": {
    "kind": "task"
  }
}
```

Correct:

```json
{
  "ROOT": {
    "kind": "series",
    "children": ["A", "MISSING"]
  },
  "A": {
    "kind": "task"
  },
  "MISSING": {
    "kind": "task",
    "status": "pending"
  }
}
```

Invalid: the same child id appears twice in one child list.

```json
{
  "kind": "series",
  "children": ["A", "A"]
}
```

Correct:

```json
{
  "kind": "series",
  "children": ["A", "A_REVIEW"]
}
```

Invalid: child references create a cycle.

```json
{
  "ROOT": {
    "kind": "series",
    "children": ["A"]
  },
  "A": {
    "kind": "series",
    "children": ["ROOT"]
  }
}
```

Correct:

```json
{
  "ROOT": {
    "kind": "series",
    "children": ["A"]
  },
  "A": {
    "kind": "task"
  }
}
```

Invalid: a lease is missing required fields or has a non-timestamp expiry.

```json
{
  "kind": "task",
  "status": "claimed",
  "lease": {
    "session": "codex-A",
    "expiresAt": "tomorrow"
  }
}
```

Correct:

```json
{
  "kind": "task",
  "status": "claimed",
  "lease": {
    "session": "codex-A",
    "runId": "run_123",
    "claimedAt": "2026-05-27T00:00:00.000Z",
    "expiresAt": "2026-05-27T00:30:00.000Z"
  }
}
```

Warning, not fatal: a `task` or `gate` has children. Prefer making the internal node a `series` or `parallel` node, or remove `children` if it should be a claimable leaf.

```json
{
  "kind": "task",
  "children": ["A", "B"]
}
```

Correct:

```json
{
  "kind": "series",
  "children": ["A", "B"]
}
```
