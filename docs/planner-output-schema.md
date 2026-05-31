# Planner Output Schema

This document defines the proposal shape a planner may return when converting
an operator goal or an existing task into scheduler nodes. Planner output is a
candidate artifact, not graph state. Scheduler code must validate the response,
materialize child ids, check topology, then apply the graph mutation through
the normal locked graph write path.

The TypeScript contract lives in
[`scripts/contracts.ts`](../scripts/contracts.ts):

- `PlannerRequest`: context sent to a planner for either a new goal or an
  existing node decomposition.
- `PlannerResponse`: a discriminated union for `task`, `series`, or
  `parallel` output.
- `PlannerChildProposal`: a proposed child node before it is inserted into
  `graph.nodes`.
- `PlannerValidationError` and `PlannerValidationResult`: diagnostics produced
  before any graph mutation is allowed.

Planner safety, approval, dry-run, auto-save, and regenerate behavior is
defined in
[`planning-safety-and-approval.md`](planning-safety-and-approval.md). This
schema is necessary but not sufficient for execution: valid planner output must
still pass the approval and graph-write boundaries before workers can run.
The scheduler treats this schema as a data contract, not as an instruction
language. Planner responses cannot name shell commands to run, bypass existing
graph locks, override visualizer write-token policy, or make raw proposal text
claimable before materialization and validation.

## Planner Request

Planner requests should include the goal text, the planning mode, and any
existing node/context the planner needs. The request may contain graph excerpts,
but the response must not echo a complete graph patch as an instruction to
write state directly.

Dynamic context selection is defined in
[`dynamic-context-flow.md`](dynamic-context-flow.md). The request-level
`relevantContext` field is the canonical bounded context payload; it includes
root and parent summaries, completed series predecessors, completed siblings,
explicit context references, and report paths/summaries without embedding report
bodies.

```json
{
  "requestId": "plan-20260531T010000Z-root",
  "mode": "goal",
  "goal": "Ship a searchable audit log",
  "allowedKinds": ["task", "series", "parallel"],
  "contextRefs": [
    {
      "type": "file",
      "ref": "docs/security.md",
      "title": "Security assumptions"
    }
  ],
  "relevantContext": {
    "nodeId": "AUDIT_UI",
    "self": {
      "nodeId": "AUDIT_UI",
      "relation": "self",
      "title": "Implement audit log search UI",
      "kind": "task",
      "status": "pending"
    },
    "parents": [],
    "seriesPredecessors": [
      {
        "nodeId": "AUDIT_CONTRACT",
        "relation": "series-predecessor",
        "title": "Define audit search data contract",
        "kind": "task",
        "status": "done",
        "summary": "Filter fields and pagination behavior are documented.",
        "report": "reports/AUDIT_CONTRACT.md"
      }
    ],
    "completedSiblings": [],
    "reports": [
      {
        "nodeId": "AUDIT_CONTRACT",
        "relation": "series-predecessor",
        "kind": "task",
        "status": "done",
        "summary": "Filter fields and pagination behavior are documented.",
        "report": "reports/AUDIT_CONTRACT.md"
      }
    ],
    "selection": {
      "maxItems": 12,
      "maxSummaryChars": 400,
      "includedRelations": ["self", "root", "parent", "series-predecessor", "completed-sibling", "explicit-ref"],
      "reportBodyPolicy": "paths-and-summaries-only"
    }
  },
  "outputContract": {
    "format": "markdown",
    "requiredArtifacts": ["implementation summary", "test evidence"]
  }
}
```

## Atomic Task Output

Use `kind: "task"` when the planner determines the work should remain a single
claimable unit. No child node ids are allocated for this response.

```json
{
  "requestId": "plan-20260531T010000Z-audit-ui",
  "kind": "task",
  "title": "Implement audit log search UI",
  "description": "Add the searchable audit log view and wire it to existing audit data.",
  "deliverables": [
    "Searchable audit log screen",
    "Focused tests for filtering and empty states"
  ],
  "acceptanceCriteria": [
    "Operators can search audit entries by actor, event, and node id.",
    "The view handles empty results without errors."
  ],
  "goal": {
    "text": "Ship a searchable audit log",
    "source": "operator"
  },
  "planner": {
    "name": "codex-planner",
    "model": "gpt-5",
    "requestId": "plan-20260531T010000Z-audit-ui"
  },
  "outputContract": {
    "format": "markdown",
    "requiredArtifacts": ["report", "test output"]
  }
}
```

## Series Decomposition Output

Use `kind: "series"` when children must run in order. Child proposals may
include `idHint` values for stable human readability, but scheduler validation
owns final id materialization unless an accepted deterministic `id` is supplied.

