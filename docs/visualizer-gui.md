# Visualizer GUI Documentation

This document defines the desired operator experience and GUI direction for the
local scheduler visualizer. The goal is to make the visualizer feel like a
scheduler and monitoring product instead of a generated debug page, while
preserving the existing local trust model, graph file source of truth, and
CLI-compatible mutation behavior.

Use this document when changing `scripts/visualizer-client.ts`,
`scripts/visualizer-payload.ts`, `scripts/sp-layout.ts`, or visualizer browser
tests.

## Product Direction

The visualizer should be an operator console for supervising a live plan graph.
It should help an operator answer these questions in the first few seconds:

- Is the plan healthy?
- What work is ready, active, blocked, failed, or done?
- Are workers running correctly?
- Which node needs attention first?
- What changed recently?
- What can I safely do next?

The UI should resemble scheduler, CI, workflow, and observability products:
dense, calm, information-rich, and optimized for repeated operational use.
Avoid marketing-style layout, decorative illustration, and oversized text.

## Completeness Standard

This document is not an exhaustive description of a perfect GUI. A perfect GUI
for scheduler operations is discovered by running real plans, watching where
operators hesitate, and tightening the workflow. This document is the target
operability contract: it describes the information hierarchy, default actions,
backend view-model requirements, and safety constraints that make the GUI worth
implementing.

Treat a GUI change as good only when it improves one of these outcomes:

- Time to identify the highest priority problem.
- Time to find the responsible node, worker, report, or lock.
- Confidence that the recommended action is safe.
- Ability to recover with the narrowest mutation.
- Ability to verify that an action changed the graph as intended.
- Ability to keep working during live updates without losing context.

Do not optimize for a visually impressive graph at the expense of triage speed.
The Work Queue and inspector are the operating surfaces; the graph is the
spatial map.

## Operability Principles

Optimal operability means the GUI makes the safe path the easy path under time
pressure. Design changes should follow these principles:

- Exception first: failed, blocked, expired, lock, and worker-error states are
  visible before graph exploration.
- One selected node: lists, graph, inspector, events, and actions all revolve
  around the same selected node.
- One recommended action: the GUI should usually present one strongest next
  action and move alternatives into secondary groups.
- Preserve context: live updates must not clear filters, scroll position,
  selected node, open drawers, or typed form input.
- Time is operational data: age, lease remaining, last update, and event time
  should be visible wherever they affect a decision.
- Recovery is deliberate: reset, fail, release, and reconcile actions require
  consequence copy and confirmation.
- No dead ends: every empty state should say whether the run is healthy,
  complete, waiting, blocked, or filtered.
- CLI parity: GUI mutations use the same routes, transition guards, and
  notification semantics as CLI commands.

## Operator Mental Model

The GUI should teach the scheduler model through layout rather than prose:

- The graph is the source of truth.
- Workers only claim ready leaf nodes.
- Running work holds a lease.
- Blocked and failed work needs operator attention.
- The safest operation starts by selecting a node, inspecting its detail, and
  choosing one contextual action.
- Broad recovery actions are available, but they are secondary to narrow node
  actions.

Operators should not need to understand every graph field to use the GUI. The
default screen should guide them from health, to attention, to selected node,
to action.

## Default Triage Path

The first screen should support one simple operating loop:

1. Read the run state banner.
2. Check the health strip.
3. Open the highest severity item in the Work Queue.
4. Inspect the selected node or worker.
5. Choose the safest contextual action.
6. Confirm the result in recent events.

When there are no attention items, the default path becomes:

1. Check whether workers are active.
2. If workers are idle and ready work exists, start workers or claim a ready
   node.
3. If no ready work exists, inspect diagnostics and graph completion state.

The page should select a useful node or worker by default:

- First failed node, if any.
- Else first blocked or review node.
- Else first expired active node.
- Else first worker error.
- Else first running node.
- Else first ready node.
- Else the graph root.

