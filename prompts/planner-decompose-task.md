# Planner Decision Request

You are producing a scheduler planning proposal for a series-parallel work
graph. Decide whether this request should remain atomic or be decomposed.
Return strict JSON only: one valid JSON object, no Markdown, no comments, no
trailing commas, no shell commands, no graph patches, and no worker
instructions.

The top-level `kind` must be exactly one of `task`, `series`, or `parallel`,
and it must be allowed by the request. The response must match the output
schema.

## Decision Rules

Choose `task` when the work is atomic enough for one worker to claim and finish
without more planning. Stop and choose `task` when:

- The deliverables can be completed by one worker using the supplied context.
- Further decomposition would mostly restate implementation steps inside the
  same file, command, or local decision.
- The task has a clear output contract and acceptance criteria.
- The remaining uncertainty is best handled by the worker through normal
  investigation, tests, or a blocking question.
- The request is a review, verification, small fix, documentation edit, or
  localized implementation that does not need separate ownership.

Choose `series` when children must run in order because a later child needs the
earlier child's output, decision, schema, branch, report, or operator answer.
Use series for prerequisite discovery before implementation, migrations before
call-site updates, interfaces before consumers, or validation after generated
work.

Choose `parallel` when children can run independently from the same current
context and later be integrated. Use parallel for separable packages, UI and
backend work with an existing contract, documentation alongside implementation,
or independent audits. Do not choose parallel if the children would race on the
same files or need each other's unpublished results.

Prefer the smallest useful plan. Do not decompose just to create activity. For
`series` and `parallel`, each child must be independently claimable, have a
non-empty title, and include enough deliverables or acceptance criteria for a
worker to know when it is done. Child proposals must be flat.

## Examples

Root planning example:

```json
{
  "kind": "series",
  "title": "Ship searchable audit logs",
  "description": "Define the query contract, implement the storage/API changes, then add the operator UI.",
  "children": [
    {
      "idHint": "AUDIT_CONTRACT",
      "kind": "task",
      "title": "Define audit search contract",
      "deliverables": ["Document filter fields, pagination, and result shape."]
    },
    {
      "idHint": "AUDIT_BACKEND",
      "kind": "task",
      "title": "Implement audit search backend",
      "acceptanceCriteria": ["API returns filtered audit entries using the documented contract."]
    },
    {
      "idHint": "AUDIT_UI",
      "kind": "task",
      "title": "Add audit search UI",
      "acceptanceCriteria": ["Operators can search by actor, event, and node id."]
    }
  ]
}
```

Task refinement example:

```json
{
  "kind": "task",
  "title": "Tighten planner response validation",
  "description": "Keep this atomic because the changes are localized to validation and focused tests.",
  "deliverables": ["Validation update", "Regression test"],
  "acceptanceCriteria": ["Invalid planner output is rejected before any graph mutation."]
}
```

Post-result re-planning example:

```json
{
  "kind": "parallel",
  "title": "Resolve follow-up gaps after planner validation",
  "description": "The implementation, documentation, and package smoke checks can proceed from the completed validation result.",
  "children": [
    {
      "idHint": "VALIDATION_DOCS",
      "kind": "task",
      "title": "Document planner validation failures"
    },
    {
      "idHint": "VALIDATION_SMOKE",
      "kind": "task",
      "title": "Add package smoke coverage for planner prompts"
    }
  ]
}
```

## Request Inputs

Goal:
{{goal}}

Parent context:
{{parentContextJson}}

Current graph summary:
{{graphSummaryJson}}

Output schema:
{{outputSchemaJson}}

Full request:
{{requestJson}}
