# Scheduler Runbook

This runbook covers operational recovery for a local series-parallel graph
scheduler run. The graph file is the source of truth; prefer read-only
diagnosis before mutating state, and keep important graph files under version
control or backed up before broad resets.

Examples use `./plan-improve.graph.json` as a graph-relative path from the
repository root. Replace it with the graph you are operating.

## Baseline Triage

Start with the commands that do not mutate the graph:

```bash
npm run summary -- --graph ./plan-improve.graph.json
node scripts/plan-scheduler.mjs diagnostics --graph ./plan-improve.graph.json
node scripts/plan-scheduler.mjs ready --graph ./plan-improve.graph.json
```

Use `diagnostics` first when workers appear idle. It reports active and expired
leases, blocked or failed nodes, lock state, next-ready work, and suggested
actions. If a command fails and the terse message is not enough, rerun it with
`SPG_DEBUG=1` to include a stack trace:

```bash
SPG_DEBUG=1 node scripts/plan-scheduler.mjs diagnostics --graph ./plan-improve.graph.json
```

## No Ready Work

Symptoms:

- `No ready nodes to claim in graph ...`
- `Node is not ready to claim: NODE in graph ...`
- Worker output returns `{ "idle": true, ... }` when run with `--once`.

Diagnosis:

```bash
node scripts/plan-scheduler.mjs diagnostics --graph ./plan-improve.graph.json
node scripts/plan-scheduler.mjs summary --graph ./plan-improve.graph.json
```

Recovery:

1. If diagnostics lists expired `claimed` or `running` leases, release only
   those auto-releasable leases:

   ```bash
   node scripts/plan-scheduler.mjs release-expired --graph ./plan-improve.graph.json
   ```

2. If diagnostics lists blocked work, answer the operator question or reset the
   node if the old work should be discarded:

   ```bash
   node scripts/plan-scheduler.mjs answer --graph ./plan-improve.graph.json --node TEN36 --answer "Proceed with option A." --responder jason
   node scripts/plan-scheduler.mjs reset --graph ./plan-improve.graph.json --node TEN36 --reason "retry after operator decision"
   ```

3. If diagnostics lists failed work, inspect the node report first, then reset
   only the retry scope:

   ```bash
   node scripts/plan-scheduler.mjs reset --graph ./plan-improve.graph.json --node TEN36 --reason "retry after fixing failed check"
   ```

4. If all children of an internal node are done but the parent is not, reconcile
   completed subtrees:

   ```bash
   node scripts/plan-scheduler.mjs reconcile --graph ./plan-improve.graph.json
   ```

## Stale Leases And Worker Crashes

Symptoms:

- A worker process exited but its node remains `claimed` or `running`.
- `diagnostics` shows an expired lease with `releasable: true`.
- `claim` finds no work even though a worker is known to be gone.

Diagnosis:

```bash
node scripts/plan-scheduler.mjs diagnostics --graph ./plan-improve.graph.json
```

Recovery:

```bash
node scripts/plan-scheduler.mjs release-expired --graph ./plan-improve.graph.json
node scripts/plan-scheduler.mjs ready --graph ./plan-improve.graph.json
```

`release-expired` only clears expired leases on `claimed` and `running` nodes
and returns them to `pending`. It does not clear blocked, review, failed, done,
or custom-status work. For those statuses, inspect the node and choose
`answer`, `reset`, or `renew` explicitly.

## Stale Graph Temp Files

Symptoms:

- Files named like `.<graph-name>.<pid>.<timestamp>.<uuid>.tmp` are present next
  to the graph.
- The graph JSON still parses successfully, but a previous scheduler command
  failed during an atomic write before `rename`.

Recovery:

1. Confirm the canonical graph file is readable:

   ```bash
   node scripts/plan-scheduler.mjs summary --graph ./plan-improve.graph.json
   ```

2. Check whether any same-host writer process from the temp filename is still
   running:

   ```bash
   ps -p <pid> -o pid=,comm=,etime=
   ```

3. If the process is gone and no graph lock is held by a live owner, remove only
   the `*.tmp` files beside that graph. Do not replace the graph with temp-file
   contents; temp files may contain partial JSON from a failed write.

## Stale Graph Locks

Symptoms:

- `Timed out waiting for graph lock: <graph>.lock ...`
- The timeout message says to wait for the owner, run
  `diagnostics --graph ...`, or inspect `<graph>.lock/metadata.json`.
- `Failed to remove stale graph lock: <graph>.lock ...`

Diagnosis:

```bash
node scripts/plan-scheduler.mjs diagnostics --graph ./plan-improve.graph.json
cat ./plan-improve.graph.json.lock/metadata.json
```

The metadata includes `pid`, `host`, `createdAt`, `updatedAt`, `graphPath`,
`lockVersion`, and `ownerId` when available. First confirm whether the owner is
still running on the same host:

```bash
ps -p <pid> -o pid=,comm=,etime=
```

Recovery:

1. If the process is alive, wait for it to finish. Long graph mutations should
   keep the lock heartbeat fresh.
2. If the process is gone and diagnostics marks the lock stale, rerun the
   original scheduler command. The lock implementation will quarantine and reap
   stale locks when it can verify the observed owner.
3. Remove a lock directory manually only after confirming the owner process is
   gone, the host matches or is unreachable by design, and `updatedAt` is older
   than the stale threshold reported by diagnostics. The lock path is
   `<graph>.lock`; deleting the wrong lock can allow concurrent graph writes.
4. If a command reports a release failure or exits while leaving a lock behind,
   use the same metadata checks. A live owner lock must be left in place; stale
   lock cleanup relies on `ownerId`, `pid`, `host`, and `updatedAt` to avoid
   deleting another writer's lock.

Manual removal, when justified:

```bash
rm -rf ./plan-improve.graph.json.lock
```

Do not run concurrent workers from a shared network filesystem unless the mount
provides coherent atomic `mkdir`, same-directory `rename`, and directory
`mtime` visibility. Local macOS and Linux filesystems are the supported
concurrent-worker target.

## Failed Workers

Symptoms:

- Node status is `failed`.
- Worker report contains `Exit code`, `Signal`, `Error`, `Stdout`, or `Stderr`
  sections.
- `spawn codex ENOENT` appears in a worker report.

Diagnosis:

```bash
node scripts/plan-scheduler.mjs diagnostics --graph ./plan-improve.graph.json
sed -n '1,220p' reports/TEN36-run-example.md
```

Recovery:

- For `spawn codex ENOENT`, install the Codex CLI in the worker environment or
  run with a known command:

  ```bash
  npm run worker -- --graph ./plan-improve.graph.json --session codex-A --once --cwd "$PWD" --codex-command node --codex-arg=-e --codex-arg="process.exit(0)"
  ```

- For non-zero exits, inspect the report, fix the underlying repository or
  environment problem, then reset the failed node:

  ```bash
  node scripts/plan-scheduler.mjs reset --graph ./plan-improve.graph.json --node TEN36 --reason "retry after fixing worker failure"
  ```

- If a child process completed the task but the scheduler could not finalize
  because the node state changed, inspect the report note `node state was
  changed by the Codex run`, then either leave the newer state alone or reset
  deliberately.

## Blocked Nodes

Symptoms:

- Node status is `blocked` or `review`.
- Diagnostics action says `Answer or reset ... blocked/review node(s).`
- Worker asked a question through `block --question`.

Diagnosis:

```bash
node scripts/plan-scheduler.mjs diagnostics --graph ./plan-improve.graph.json
```

Recovery:

```bash
node scripts/plan-scheduler.mjs answer --graph ./plan-improve.graph.json --node TEN36 --answer "Use the existing CLI behavior." --responder jason
node scripts/plan-scheduler.mjs ready --graph ./plan-improve.graph.json
```

`answer` clears the lease and returns the leaf to `pending`. If the question is
obsolete or the blocked attempt should not continue, use `reset` instead.

## Git-Isolated Worker Clones And Refs

Use this section for workers started with `--isolation git`. The graph remains
the source of truth; reports, clone directories, and Git refs are evidence for
inspection, not independent scheduler state.

Default isolated paths are graph-directory relative:

```text
runs/git/cache/repo.git
runs/workspaces/<safe-session>/<safe-node-id>/<safe-run-id>
```

Treat those paths, generated reports, and Worker Manager log tails as sensitive
local artifacts. Reports and visualizer payloads redact credential-bearing
remote URLs, but they still contain repository paths, branch names, stdout,
stderr, task prompts, and failure details. Before sharing a report, graph file,
`plan.html`, or retained workspace with anyone outside the trusted operator
group, review it for source content and rotate any token that appeared
unredacted in older logs.

Do not archive or publish retained `runs/workspaces/*` clones as generic logs.
They are full source checkouts and may contain uncommitted changes, conflict
files, local Git config, and work products from failed or blocked workers.