This default selection keeps the inspector useful immediately and reduces the
empty-state feel of the page.

## Status To Action Guide

Every status indicator should make the next likely operation clear.

| State | Meaning | Primary GUI action |
| --- | --- | --- |
| Ready | A leaf node can be claimed. | Claim node or start worker for this node. |
| Claimed | A worker owns the node but has not started execution. | Monitor, start, renew, or release after expiry. |
| Running | Work is executing under an active lease. | Monitor, renew, block, or fail with a reason. |
| Blocked | Worker needs an operator answer. | Answer question. |
| Review | Work is parked for operator review. | Inspect report, answer, decompose, or reset narrowly. |
| Failed | Work ended unsuccessfully. | Inspect report and recent events, then reset only the affected scope. |
| Done | Work completed. | Inspect result, Git footprint, or downstream readiness. |
| Expired lease | Claimed or running work stopped renewing. | Release expired lease or inspect worker before reset. |
| Stale lock | Graph lock appears abandoned. | Diagnose lock owner before manual recovery. |
| Worker error | Managed worker exited or failed. | Open log tail, fix configuration, then restart workers. |

Labels should use operator language first. Prefer `Answer`, `Retry node`,
`Start worker`, `Stop worker`, `Release expired`, and `Open report` over
internal labels. Internal terms such as lease, graph version, run id, and refs
belong in metadata rows or tooltips.

## Current Problems

The current visualizer has the right underlying data, but the layout presents
it as one long control page:

- Summary counts are small pills rather than a clear health model.
- Worker Manager controls dominate the sidebar before the operator sees the
  most urgent state.
- Ready work, active sessions, diagnostics, events, attention, and selected
  node details appear as separate card lists with repeated shapes.
- Node actions are present, but the state model and next safe action are not
  visually obvious.
- History is shown as compact text instead of a timeline.
- The graph view is functional but lacks monitoring affordances such as zoom,
  fit, selection state, legend, and status explanation.

The redesign should not change scheduler semantics. It should improve
information architecture, hierarchy, scanning, and confidence.

## Primary Workflows

### Supervise A Healthy Run

The operator lands on the page and sees:

- `Live` connection state.
- A quiet health strip with no failed, blocked, expired, or worker-error
  counts.
- Active workers and recent events updating.
- Ready work decreasing or active work progressing.

Expected actions:

- Open the `Active` Work Queue tab to monitor running nodes.
- Select a running node to inspect lease, session, run id, and logs.
- Open `Recent Events` to confirm progress.

### Start Available Work

When ready work exists and no worker is active, the GUI should make the next
step obvious:

- The `Ready` tile is non-zero.
- The `Workers` tile shows zero active workers.
- The `Ready` Work Queue tab lists claimable nodes in scheduler priority
  order.
- Primary call to action is `Start workers`.
- Row action allows `Claim node` or `Start worker for node`.

The worker-start configuration should open in a drawer with safe defaults and
advanced fields collapsed.

### Answer Blocked Work

Blocked work should be the most guided path:

- `Blocked` tile is highlighted.
- Attention queue shows the question.
- Selecting the item opens the node inspector.
- Inspector header shows the blocked state, session, run id, and question.
- Primary action is `Answer`.
- After submit, the recent event stream shows the answer event and the node
  returns to ready or active state according to scheduler rules.

### Inspect Failed Work

Failure handling should slow the operator down enough to avoid broad resets:

- `Failed` tile is highlighted as critical.
- Attention queue shows failure reason and report path.
- Inspector opens to Overview with failure reason and report link.
- Timeline shows the failed event and preceding run events.
- Primary action is `Open report`.
- Recovery actions are grouped below inspection actions and require
  confirmation.

### Recover Expired Work

Expired work should distinguish release from reset:

