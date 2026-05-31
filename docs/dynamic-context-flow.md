# Dynamic Context Flow

Dynamic planning context is the bounded scheduler-owned payload that helps a
planner or worker understand already completed adjacent work without embedding
large reports or relying on unfinished parallel siblings.

## Selection Rules

- `self`: Always include a compact summary of the requested node.
- `root`: Include the graph root when the requested node is not the root.
- `parents`: Include the stable root path parents, excluding the root entry
  already represented by `root`.
- `seriesPredecessors`: For every series ancestor on the stable root path,
  include completed child subtrees that appear before the path child. This lets
  a later series child see prior completed siblings and prerequisite decisions.
- `completedSiblings`: For the direct parent, include completed siblings only.
  Parallel children never receive unfinished sibling outputs as context.
- `explicitRefs`: Preserve the requested node's `contextRefs` as references,
  but do not dereference file, URL, report, or git-ref bodies in this payload.
- `reports`: Include only selected nodes that have `report` or
  `resultSummary.report`. The payload carries report paths and summaries, not
  report bodies.

The default selector is intentionally small: 12 context nodes with each
`resultSummary.summary` capped at 400 characters. When the cap is exceeded, the
payload records omitted node ids in `selection.omittedNodeIds`.

## `resultSummary` Contract

Nodes may store a compact result summary after human or worker completion:

```json
{
  "status": "done",
  "summary": "Defined the API contract and migration constraints.",
  "artifacts": ["docs/api-contract.md"],
  "report": "reports/API_CONTRACT.md",
  "outputRef": "refs/heads/spg/node/API_CONTRACT/run-123",
  "completedAt": "2026-05-31T00:00:00.000Z",
  "updatedAt": "2026-05-31T00:00:00.000Z"
}
```

`summary` is required. `artifacts`, `report`, and `outputRef` are references,
not embedded artifact contents. The visualizer can show the same object in node
details, and prompts can safely consume it through the dynamic context payload.

## Prompt And Planner Fields

Planner requests include:

- `parentContext`: the existing parent/node metadata shape, now with
  `parentContext.relevantContext` for compatibility with parent-oriented
  prompt sections.
- `relevantContext`: the canonical dynamic payload for the requested node.

Prompt templates receive:

- `{{relevantContextJson}}` in `prompts/planner-decompose-task.md`.
- `{{relevantContextJson}}` in `prompts/codex-worker-task.md`.

Consumers should prefer `relevantContext` over scanning the whole graph. If a
planner needs full details for a referenced report or artifact, it should
propose a task that explicitly inspects that artifact rather than requiring the
scheduler to inline it.