Git isolation has no non-Git fallback. If `--isolation git` is selected, the
worker must use a Git remote, local bare cache, and per-run clone. Use
`--isolation off` for the legacy shared-cwd worker mode.

### Remote And Clone Setup Failures

Symptoms:

- `Worker isolation requires scheduler.remote ...`
- `Worker isolation remote fetch failed for <redacted-remote>: ...`
- `Worker isolation clone failed for <clone-path> from <bare-repo-path>: ...`
- A worker exits before claiming a node when `--isolation git` is enabled.

Diagnosis:

```bash
GRAPH=./plan-improve.graph.json
GRAPH_DIR=$(cd "$(dirname "$GRAPH")" && pwd)

node -e '
const fs = require("node:fs");
const graph = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
console.log(JSON.stringify({
  schedulerRemote: graph.scheduler?.remote,
  schedulerBaseRef: graph.scheduler?.baseRef
}, null, 2));
' "$GRAPH"

git --git-dir "$GRAPH_DIR/runs/git/cache/repo.git" rev-parse --is-bare-repository
git --git-dir "$GRAPH_DIR/runs/git/cache/repo.git" remote -v
```

Recovery:

1. Set a concrete Git remote on the graph, or pass a one-run override:

   ```json
   {
     "scheduler": {
       "remote": "git@github.com:example/repo.git"
     }
   }
   ```

   ```bash
   npm run worker -- --graph "$GRAPH" --session codex-A --once --isolation git --remote git@github.com:example/repo.git
   ```

   Do not use placeholder text, a normal source checkout path, or `--cwd` as an
   isolation substitute.

2. If fetch fails, verify network access and credentials with Git directly. Use
   the raw remote only in the shell command; reports and tickets should use the
   redacted remote from the worker error:

   ```bash
   git ls-remote git@github.com:example/repo.git HEAD
   git --git-dir "$GRAPH_DIR/runs/git/cache/repo.git" fetch --prune origin
   ```

3. If the cache path exists but is not a bare repository, stop isolated workers,
   quarantine only that cache path, and retry so the worker can recreate it:

   ```bash
   mv "$GRAPH_DIR/runs/git/cache/repo.git" \
     "$GRAPH_DIR/runs/git/cache/repo.git.quarantine.$(date +%Y%m%d%H%M%S)"
   npm run worker -- --graph "$GRAPH" --session codex-A --once --isolation git
   ```

4. If clone fails after claim because the per-run workspace already exists,
   inspect that exact path from the error or report, then quarantine only that
   final workspace directory. Do not remove the workspace root or bare cache.

Inspect a node without guessing its report, branch, or refs:

```bash
GRAPH=./plan-improve.graph.json
NODE=TEN36
GRAPH_DIR=$(cd "$(dirname "$GRAPH")" && pwd)

node scripts/plan-scheduler.mjs diagnostics --graph "$GRAPH"
node -e '
const fs = require("node:fs");
const graph = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const node = graph.graph.nodes[process.argv[2]];
if (!node) throw new Error(`unknown node ${process.argv[2]}`);
console.log(JSON.stringify({
  status: node.status,
  lease: node.lease,
  report: node.report,
  baseRef: node.baseRef,
  workRef: node.workRef,
  outputRef: node.outputRef,
  integrationRef: node.integrationRef
}, null, 2));
' "$GRAPH" "$NODE"
```

Read the report named by the graph before changing anything:

```bash
REPORT=$(node -e '
const fs = require("node:fs");
const graph = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
process.stdout.write(graph.graph.nodes[process.argv[2]]?.report || "");
' "$GRAPH" "$NODE")
test -n "$REPORT" && sed -n '1,260p' "$GRAPH_DIR/$REPORT"
```

The report for an isolated run must include the clone cwd, bare repository,
base ref, work ref, output ref, and resolved commits when known. Inspect the
clone and branch named there:

```bash
WORKSPACE=/absolute/path/from-report
git -C "$WORKSPACE" status --short --branch
git -C "$WORKSPACE" branch --show-current
git -C "$WORKSPACE" rev-parse --show-toplevel HEAD
git -C "$WORKSPACE" log --oneline --decorate -10
```

If the workspace was removed by retention policy, inspect the durable refs in
the local bare repository:

```bash
BARE="$GRAPH_DIR/runs/git/cache/repo.git"
REF=refs/heads/spg/node/TEN36/run_20260527_000000_TEN36_abc123
git --git-dir "$BARE" show-ref --verify "$REF"
git --git-dir "$BARE" log --oneline --decorate -10 "$REF"
```