- Attention queue shows expired lease age and releasable count.
- Inspector shows last session, run id, lease expiry, and related worker state.
- Primary action is `Release expired lease` when diagnostics says it is
  releasable.
- Reset remains secondary and confirmed.

### Review Git Output

For completed or running nodes with Git metadata:

- Inspector `Git` tab shows base, work, output, and integration refs.
- Diffstat is visible before the changed-file list.
- `Open diff` and `Compare` appear only when enough remote/ref metadata exists.
- Missing compare metadata is explained in one short row.

## Information Architecture

The app should use a stable operator-console structure. The primary desktop
layout is a three-pane cockpit: work queue, graph, and inspector. This is more
operable than a graph-first page because the queue tells the operator where to
look before they pan or search the graph.

```text
[Top Bar: plan title | live status | graph version | token state | last update]

[Run State Banner: needs attention / ready to run / running / complete / idle]

[Failed] [Blocked] [Expired] [Ready] [Running] [Done] [Workers] [Lock]

+-------------------+ +--------------------------------------+ +------------------+
| Work Queue        | | Graph Workbench                      | | Node Inspector   |
| Attention         | | search, filters, zoom, fit, legend   | | Overview         |
| Ready             | | live DAG / series-parallel graph     | | Actions          |
| Active            | | selected and attention states        | | Timeline         |
| Workers           | |                                      | | Git / Logs       |
+-------------------+ +--------------------------------------+ +------------------+

[Events] [Diagnostics]
```

The Work Queue should remain visible in the first viewport. Events and
diagnostics may sit below the cockpit or behind tabs because they are
supporting evidence, not the first navigation surface.

### Top Bar

The top bar should stay visible at the top of the page and show:

- Product name: `Plan Graph Scheduler`
- Graph title from `payload.summary.title`
- Graph version from `payload.summary.graphVersion`
- Total node count from `payload.summary.totalNodes`
- Live connection state: `connecting`, `live`, `reconnecting`, or `offline`
- Write token state: `local writes`, `token set`, or `read-only`
- Last update timestamp, derived client-side when a payload is rendered

Top bar actions should be compact and operational:

- Refresh
- Reconcile
- Release expired leases
- Start workers

Mutating actions must continue to use existing write-token behavior and server
mutation routes.

Use disabled states instead of hiding important global actions. A disabled
button with a short reason is more intuitive than a disappearing action.

### Run State Banner

Add a one-line banner below the top bar that summarizes what the operator
should do next. The banner should be derived from existing payload fields and
should not introduce new scheduler state.

| Banner state | Condition | Example text |
| --- | --- | --- |
| Needs attention | Failed, blocked, expired, stale lock, or worker error exists. | `Needs attention: 1 failed node and 2 blocked nodes.` |
| Ready to run | Ready work exists and no workers are active. | `Ready work is available. Start workers or claim a node.` |
| Running | Workers or active nodes exist and no attention item exists. | `Running: 3 active nodes across 2 workers.` |
| Complete | All nodes are done. | `Plan complete. Review results and Git output.` |
| Idle | No ready work, no active work, and not complete. | `No ready work. Inspect diagnostics or blocked parent state.` |

The banner should include one primary action when appropriate, such as
`Open attention`, `Start workers`, or `View diagnostics`.

### Health Strip

Replace small summary pills with a full-width status strip. Each tile should be
clickable and apply the matching filter. The tile order should match the
operator triage order: critical state first, then runnable work, then
completion and system health.

| Tile | Source | Click behavior |
| --- | --- | --- |
| Failed | `attention.failed.count` | Show failed nodes |
| Blocked | `attention.blocked.count` | Show blocked and review nodes |
| Expired | `attention.expired.count` | Show expired active nodes |
| Ready | `payload.ready.length` | Show ready nodes |
| Running | `summary.counts.running + summary.counts.claimed` | Show active nodes |
| Done | `summary.counts.done` | Show completed nodes |
| Workers | `workerManager.running / workerManager.retainedWorkers` | Show workers |
| Lock | `diagnostics.lock` | Show diagnostics |

