# Worker Isolation Remote And Cache Design

This note specifies the remote-resolution, validation, and local path contract
for Git-backed worker isolation. It refines the compatibility contract in
`compatibility-boundaries.md` without changing the existing shared-cwd worker
mode.

## Scope

This design applies when a worker is started in isolated Git mode. Non-isolated
workers keep the existing behavior: they run in `--cwd`, or in the graph
directory when `--cwd` is omitted, and they do not require `scheduler.remote`.

The isolated worker path must validate its Git configuration before claiming a
node. A failed remote preflight must leave the graph unchanged: no claim, no
lease, no `running` transition, and no report path allocated for a node.

## Remote Resolution

The canonical graph field is:

```json
{
  "scheduler": {
    "remote": "git@github.com:example/repo.git"
  }
}
```

Operator-facing help and errors should call this field `scheduler.remote`.
TypeScript contracts may expose it as `PlanGraphFile.scheduler.remote`.

The isolated worker resolves the remote in this order:

1. `--remote REMOTE`, when supplied to `worker`.
2. `graph.scheduler.remote`.

`--remote` is an invocation override. It should not mutate the graph file unless
a future command explicitly documents persistence. The resolved remote value
must be carried into worker reports and diagnostic payloads through a redacted
display form, not as a credential-bearing raw string.

`serve` and Worker Manager should use the same configuration shape. A managed
worker start request may pass a remote override, but the server must apply the
same validation before spawning the child worker process.

## Remote Validation

Remote validation has three layers.

First, perform cheap local validation before any graph mutation:

- Reject missing `scheduler.remote` when no `--remote` override is supplied.
- Reject non-string values, empty strings, and whitespace-only strings.
- Reject known placeholders such as `REQUIRED:...`, `TODO`, `TBD`,
  `<remote>`, `<repo>`, and strings containing `set to the Git remote URL`.
- Reject values that are clearly local working-tree directories intended as
  workspaces rather than Git remotes. A local filesystem path is only acceptable
  when Git can treat it as a repository remote.

Second, preserve Git's own remote syntax support. The scheduler should not
try to fully parse every valid Git transport. Values such as HTTPS URLs, SSH
URLs, scp-like SSH remotes, `file://` URLs, and local paths to bare repositories
should be allowed past the local screen and proven by Git.

Third, validate reachability before claiming work. The worker should initialize
or refresh the local bare repository as the reachability check:

- If the cache does not exist, run the equivalent of `git clone --bare <remote>
  <cache-path>`.
- If the cache exists, verify it is a bare Git repository, ensure its `origin`
  URL matches the resolved remote, and run the equivalent of `git fetch --prune
  origin`.

Any Git failure in this stage is a pre-claim worker failure. The command should
exit non-zero with a clear error and no graph mutation.

## Deterministic Paths

All default isolation paths are relative to the graph directory, defined as
`dirname(resolve(graphPath))`.

```text
runs/git/cache/repo.git
runs/workspaces
runs/workspaces/<safe-session>/<safe-node-id>/<safe-run-id>
```

The graph-relative cache path is deterministic for a given graph file:

```text
<graph-dir>/runs/git/cache/repo.git
```

The worker must create parent directories as needed. Operators are responsible
for providing a remote; they are not responsible for manually cloning,
initializing, or refreshing the cache repository.

The cache path is shared by isolated workers for the same graph. Cache creation
and fetch must be protected by the graph lock or by a dedicated Git-cache lock
under `runs/git/cache` so concurrent workers cannot corrupt `repo.git`.
The dedicated Git-cache lock waits up to `SPG_GIT_CACHE_LOCK_TIMEOUT_MS`
milliseconds, defaulting to `60000`, before reporting the owner metadata from
`runs/git/cache/.repo.git.lock/owner.json`.

Per-run workspaces are not shared. A worker that successfully claims a node
creates its clone under:

```text
<graph-dir>/runs/workspaces/<safe-session>/<safe-node-id>/<safe-run-id>
```

`safe-session`, `safe-node-id`, and `safe-run-id` use the same path-token
sanitizer as report paths. If a sanitized token differs from its source value,
the report must include both the original value and the sanitized token so an
operator can map a retained clone back to the graph lease.

The final workspace directory is the clone directory and the uniqueness
reservation. The worker must create parent directories as needed, then reserve
the final directory with an atomic create operation before running `git clone`.
Any existing final directory is a collision, even when empty, unless an explicit
retry or cleanup mode owns its removal. This makes the directory identity depend
on session, node id, and run id and ensures two concurrent workers can never
receive the same working directory.

The CLI and Worker Manager controls defined in
`compatibility-boundaries.md` may override the workspace root and retention
policy. The bare cache default remains graph-directory relative and
deterministic unless a separate design explicitly changes it.

## Per-Run Clone And Branch Setup

After remote/cache preflight succeeds and the scheduler claims a node, the
isolated worker prepares the claimed run in this order:

1. Resolve the node base ref against the local bare repository using the
   ordering in `compatibility-boundaries.md`, and record the fully qualified ref
   name plus the resolved commit when known.
2. Reserve the workspace path:
   `<graph-dir>/runs/workspaces/<safe-session>/<safe-node-id>/<safe-run-id>`.
3. Clone from the local bare repository into that reserved directory. The child
   command never runs in the scheduler's source checkout.
4. Create the work branch from the resolved base commit:
   `refs/heads/spg/node/<ref-node-id>/<run-id>`.
5. Run the child command with the workspace as its current working directory.
6. On a successful child result, stage and commit any dirty workspace changes
   to the work branch using the scheduler commit identity.
7. Publish the work branch back to the local bare repository as the node
   `outputRef`.