### Blocked Parallel Merge Buffers

A blocked or review parallel parent must identify the exact composition base,
integration ref or workspace, child output ref, child order index, conflicted
paths when available, and report path. Start with graph metadata and the report:

```bash
GRAPH=./plan-improve.graph.json
PARENT=PARALLEL_1
GRAPH_DIR=$(cd "$(dirname "$GRAPH")" && pwd)

node -e '
const fs = require("node:fs");
const graph = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const node = graph.graph.nodes[process.argv[2]];
if (!node) throw new Error(`unknown node ${process.argv[2]}`);
console.log(JSON.stringify({
  status: node.status,
  children: node.children,
  report: node.report,
  baseRef: node.baseRef,
  outputRef: node.outputRef,
  integrationRef: node.integrationRef,
  question: node.question
}, null, 2));
' "$GRAPH" "$PARENT"
```

Then inspect the retained integration workspace named by the report:

```bash
WORKSPACE=/absolute/path/from-report
git -C "$WORKSPACE" status --short --branch
git -C "$WORKSPACE" diff --name-only --diff-filter=U
git -C "$WORKSPACE" log --oneline --decorate -10
```

To discard a conflicted attempt, abort the merge if one is in progress, then
quarantine only the exact integration workspace from the report:

```bash
git -C "$WORKSPACE" merge --abort
mkdir -p "$GRAPH_DIR/runs/workspaces-quarantine"
mv "$WORKSPACE" "$GRAPH_DIR/runs/workspaces-quarantine/$(basename "$WORKSPACE").$(date +%Y%m%d%H%M%S)"
node scripts/plan-scheduler.mjs reconcile --graph "$GRAPH"
```

The retry is deterministic: the scheduler must start from the same composition
base and merge child output refs in the parent node's `children` order. Do not
reset completed children unless their output refs are wrong. If a child output
must change, reset the smallest affected downstream scope with
`reset-reachable` from that child.

If a merge conflict is resolved manually in the retained integration workspace,
finish the Git merge in that workspace first, then rerun the documented scheduler
retry or reconciliation path so graph metadata records the parent output ref. Do
not mark the parent done by hand without preserving the integration ref, child
order, conflicted child, and report path.

### Isolated Cleanup

Never delete `runs/git/cache/repo.git`, a workspace, or an `spg/` ref while a
live worker can still reference it. First list active isolated ownership from
the graph:

```bash
GRAPH=./plan-improve.graph.json
node -e '
const fs = require("node:fs");
const graph = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
for (const [id, node] of Object.entries(graph.graph.nodes)) {
  if (!["claimed", "running", "blocked", "review"].includes(node.status)) continue;
  console.log(JSON.stringify({
    node: id,
    status: node.status,
    lease: node.lease,
    report: node.report,
    workRef: node.workRef?.name,
    outputRef: node.outputRef?.name,
    integrationRef: node.integrationRef?.name
  }));
}
' "$GRAPH"
```

Only clean workspaces that are not named by an active node report or active
integration report. Prefer quarantine before deletion:

```bash
GRAPH_DIR=$(cd "$(dirname "$GRAPH")" && pwd)
mkdir -p "$GRAPH_DIR/runs/workspaces-quarantine"
mv "$GRAPH_DIR/runs/workspaces/codex-A/TEN36/run_20260527_000000_TEN36_abc123" \
  "$GRAPH_DIR/runs/workspaces-quarantine/TEN36-run_20260527_000000_TEN36_abc123.$(date +%Y%m%d%H%M%S)"
```

After a quarantine period, remove only the quarantined path:

```bash
rm -rf "$GRAPH_DIR/runs/workspaces-quarantine/TEN36-run_20260527_000000_TEN36_abc123.20260527000000"
```

Prune remote-tracking refs through Git fetch, not by deleting the cache:

```bash
git --git-dir "$GRAPH_DIR/runs/git/cache/repo.git" fetch --prune origin
```

For scheduler-owned local refs, first collect refs still mentioned anywhere in
the graph and compare them with refs present in the bare repository:

```bash
node -e '
const fs = require("node:fs");
const graph = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const refs = new Set();
function walk(value) {
  if (typeof value === "string" && /^refs\/(heads|tags)\/spg\//.test(value)) {
    refs.add(value);
  } else if (value && typeof value === "object") {
    for (const child of Object.values(value)) walk(child);
  }
}
walk(graph);
console.log([...refs].sort().join("\n"));
' "$GRAPH" > /tmp/spg-live-refs.txt

git --git-dir "$GRAPH_DIR/runs/git/cache/repo.git" for-each-ref \
  --format='%(refname)' refs/heads/spg refs/tags/spg | sort > /tmp/spg-all-refs.txt
comm -23 /tmp/spg-all-refs.txt /tmp/spg-live-refs.txt
```