Use color as a status cue, not as decoration. A healthy plan should look quiet.
Blocked, failed, expired, and worker-error states should stand out immediately.
Counts should use tabular numerals and include short labels such as `failed`,
`blocked`, and `ready`; avoid long explanatory text inside tiles.

The `Workers` tile should include an error indicator when
`attention.workerErrors.count` is non-zero. The `Lock` tile should distinguish
`clear`, `present`, and `stale`.

### Work Queue

The Work Queue is the primary navigation panel. It should combine the current
`Ready Leaf Nodes`, `Active Sessions`, `Worker Manager`, and attention lists
into one predictable queue with tabs:

- `Attention`
- `Ready`
- `Active`
- `Workers`

The default tab should be selected by state:

- `Attention` when any attention item exists.
- Else `Ready` when ready work exists and no active worker is running.
- Else `Active` when claimed or running work exists.
- Else `Workers` when managed worker state exists.

Each row should select a node or worker and update the inspector. Rows should
show compact state, title, age, owner, and recommended action. Avoid putting
long forms in the queue; actions that need fields open the Action Drawer.

### Graph Workbench

The graph remains the spatial map of the plan, but it is not the first triage
surface. It should support:

- Search across node id, title, status, session, path, result, and log text
- Segmented filters: `All`, `Attention`, `Ready`, `Active`, `Done`
- Zoom controls: fit, zoom in, zoom out, reset
- A small legend for status colors
- Node hover state
- Strong selected-node outline
- Attention-node pulse or left rail, used sparingly
- Empty and loading states that keep the layout stable

The SVG generated by `scripts/sp-layout.ts` may remain the graph renderer. The
first redesign should improve CSS, selection, and controls before replacing the
layout engine.

The graph should not be the only way to operate the scheduler. Large graphs can
be hard to scan visually, so every graph action should also be reachable from a
table or inspector action.

### Node Inspector

The selected node should render in a sticky right-side inspector. It replaces
the current long sidebar detail block.

Tabs:

- `Overview`: status, title, kind, goal, result, output contract, children
- `Actions`: server-computed actions, confirmations, required fields
- `Timeline`: newest-first history with event, time, session, run id, details
- `Git`: refs, diffstat, changed files, compare links
- `Logs`: related worker log tail when available

The inspector should always start with a status header:

```text
[running] IMPLEMENT
Inspect changed files
session codex-git / run run_git_metadata
lease expires in 17m
```

Actions should be grouped by risk:

- Recommended action: answer blocked work, open failed report, claim ready
  work, start selected worker, or release expired lease
- Secondary action: renew, block, decompose, compare Git refs
- Recovery action: reset node, reset subtree, reset reachable, fail node

The recommended action should be visually strongest and singular whenever
possible. Secondary and recovery actions should not compete with it.

Dangerous actions must remain confirmed and routed through the same mutation
guards as CLI commands.

### Recommended Action Rules

The inspector should compute a single recommended action from the selected
node and supporting diagnostics. Use this order:

1. Failed node: `Open report`. Show reset only after inspection actions.
2. Blocked or review node with a question: `Answer`.
3. Expired lease that diagnostics marks releasable: `Release expired lease`.
4. Ready node: `Claim node` or `Start worker for node`.
5. Running or claimed node: `Monitor run`; secondary actions are `Renew`,
   `Block`, and `Fail`.
6. Done node with Git metadata: `Open diff` or `Review result`.
7. Parent node: `Inspect children`.

When multiple actions are possible, the recommended action should be the one
that preserves the most graph state and has the smallest blast radius.

### Action Drawer

Actions that need more than one field should open a focused drawer or modal
instead of expanding large forms inline. The drawer should include:

- Action name and selected node id.
- One-sentence consequence statement.
- Required fields first.
- Advanced or optional fields collapsed.
- Confirmation text for recovery actions.
- Server error area near the submit button.