The public branch pattern is:

```text
spg/node/<node-id>/<run-id>
```

`run-id` is the scheduler lease run id. `node-id` is the graph node id when it
is already a valid Git ref path component. If the implementation maps node ids
or run ids to Git-safe ref tokens, the mapping must be stable for that run and
must be written to the worker report and graph history. The fully qualified
work ref is recorded as `refs/heads/spg/node/<ref-node-id>/<run-id>`.

The work branch must be unique for the run. If the branch already exists in the
clone or bare repository before the worker creates it, the worker must treat
that as a collision, stop before running the child command, and retain the
workspace for inspection.

## Child Process Environment

The child command inherits the worker process environment and receives these
additional variables in isolated mode:

| Variable | Value |
| --- | --- |
| `SPG_ISOLATED_WORKER` | `1`. |
| `SPG_GRAPH_PATH` | Resolved graph file path. |
| `SPG_NODE_ID` | Original graph node id. |
| `SPG_RUN_ID` | Scheduler run id. |
| `SPG_SESSION` | Worker session id. |
| `SPG_REPORT_PATH` | Report path for this run. |
| `SPG_WORKSPACE` | Resolved clone directory. |
| `SPG_BARE_REPO` | Resolved local bare repository path. |
| `SPG_BASE_REF` | Fully qualified base ref name. |
| `SPG_WORK_REF` | Fully qualified work branch ref. |
| `SPG_OUTPUT_REF` | Fully qualified output ref expected on success. |

Remote values in the child environment must use the same credential-redaction
policy as reports unless a later implementation explicitly documents a raw
remote variable for Git subprocesses. The worker's own Git commands may use the
raw remote internally.

## Workspace Retention And Cleanup

The default retention policy is `on-failure`:

| Run outcome | Default workspace behavior | Required preserved state |
| --- | --- | --- |
| Success after output ref publication | Delete the clone after the report records refs and commits. Keep the bare repo output ref. |
| Child command failure | Keep the clone. Preserve `.git`, working tree changes, report path, base ref, work ref, exit code, and captured output. |
| Workspace or branch collision after claim | Keep or create the diagnostic workspace when available. Record the colliding path or ref and cleanup guidance. |
| Worker timeout | Keep the clone. Record timeout duration, last known child status, refs, and captured output. |
| Blocked run | Keep the clone. Record the operator question or blocked reason with refs and cwd. |
| Report/finalization failure after child success | Keep the clone because the graph may not contain the output ref metadata. |

Deleting a successful clone is best-effort cleanup. If cleanup fails after the
output ref and report are recorded, the worker may still complete the node but
must include a cleanup warning naming the retained workspace. Cleanup must never
remove the local bare repository or refs published into it.

Retention flags should be testable as an enum, not as ad hoc booleans:

- `on-failure`: the default described above.
- `always`: keep every per-run clone.
- `never`: delete every per-run clone after report finalization when possible;
  if finalization fails, keep the clone.

Every retained workspace should contain a small metadata file such as
`.spg-run.json` with session, node id, run id, report path, base ref, work ref,
output ref, start time, finish time when known, terminal outcome, and cleanup
policy. Tests for isolated worker retention can assert the workspace path,
branch name, cleanup policy, and directory existence for success, failure,
timeout, blocked, and collision outcomes without contacting an external
network.

## Failure Behavior

Remote failures are ordered so the scheduler never claims work it cannot prepare
to run.

| Failure | Detection point | Behavior |
| --- | --- | --- |
| Missing remote | Before claim | Exit non-zero; print that isolated workers require `scheduler.remote` or `--remote`; leave graph unchanged. |
| Placeholder remote | Before claim | Exit non-zero; name the placeholder value as invalid without suggesting it was contacted; leave graph unchanged. |
| Malformed remote value | Before claim | Exit non-zero; explain that the value is not a usable Git remote string; leave graph unchanged. |
| Cache path exists but is not a bare repository | Before claim | Exit non-zero; name `runs/git/cache/repo.git` and require cleanup or a documented repair command; leave graph unchanged. |
| Cache has different origin | Before claim | Exit non-zero unless a future explicit repair flag updates the origin; leave graph unchanged. |
| Remote cannot be cloned or fetched | Before claim | Exit non-zero with the Git failure summarized and credentials redacted; leave graph unchanged. |
| Workspace path collision after claim | After claim, before child command | Mark or fail the claimed node with a report, because the lease already exists; include cleanup guidance for the workspace path and retain diagnostics. |

Errors and reports must redact credentials in remote URLs. Redaction should at
least remove userinfo from URLs such as `https://user:token@example/repo.git`.
Use the raw resolved remote only as an argument to Git subprocesses or private
in-memory configuration. Any report, graph history entry, diagnostic payload,
visualizer payload, worker log, Slack notification, or thrown error must use the
redacted display value, for example `https://[REDACTED]@example/repo.git`.

## Implementation Notes For Later Nodes

The first implementation should introduce a small isolation configuration
resolver that returns:

- `enabled`: whether isolated Git mode is active.
- `remote`: raw remote for Git subprocesses.
- `remoteDisplay`: redacted remote for errors, reports, diagnostics, and
  visualizer payloads.
- `graphDir`: resolved graph directory.
- `bareRepoPath`: `<graph-dir>/runs/git/cache/repo.git`.
- `workspaceRoot`: `<graph-dir>/runs/workspaces`.
- `workspacePath`:
  `<graph-dir>/runs/workspaces/<safe-session>/<safe-node-id>/<safe-run-id>`.

`runWorker` should call this resolver and complete remote/cache preflight before
`claimNode`. This satisfies the required no-claim behavior for missing, invalid,
or unreachable remotes.