Delete only refs printed by the final `comm` command, and only after verifying
they are not needed for retained reports or external review:

```bash
REF=refs/heads/spg/node/TEN36/run_20260527_000000_TEN36_abc123
git --git-dir "$GRAPH_DIR/runs/git/cache/repo.git" update-ref -d "$REF"
```

### Isolated Reset And Retry

Retrying an isolated node should create a new claim, run id, workspace, work
ref, and output ref. Do not reuse or edit the old clone in place.

For a failed or obsolete leaf attempt:

```bash
node scripts/plan-scheduler.mjs reset --graph "$GRAPH" --node "$NODE" --reason "retry isolated worker after inspection"
npm run worker -- --graph "$GRAPH" --session codex-A --once --isolation git --workspace-retention on-failure
```

If the retry failed because the exact workspace path already existed, inspect
that path, quarantine only that path, and run the worker again. Do not remove
the entire workspace root.

If a stale workspace has uncommitted changes, capture its status before moving
it:

```bash
git -C "$WORKSPACE" status --short --branch > "$GRAPH_DIR/runs/workspaces-quarantine/$(basename "$WORKSPACE").status.txt"
git -C "$WORKSPACE" diff --stat >> "$GRAPH_DIR/runs/workspaces-quarantine/$(basename "$WORKSPACE").status.txt"
```

Use the graph report path and `.spg-run.json` metadata when present to decide
whether the workspace is still the only copy of failed work. Successful isolated
runs should be recoverable from the bare repository output ref even when the
clone was removed by retention policy.

For a composition failure, prefer `reconcile --graph "$GRAPH"` after cleaning
or resolving the retained integration workspace. Use `reset-subtree` only when
the parent and all descendants should be rebuilt, and use `reset-reachable`
only when later series work must be rerun from a changed upstream output ref.

## Reset Scope Selection

Use the narrowest reset that matches the intended retry. Reset commands clear
leases, report paths, timestamps, failure fields, and blocking fields for their
scope, but preserve unrelated metadata.

Reset one leaf and reopen completed ancestors above it:

```bash
node scripts/plan-scheduler.mjs reset --graph ./plan-improve.graph.json --node TEN36 --reason "retry single task"
```

Reset a node and all child-reachable descendants without reopening parents
above the selected node:

```bash
node scripts/plan-scheduler.mjs reset-subtree --graph ./plan-improve.graph.json --node PHASE_2 --reason "rerun phase 2"
```

Reset a node, descendants, and later execution-reachable series work:

```bash
node scripts/plan-scheduler.mjs reset-reachable --graph ./plan-improve.graph.json --node TS3 --reason "rerun downstream from TS3"
```

`reset-reachable` uses execution order, not only graph containment. It first
resets the selected node's child-reachable subtree. Then, for every series
ancestor between that node and the root, it also resets later siblings and their
descendants. Parallel ancestors do not add sibling branches. If the selected
node is not reachable from `graph.root`, only that node's child-reachable
subtree is reset.

For this nested fixture:

```text
ROOT(series): PREP, FANOUT, TAIL, CLEANUP
PREP(series): P1, P2
FANOUT(parallel): LEFT, RIGHT
LEFT(series): L1, L2
RIGHT(parallel): R1, RN
RN(series): RN1, RN2
TAIL(series): T1, T2
ORPHAN(series, unreachable): O1, O2
```

The observed reset sets are:

| Selected node | Meaning | Reset nodes |
| --- | --- | --- |
| `L1` | Leaf inside nested series branch | `L1`, `L2`, `TAIL`, `T1`, `T2`, `CLEANUP` |
| `LEFT` | Internal series branch root | `LEFT`, `L1`, `L2`, `TAIL`, `T1`, `T2`, `CLEANUP` |
| `RIGHT` | Internal parallel branch root | `RIGHT`, `R1`, `RN`, `RN1`, `RN2`, `TAIL`, `T1`, `T2`, `CLEANUP` |
| `FANOUT` | Parallel branch root under root series | `FANOUT`, `LEFT`, `L1`, `L2`, `RIGHT`, `R1`, `RN`, `RN1`, `RN2`, `TAIL`, `T1`, `T2`, `CLEANUP` |
| `ROOT` | Root | every node reachable from `ROOT`; unreachable nodes are excluded |
| `ORPHAN` | Unreachable node | `ORPHAN`, `O1`, `O2` only |