Examples:

- `Answer blocked node`: answer text, responder.
- `Start workers`: count, session prefix, repository, advanced options.
- `Reset node`: reason, affected-node preview, confirmation.
- `Decompose`: kind, child rows, preview.

Recovery drawers should show the exact scope before submission:

- Reset node: selected node id and fields that will be cleared.
- Reset subtree: selected root and affected descendant count.
- Reset reachable: selected node and affected reachable count.
- Release expired leases: node ids and lease owners.
- Reconcile: summary of statuses that may change.

### Navigation Labels

Use stable labels across the GUI:

- `Graph`
- `Attention`
- `Ready`
- `Active`
- `Workers`
- `Events`
- `Node Inspector`

Avoid having both `Diagnostics` and `Triage` as separate primary labels. The
operator should not have to decide which one contains urgent work. Diagnostics
can live inside Attention or as a system-health panel.

### Empty States

Empty states should tell the operator what the absence means:

- No attention: `No failed, blocked, expired, or worker-error items.`
- No ready work: `No ready leaf nodes. Active, blocked, or unfinished parent
  work may still exist.`
- No active runs: `No claimed or running nodes. Start workers when ready work
  exists.`
- No workers: `No managed workers are running from this console.`
- No events: `No graph history events are available yet.`

Avoid generic messages such as `No items match` unless a search filter is
active.

### Queue And Evidence Tables

Use tables for scan-heavy monitoring surfaces. Cards may still be used for
modal content and compact repeated alert items, but status lists should become
tables. The Work Queue may use dense rows instead of a full table on narrow
screens, but it should preserve the same columns and sorting.

Active columns:

| Column | Content |
| --- | --- |
| Status | badge and age |
| Node | id and title |
| Session | session and run id |
| Lease | expiry or expired state |
| Worker | matching worker session when available |
| Last event | latest history event |
| Action | contextual button |

Ready columns:

| Column | Content |
| --- | --- |
| Priority | ready order |
| Node | id and title |
| Parent | nearest parent or path when available |
| Kind | task, series, parallel |
| Git | compact ref or diffstat when available |
| Action | claim or start worker |

Recent Events columns:

| Column | Content |
| --- | --- |
| Time | timestamp |
| Event | event name |
| Node | node id |
| Session | session or responder |
| Detail | compact redacted details |

Tables should support search filtering, stable row heights, and row click to
select the node.

Table rows should use consistent density. Keep titles to one or two lines,
truncate long paths in the middle, and expose full values through tooltips or
the inspector.

### Attention Queue

The attention queue should be the first Work Queue tab and should be visible in
the first viewport whenever attention exists. It should combine failed nodes,
blocked/review nodes, expired leases, stale locks, and worker errors in one
triage list.

Each item should show:

- Severity
- Affected node or worker
- Reason or question
- Age
- Recommended next action
- Link to selected node detail

Recommended action text should be conservative. It should point to the next
diagnostic or narrow mutation, not imply that broad resets are routine.

Severity order:

1. Failed nodes.
2. Stale locks.
3. Expired leases.
4. Blocked or review nodes.
5. Worker errors.
6. Warnings from diagnostics.

Within the same severity, sort newest first when the operator is debugging a
recent regression, and oldest first when work has been waiting for attention.
The initial implementation may use a stable deterministic sort, but the chosen
sort should be visible in the panel label.

### Worker Manager

Worker Manager should become the `Workers` tab in the Work Queue plus a `Start
workers` drawer or modal.

Default panel:

- Running workers
- Stopping workers
- Exited workers
- Error workers
- Last failure
- Stop buttons for active workers
- Log tails in collapsed rows

Start drawer:

- Worker count
- Session prefix
- Repository
- Isolation
- Retention
- Command
- Args
- Idle milliseconds
- Remote and workspace root
- Quiet and once toggles