```json
{
  "requestId": "plan-20260531T010000Z-audit-series",
  "kind": "series",
  "title": "Build searchable audit log",
  "description": "Prepare the data contract, implement the UI, then document operation.",
  "childIdPolicy": "scheduler-generated",
  "children": [
    {
      "idHint": "AUDIT_SCHEMA",
      "kind": "task",
      "title": "Define audit search data contract",
      "deliverables": ["API and state contract for audit search"],
      "acceptanceCriteria": ["Filter fields and pagination behavior are documented."]
    },
    {
      "idHint": "AUDIT_UI",
      "kind": "task",
      "title": "Implement audit search interface",
      "deliverables": ["Audit search UI", "Tests for search behavior"]
    },
    {
      "idHint": "AUDIT_DOCS",
      "kind": "task",
      "title": "Document audit search operation",
      "deliverables": ["Operator documentation update"]
    }
  ]
}
```

## Parallel Decomposition Output

Use `kind: "parallel"` when children can run independently. If the planner
supplies `id` fields, they must be deterministic from stable inputs and
validation must reject collisions with existing graph nodes or sibling
proposals.

```json
{
  "requestId": "plan-20260531T010000Z-audit-parallel",
  "kind": "parallel",
  "title": "Audit log delivery fanout",
  "description": "Split backend, frontend, and documentation work that can proceed independently.",
  "childIdPolicy": "planner-deterministic",
  "children": [
    {
      "id": "AUDIT_BACKEND",
      "kind": "task",
      "title": "Implement audit search backend",
      "contextRefs": [
        {
          "type": "file",
          "ref": "scripts/operational-events.ts"
        }
      ],
      "outputContract": {
        "format": "patch",
        "requiredArtifacts": ["backend implementation", "unit tests"]
      }
    },
    {
      "id": "AUDIT_FRONTEND",
      "kind": "task",
      "title": "Implement audit search frontend",
      "outputContract": {
        "format": "patch",
        "requiredArtifacts": ["visualizer UI", "browser test evidence"]
      }
    },
    {
      "id": "AUDIT_DOCS",
      "kind": "task",
      "title": "Update audit search documentation",
      "outputContract": {
        "format": "markdown",
        "requiredArtifacts": ["operator docs"]
      }
    }
  ]
}
```

## Validation Boundary

A planner response must pass scheduler-side validation before it can become
graph state. Validation should check at least:

- The response is an object with `kind` equal to `task`, `series`, or
  `parallel`.
- `task` responses do not require children; `series` and `parallel` responses
  provide at least one child proposal.
- Child proposals have non-empty titles and supported proposed kinds. Nested
  child proposals are supported for initial goal graphs when every composite
  child is explicitly `kind: "series"` or `kind: "parallel"` and has at least
  one child.
- Planner-provided `id` values are deterministic, unique across the full
  materialized proposal tree, absent from the target graph, and accepted by the
  scheduler safe-token policy.
- Missing child ids are generated by scheduler code from stable inputs such as
  parent id, child index, and title, with collision handling and the same
  planner safe-token policy.
- The materialized graph is validated with the existing graph validator before
  the locked write is committed.

The planner safe-token policy is intentionally stricter than manual graph
authoring. Operators using manual/API `decompose` may use any non-empty string
ids that pass graph validation and reference nodes present after mutation.

Validation failure is terminal for that proposed mutation. The scheduler must
return inspectable diagnostics or a planning artifact, but it must not create
claimable work, start workers, or partially update the graph from invalid
planner output.

Validation errors use paths into the response object so planner adapters and
operators can fix the source:

```json
{
  "valid": false,
  "errors": [
    {
      "path": "$.children[1].id",
      "code": "duplicate-child-id",
      "message": "Child id AUDIT_UI already exists in graph.nodes.",
      "severity": "error"
    }
  ]
}
```

## Additive Node Metadata

Planner-created graph nodes may carry these optional fields. They are additive
metadata and must be preserved by graph reads and writes unless a future command
explicitly owns the field:

- `goal`: original goal text or a structured object with `text`, `source`, and
  optional timestamps.
- `planner`: planner provenance such as planner name, model, version, prompt
  reference, request id, and planning timestamp.
- `contextRefs`: file, URL, node, report, or git-ref pointers the planner used
  or wants the worker to inspect.
- `outputContract`: expected output format, required artifacts, acceptance
  criteria, or schema reference for the worker result.
- `resultSummary`: concise execution result metadata recorded after work is
  complete; planners may request the shape, but workers or reconciliation code
  should own final result content.

Unknown fields alongside these metadata objects remain allowed. The graph
format is intentionally extensible, and current graph validation preserves
unknown top-level, graph-level, and node-level metadata.

These additive fields do not change the minimum valid graph shape. A generated
graph is compatible when it can be replayed from `graph.root` and `graph.nodes`
through the ordinary scheduler commands, even if older consumers ignore every
planner metadata field. Conversely, consumers must not infer readiness or
execution approval from `planner.rationale`, `plannerDecision`,
`decompositionReason`, `contextRefs`, `outputContract`, or `resultSummary`;
those fields are audit and display metadata until a scheduler mutation owns a
state transition.