Before broad resets, capture current state for review:

```bash
node scripts/plan-scheduler.mjs diagnostics --graph ./plan-improve.graph.json > /tmp/spg-diagnostics-before-reset.json
```

## Invalid Graphs

Symptoms:

- `Failed to parse graph file ...`
- `Invalid graph file ...`
- Validation issue paths such as `$.graph.root` or
  `$.graph.nodes.ROOT.children[0]`.

Diagnosis:

```bash
node scripts/plan-scheduler.mjs summary --graph ./plan-improve.graph.json
```

Recovery:

1. Fix the issue named in the validation path. Common causes are malformed
   JSON, missing `graph.root`, missing `graph.nodes`, root id absent from the
   node map, non-object nodes, non-array `children`, missing child ids,
   duplicate child ids, child-reference cycles, empty `series` or `parallel`
   child lists, or malformed lease/history/timestamp fields.
2. Re-run a read-only load:

   ```bash
   node scripts/plan-scheduler.mjs summary --graph ./plan-improve.graph.json
   ```

3. If hand-editing a graph under active workers caused the problem, stop those
   workers before retrying. A worker can only recover a graph that the scheduler
   can parse and validate.

## Slack Notification Failures

Symptoms:

- Mutating commands that notify Slack fail with
  `Slack notification failed: HTTP <status> <body>`.
- Command JSON contains a skipped Slack result with reason
  `SLACK_WEBHOOK_URL is not set`.

Diagnosis:

```bash
env | rg '^SLACK_WEBHOOK_URL='
node scripts/plan-scheduler.mjs diagnostics --graph ./plan-improve.graph.json
```

Recovery:

- If Slack is optional for the run, unset it for the command:

  ```bash
  SLACK_WEBHOOK_URL= node scripts/plan-scheduler.mjs done --graph ./plan-improve.graph.json --node TEN36 --session codex-A --report reports/TEN36.md
  ```

- If Slack should be enabled, verify the webhook URL outside committed files,
  rotate it if it was exposed, and retry the intended mutation only if the graph
  did not already record the state change. Check `summary`, `diagnostics`, and
  node history before retrying a state-changing command.

Slack text includes node ids, titles, questions, answers, reasons, report
paths, and status counts. Do not put secrets in those fields.

## Visualizer Port And Binding Issues

Symptoms:

- `Invalid --port: expected integer from 0 to 65535; received "..."`
- `Refusing to bind visualizer write endpoints to 0.0.0.0 without protection.`
- The bind refusal says to use `--visualizer-write-token <token>` or
  `--unsafe-visualizer-write`.
- Node reports or stderr show an address-in-use error such as `EADDRINUSE`.

Diagnosis:

```bash
node scripts/plan-scheduler.mjs help
lsof -nP -iTCP:8787 -sTCP:LISTEN
```

Recovery:

- Use another local port:

  ```bash
  npm run serve -- --graph ./plan-improve.graph.json --cwd "$PWD" --port 8788
  ```

- Keep the default loopback host for ordinary local use:

  ```bash
  npm run serve -- --graph ./plan-improve.graph.json --host 127.0.0.1 --port 8787
  ```

- If non-loopback access is required, protect write endpoints:

  ```bash
  npm run serve -- --graph ./plan-improve.graph.json --host 0.0.0.0 --port 8787 --visualizer-write-token "$SPG_VISUALIZER_WRITE_TOKEN"
  ```

Use `--unsafe-visualizer-write` only when every reachable client is trusted to
read graph state, start or stop local worker processes, mutate graph nodes, and
run graph-level recovery mutations.

## Sandbox And Local Environment Notes

- The scheduler does not sandbox worker commands. Workers inherit environment
  variables and the selected `--cwd`, and can modify files allowed by the
  operating system.
- Report paths are graph-directory relative and cannot escape the graph
  directory. Prefer `reports/NODE.md` or the default worker report path.
- The visualizer starts local processes through the Worker Manager. Treat it as
  trusted-operator UI and stop it when not in use.
- Browser, CI, or container environments may restrict local port binding. Use
  `--port 0` in tests that can consume the returned URL, or choose an available
  explicit port for manual operation.
- Concurrent workers require a local filesystem with the lock semantics
  documented in `docs/lock-strategy-decision.md`.