Advanced fields should be collapsed by default. The default view should feel
like monitoring worker health, not configuring a process launcher.

## Visual Design System

The visual style should be quiet and technical:

- Background: near-white gray
- Surface: white
- Text: high-contrast neutral
- Borders: subtle gray
- Accent: restrained blue or teal for selected and primary action states
- Success: green
- Running: blue
- Blocked or warning: amber
- Failed or critical: red
- Pending: neutral gray

Use tabular numerals for counts, short uppercase labels for dense metadata,
and regular sentence case for human-readable titles.

Recommended token shape:

```css
:root {
  --bg: #f8fafc;
  --surface: #ffffff;
  --surface-muted: #f1f5f9;
  --text: #0f172a;
  --text-muted: #64748b;
  --line: #d9e2ec;
  --accent: #2563eb;
  --success: #15803d;
  --running: #2563eb;
  --warning: #b45309;
  --danger: #b91c1c;
  --pending: #64748b;
}
```

Do not let one hue dominate the product. Status colors should appear in badges,
thin rails, graph strokes, and alert states rather than large saturated panels.

## Interaction Rules

- Clicking a graph node selects it and opens the inspector.
- Clicking a table row selects the node and scrolls or highlights the graph
  node when possible.
- Clicking a health tile applies a filter.
- Clicking a Work Queue row selects the node or worker and keeps the queue
  visible.
- Search filters all primary surfaces consistently.
- Mutating actions show pending state until the request completes.
- Failed requests appear in a persistent error area near the triggering
  control and in the top status message.
- SSE reconnect states should be visible but not alarming unless updates stop.
- Keyboard focus must be visible on graph controls, table rows, and action
  buttons.
- Escape closes modal and drawer surfaces.
- Enter submits only when focus is inside a form that has no multiline text
  area, or when the submit button is focused.
- Refresh should preserve the selected node and filters when that node still
  exists.
- Live updates should not steal selection unless the selected node disappears;
  if it disappears, choose the next default selection and announce why.

## Data Mapping

The current visualizer payload already supports most of the redesign:

| UI need | Existing payload field |
| --- | --- |
| Health counts | `summary.counts`, `attention` |
| Graph title and version | `summary.title`, `summary.graphVersion` |
| Graph rendering | `graphSvg` |
| Node inspector | `nodes` |
| Ready work | `ready` |
| Active work | `working` |
| Diagnostics and lock state | `diagnostics` |
| Recent events | `recentEvents` |
| Worker health | `workerManager` |
| Git inspector | `nodes[].git`, `nodes[].gitFootprint` |
| Available node actions | `nodes[].actions`, `actionPolicy` |
| Run state banner | `runState` |
| Work Queue | `workQueue` |
| Initial inspector selection | `defaultSelection` |
| Per-node UI helpers | `nodeUi` |

Only add payload fields when the browser cannot derive the display safely or
consistently. Additive payload fields are preferred over changing existing
field names.

## Backend Bottleneck

The backend bottleneck is not mutation routing or CSS. The bottleneck is the
lack of a server-computed operational view model.

Today, `buildVisualizerPayload` returns useful raw ingredients: graph SVG,
normalized nodes, ready nodes, working nodes, diagnostics, attention counts,
recent events, action availability, and worker-manager state. That is enough
for a debug page, but an optimal operator console needs the backend to assemble
the same facts into queue rows, selected defaults, recommended actions, run
state, worker-to-node links, and recovery previews.

If the browser derives those pieces independently, it will duplicate scheduler
logic and drift from the CLI, diagnostics, mutation guards, and tests. The
server already owns the authoritative graph read, diagnostics, action map,
events, and worker status in one place. Therefore the most important backend
change is to add an additive visualizer view model to `VisualizerPayload`,
built in `scripts/visualizer-payload.ts` and typed in `scripts/contracts.ts`.

### Required View Model

Additive fields should be introduced without removing the existing payload
shape. Suggested top-level payload additions:

- `runState`: banner state, severity, message, primary action, and reason.
- `workQueue`: ordered queue sections for `attention`, `ready`, `active`, and
  `workers`.
- `defaultSelection`: selected node id or worker id plus selection reason.
- `nodeUi`: per-node display helpers such as parent path, latest event, age,
  lease remaining, and recommended action id.
- `workerUi`: per-worker display helpers such as active-node correlation,
  age, last event, and recommended action id.
- `recoveryPreviews`: affected-node counts and ids for reset, release-expired,
  and reconcile actions when cheap to compute.
- `graphUi`: selected and attention node ids, layout bounds, and fit-to-screen
  hints.

The backend does not need to persist these fields. They are derived from the
graph file, diagnostics, worker manager, and event export at response time.

### View Model Rules

The view model should be boring and deterministic:

- Use the same readiness helpers as `ready`, `claim`, and diagnostics.
- Use the same action availability map as node actions.
- Use the same attention source as diagnostics.
- Use the same redaction path as node details and events.
- Sort queues predictably and document the sort.
- Return disabled reasons and fallback text rather than making the browser
  guess.
- Keep server mutation guards authoritative even when the view model recommends
  an action.

The Phase 0 queue sort is deterministic and intentionally simple:

- `workQueue.attention`: failed nodes, stale lock, expired leases,
  blocked/review nodes, worker errors. Node groups use diagnostics order;
  worker errors sort by worker id.
- `workQueue.ready`: scheduler ready priority order, matching `payload.ready`.
- `workQueue.active`: existing working-node order, filtered to claimed and
  running nodes.
- `workQueue.workers`: error, running, stopping, exited, then worker id.

This ordering is an operability contract for the browser, not a claim that the
GUI is finished. Future changes can adjust ranking when operator evidence
justifies it, but the browser should continue to consume a server-computed
queue instead of recreating scheduler logic.

### Minimum Backend Slice

The smallest backend slice that unblocks optimal operability is:

- `runState`.
- `workQueue.attention`, `workQueue.ready`, and `workQueue.active`.
- `defaultSelection`.
- `nodeUi[id].recommendedAction`.
- `nodeUi[id].latestEvent`.
- `nodeUi[id].parentPath`.
- `nodeUi[id].leaseRemainingMs` when a lease exists.

With those fields, Phase 1 can produce the cockpit layout without duplicating
the scheduler's triage logic in browser code.

Useful later payload additions:

- Worker-to-node correlation when a worker has an active node.
- Graph layout bounds for fit-to-screen behavior.
- Recovery action affected-node preview counts.
- Timeline grouping for long histories.
- Per-node stale-data warnings when worker status and graph state disagree.

## Security And Compatibility

The GUI must preserve the documented visualizer trust model:

- Loopback remains the default.
- Non-loopback write routes still require a token or explicit unsafe mode.
- Read routes remain disclosure-sensitive.
- The graph JSON file remains the source of truth.
- Browser action availability is advisory; server mutation guards remain
  authoritative.
- GUI mutations must use the same routes and state transitions as CLI
  commands.

Do not introduce local storage for sensitive graph data. Storing non-sensitive
operator preferences such as collapsed sections or worker defaults is allowed.

## Accessibility

The GUI should be usable without precise pointer interaction:

- All controls must be keyboard reachable.
- Focus states must be visible.
- Status must not rely on color alone.
- Tables need real headings and accessible row labels.
- The graph viewport needs a text summary and selected-node announcement.
- Modal dialogs need focus management and escape/close behavior.
- Live updates should use polite announcements for meaningful state changes,
  not every SSE payload.

## Responsive Behavior

Desktop is the primary target. Mobile and narrow windows should remain usable
for inspection and emergency operations.

Desktop:

- Top bar
- Run state banner
- Health strip
- Three-column cockpit: Work Queue, graph, inspector
- Events and diagnostics below or in secondary tabs

Narrow width:

- Health strip wraps to two rows
- Work Queue appears before graph
- Inspector becomes a drawer below the graph or a full-width panel
- Tables remain horizontally scrollable with sticky first columns when useful
- Worker start drawer uses one-column fields

## Implementation Phases

### Phase 0: Backend Operational View Model

- Add additive payload contracts for `runState`, `workQueue`,
  `defaultSelection`, and `nodeUi`.
- Build those fields in `scripts/visualizer-payload.ts` from existing graph,
  diagnostics, actions, events, ready, working, and worker-manager state.
- Keep current payload fields intact for compatibility.
- Add contract tests for queue ordering, run-state selection, default
  selection, recommended actions, and latest-event derivation.

Acceptance:

- Browser code can render the Work Queue and run state banner without
  reimplementing scheduler readiness, diagnostics, or action-priority logic.
- Existing API consumers still receive the old payload fields.

### Phase 1: Shell And Monitoring Hierarchy

- Add top bar with live state, graph version, node count, token state, and last
  update.
- Add run state banner.
- Replace summary pills with the health strip.
- Add Work Queue tabs for Attention, Ready, Active, and Workers.
- Move Worker Manager configuration into a modal or drawer.
- Convert current Active Sessions, Ready Leaf Nodes, and Recent Events into
  tables or dense queue rows.
- Keep the existing SVG renderer.

Acceptance:

- The first viewport clearly shows health, run state, work queue, graph,
  selected node, and attention state.
- Worker configuration no longer dominates the page.
- Existing visualizer browser tests still pass after selector updates.

### Phase 2: Inspector And Actions

- Replace selected node detail with a sticky inspector.
- Add tabs for Overview, Actions, Timeline, Git, and Logs.
- Add recommended action rules.
- Render history as a timeline.
- Use server-computed action metadata to show contextual action groups.
- Keep dangerous recovery actions confirmed with affected-scope previews.

Acceptance:

- Selecting any node gives an operator a clear state summary and next actions.
- Git and history metadata are easier to scan than the current text block.

### Phase 3: Graph Workbench

- Improve graph node styling, status rails, selected state, and hover state.
- Add zoom, fit, reset, and legend controls.
- Connect table-row selection to graph selection.
- Add stable empty/loading/error states.

Acceptance:

- The graph remains legible for representative plans on desktop and narrow
  viewports.
- Selected and attention nodes are visually unambiguous.

### Phase 4: Operational Polish

- Add saved display preferences for non-sensitive UI state.
- Add latest-event and parent-path payload helpers if needed.
- Add worker-to-node correlation where available.
- Add recovery affected-node preview counts where useful.
- Improve screenshots and browser tests to cover the main operational flows.

Acceptance:

- Browser screenshots resemble a scheduler or monitoring console.
- Triage, worker start/stop, blocked answer, failure inspection, and graph
  filtering are covered by tests.

## Test Expectations

Changes to the GUI should update or add tests in `tests/visualizer-browser.test.mjs`
and focused renderer tests when static HTML expectations change.

At minimum, verify:

- Page loads and receives SSE updates.
- Run state banner selects the correct state for attention, ready, running,
  complete, and idle scenarios.
- Health strip reflects payload counts.
- Work Queue default tab follows the documented state priority.
- Search and filters affect graph-related lists and queue rows.
- Node selection updates inspector content.
- Recommended action changes with node status.
- Mutating actions still call protected write routes.
- Recovery actions show affected-scope preview or documented fallback text.
- Worker start/stop controls still work.
- Desktop and narrow viewports do not overlap text or controls.
- Rendered graph is non-empty and selected nodes remain visible.

When the visual design changes materially, capture browser screenshots during
manual review or test artifact generation and inspect both desktop and narrow
layouts.
