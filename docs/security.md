# Security Threat Model

This scheduler is a local orchestration tool for trusted operators. It stores state in plain files, starts local worker processes, and can post status to Slack. It is not designed as a multi-tenant service or as an internet-facing control plane.

## Assets

- Plan graph files, including task titles, questions, answers, status history, leases, and report paths.
- Worker reports and redirected worker logs, which may contain prompts, stdout, stderr, stack traces, repository paths, and command output.
- Local repository files reachable from worker `--cwd`, Git-isolated bare caches and per-run clones under `runs/`, generated `plan.html`, lock files, and report directories under the graph directory.
- Git remote URLs in `scheduler.remote` or `--remote`, including possible usernames, tokens, hostnames, repository names, and local filesystem paths.
- Operator authority to claim, reset, complete, fail, answer, or decompose work.
- Ability to spawn local processes through CLI workers and the visualizer Worker Manager.
- Slack webhook URL and notification content sent to Slack.

## Actors

- Trusted local operator: a human with shell access to the repository and permission to mutate the plan.
- Trusted worker process: Codex or another configured command started by the operator or Worker Manager.
- Local untrusted process: malware, another user account, a browser extension, or a webpage that can reach local services from the same machine.
- Network peer: any machine that can reach the visualizer when it is bound to a non-loopback interface such as `0.0.0.0`.
- Slack workspace participants and Slack infrastructure that receive webhook messages.

## Attacker Model

In scope:

- A local process, browser extension, or same-user webpage that can connect to a loopback visualizer while it is running.
- A LAN or internet client that can reach the visualizer after an operator binds it to a non-loopback address.
- A user who can edit a graph file, worker prompt template, report path, node title, blocked question, answer, failure reason, or `scheduler.remote` value before a trusted operator runs the scheduler.
- A worker command that exits non-zero, writes hostile stdout/stderr, emits secret-shaped values, writes large output, or attempts to confuse Markdown reports.
- A Git remote that is unavailable, unexpectedly large, credential-bearing, or controlled by someone other than the operator.
- Slack recipients or Slack infrastructure that receive webhook messages when `SLACK_WEBHOOK_URL` is configured.

Out of scope:

- An attacker with arbitrary code execution as the same OS user. That attacker already has the scheduler's filesystem, environment, and process authority.
- Kernel, filesystem, Git, Node.js, browser, Slack, or Codex CLI vulnerabilities.
- A malicious trusted operator intentionally running destructive commands or exposing secrets.

## Trust Assumptions

- Graph files are trusted-local control documents. The scheduler validates their JSON shape and topology before traversal or mutation, but it does not treat graph text as confidential from local operators.
- The graph directory is a trusted workspace. Report paths, generated HTML, lock files, Git caches, retained clones, and worker logs should stay under private OS permissions.
- Worker commands are trusted code at the scheduler boundary. `worker` and the visualizer Worker Manager pass arguments without a shell, but the selected command still receives the operator environment and can read or write anything allowed by OS permissions.
- Git isolation is operational isolation, not a sandbox. It gives each run a separate clone, branch, and output ref, but fetched repository contents and retained workspaces remain local sensitive files.
- The default visualizer is trusted-local. Loopback binding limits network reachability, but it is still unauthenticated and local browser/process access is enough to read state or submit writes.
- Non-loopback visualizer reads are public to every reachable client. `--visualizer-write-token` protects write routes only; `GET /`, `GET /api/graph`, `GET /api/workers`, and `GET /events` still disclose operational state.
- Slack is an external attention channel. Notifications intentionally cross the local trust boundary and should not carry secrets.

## Non-goals

- The scheduler is not a multi-tenant service, internet-facing control plane, remote execution sandbox, secrets manager, or authorization layer.
- The visualizer does not provide TLS, login sessions, user roles, CSRF protection, origin checks, or per-route permissions.
- Report redaction is best-effort for common secret shapes; it is not a guarantee that arbitrary sensitive data will be removed from graph text, stdout, stderr, logs, or generated HTML.
- Graph validation prevents malformed scheduler structure from driving traversal, but it does not certify that task content, commands, remote URLs, or operator instructions are safe.
- Git-backed worker isolation does not contain malicious code, prevent network access, or hide repository contents from local filesystem readers.

## Trust Boundaries

- Shell boundary: anyone who can run `node scripts/plan-scheduler.mjs` or `dist/scripts/plan-scheduler.js` with write access to the graph can mutate scheduler state.
- Filesystem boundary: graph writes are atomic and locked, but graph, report, generated HTML, and log confidentiality depends on operating system file permissions.
- Worker process boundary: `worker` and `/api/workers/start` spawn a child process with inherited environment variables and the selected working directory.
- Git isolation boundary: `--isolation git` prepares a local bare repository cache from `scheduler.remote` or `--remote`, then runs the child process in a generated clone. It isolates workers from each other at the working-tree level, but it is not a security sandbox and still exposes clone contents to local filesystem readers.
- HTTP boundary: `serve` exposes unauthenticated browser APIs. The default bind address is `127.0.0.1`; a non-loopback bind extends trust to every reachable client.
- Slack boundary: setting `SLACK_WEBHOOK_URL` sends selected node metadata outside the local machine.
- Generated output boundary: visualizer HTML and SVG are generated from graph content and escaped before browser insertion, but generated `plan.html` and worker logs still expose graph and task data to anyone who can read them.

## Mutating Surfaces

The CLI mutates work through these commands:

- `claim`: selects a ready leaf, marks it `claimed`, creates a lease, and can release expired leases first.
- `start`: changes a claimed leaf to `running`.
- `renew`: extends a lease on claimed, running, blocked, or review work.
- `reset`, `reset-subtree`, `reset-reachable`: reopen work and clear status fields, leases, reports, and timestamps for the selected scope.
- `done`: optionally writes a report body, marks a node done, clears lease/blocking fields, reconciles ancestors, regenerates HTML, and may notify Slack.
- `block`: marks work blocked, stores an operator question/reason, regenerates HTML, and may notify Slack.
- `answer`: stores an operator answer, clears the lease, returns the leaf to pending, regenerates HTML, and may notify Slack.
- `fail`: marks work failed, records reason/report, clears the lease, regenerates HTML, and may notify Slack.
- `decompose`: replaces a claimed/running leaf with child nodes, clears the lease, reconciles the graph, regenerates HTML, and may notify Slack.
- `worker`: loops over `claim`, `start`, lease renewal, report writing, `done`, and `fail` while spawning the configured Codex command.
- `reconcile`: marks completed internal subtrees done.
- `release-expired`: clears expired leases and returns affected work to pending.

The visualizer exposes these write-capable HTTP routes. They are unauthenticated on loopback by default, require `--visualizer-write-token` when bound beyond loopback, or require the explicit `--unsafe-visualizer-write` opt-in to run without a token on non-loopback hosts:

- `POST /api/workers/start`: starts one or more scheduler worker child processes. Inputs are bounded and passed to `spawn` without a shell, but the caller controls the command, arguments, working directory, count, lease, idle interval, template path, and target node.
- `POST /api/workers/stop`: sends `SIGTERM` to one managed worker process.
- `POST /api/workers/stop-all`: sends `SIGTERM` to every managed worker process.
- `POST /api/answer`: records an answer for a blocked node, returns it to pending, regenerates HTML, and may notify Slack.

Read-only visualizer routes are `GET /`, `GET /index.html`, `GET /api/graph`, `GET /api/workers`, and `GET /events`. They can still disclose graph state, report paths, worker process ids, repository paths, and recent worker output.

When the visualizer is bound to a non-loopback host, read-only routes are intentionally reachable without a token by every client that can connect to the host and port. The write token is not an authentication system for read access; it only gates worker start, worker stop, stop-all, and answer mutations.

Safe exposed visualizer command:

```bash
npm run serve -- --graph ./plan-improve.graph.json --host 0.0.0.0 --port 8787 --visualizer-write-token "$SPG_VISUALIZER_WRITE_TOKEN"
```

Write requests must include either `X-SPG-Visualizer-Token: TOKEN` or `Authorization: Bearer TOKEN`. For browser use, open `http://HOST:8787/#write-token=TOKEN` so the UI stores the token locally and sends it on write requests. The fragment is not sent in HTTP requests.

Explicit unsafe exposed command:

```bash
npm run serve -- --graph ./plan-improve.graph.json --host 0.0.0.0 --port 8787 --unsafe-visualizer-write
```

This mode requires the explicit flag and prints a warning that any reachable
client can use unauthenticated write controls.

## Risks And Mitigations

| Risk | Impact | Mitigations |
| --- | --- | --- |
| Visualizer bound to `0.0.0.0` or a LAN address | Remote clients can start/stop local workers, answer blocked tasks, and read graph/worker state. | Bind to `127.0.0.1` by default; non-loopback startup requires `--visualizer-write-token` or `--unsafe-visualizer-write`; only use unsafe mode behind a trusted network boundary, SSH tunnel, or reverse proxy with authentication. |
| Local webpage or browser extension reaches localhost APIs | A browser with access to the local visualizer can submit mutating POSTs. | Run the visualizer only when needed, close it after use, keep the bind address loopback, and avoid browsing untrusted pages in the same browser profile while operating sensitive plans. |
| Worker command misuse | A caller can spawn arbitrary commands through Worker Manager or `--codex-command`; workers inherit environment variables and can modify files allowed by OS permissions. | Treat Worker Manager as trusted-operator only; prefer default `codex exec`; review custom commands and arguments; run from the intended `--cwd`; use OS accounts, containers, or repository permissions for stronger isolation. |
| File disclosure through reports, logs, and generated HTML | Prompt text, stdout/stderr, paths, errors, and graph details can leak to anyone with filesystem or visualizer access. | Store graphs in private directories; redirect daemon logs to protected locations; review reports before sharing; do not commit sensitive worker output. |
| Credential-bearing Git remotes | A remote such as `https://user:token@example/repo.git` can leak credentials through reports, history, diagnostics, visualizer payloads, logs, shell history, or support tickets. | Prefer SSH agents or credential helpers over embedding tokens in URLs; use `scheduler.remote` or `--remote` only with trusted operators; reports and graph history must use redacted remotes; rotate any token that appears unredacted. |
| Retained isolated clones and local bare cache | Failed, blocked, review, or `--workspace-retention always` runs can leave full repository data, uncommitted changes, and conflict files under `runs/workspaces`; `runs/git/cache/repo.git` stores fetched refs. | Keep graph directories private; treat retained clones like source checkouts; quarantine before deletion; do not share reports without checking clone paths, refs, stdout, and stderr for sensitive data. |
| Remote repository trust | Git fetch and clone contact the configured remote and import its refs into the local cache. A malicious or mistaken remote can provide unexpected repository content for workers. | Set `scheduler.remote` deliberately, review `--remote` overrides, avoid placeholders, verify the remote with `git ls-remote`, and use OS/network controls for stronger isolation. |
| Path traversal in report writes | A malicious report path could overwrite files outside the graph directory. | Report paths are resolved relative to the graph and rejected if they escape the graph directory. Keep the graph directory permissioned to trusted operators. |
| Graph corruption or lost updates | Concurrent commands could overwrite status transitions. | Mutating graph operations use a filesystem lock and atomic rename; stale locks are detected. Keep graph files on a local filesystem when possible and back them with version control. |
| Slack webhook leakage | Webhook URL exposure allows unauthorized Slack posts; notification text may disclose node titles and report paths. | Store `SLACK_WEBHOOK_URL` outside committed files; rotate it if exposed; avoid putting secrets in node titles or report paths. |
| Generated HTML/script injection | Malicious graph text rendered into the visualizer could execute in the browser if not escaped. | The live visualizer escapes dynamic text before inserting it. Treat generated HTML as sensitive output and avoid opening graph files from untrusted authors. |
| Worker output volume | Large stdout/stderr can inflate reports or logs and expose data. | Use `--quiet` to suppress live streaming when appropriate; redirect daemon logs deliberately; prune reports/logs that are no longer needed. |

## Bind Address Risk Rating

| Mode | Rating | Rationale |
| --- | --- | --- |
| `serve --host 127.0.0.1` or default `npm run serve` | Medium | The unauthenticated API is reachable only from the local machine, but any local process, browser extension, or same-browser web context that can reach loopback may read state or submit mutating requests while the server is running. |
| `serve --host 0.0.0.0 --visualizer-write-token TOKEN` | High | Read-only graph and worker state remain reachable from other machines, but start, stop, and answer routes return HTTP 403 unless the request includes the token. |
| `serve --host 0.0.0.0 --unsafe-visualizer-write` | Critical | The unauthenticated start, stop, answer, graph, worker, and log-tail surfaces become reachable from other machines on accessible networks. Use only when every reachable client is trusted. |

## Trust Boundary Evidence Map

This table maps each documented boundary to automated test coverage or manual review evidence. The evidence is intentionally a mixture of tests and code-review anchors because some assumptions, such as OS file permissions and operator trust, cannot be fully proven inside the scheduler test suite.

| Boundary | Evidence |
| --- | --- |
| Shell boundary | Manual review: `scripts/cli.ts` help and dispatcher define mutating commands and their flags. Automated coverage: transition, CLI, and validation tests in the focused Node suites, including clean expected-failure output and debug-only stacks. |
| Graph file validation boundary | Code: `scripts/graph-io.ts` parses JSON, validates with `validatePlanGraphFileResult`, and rejects errors before returning a graph. Tests: fixture and CLI validation cases reject invalid graphs before scheduler or renderer traversal. |
| Filesystem and graph-write boundary | Code: `scripts/graph-io.ts` uses a lock directory with heartbeat metadata plus atomic rename for graph writes. Tests: lock timeout diagnostics and graph mutation tests cover concurrent-safe behavior; manual review remains required for OS permissions and network filesystems. |
| Report path boundary | Code: `writeReportFile` resolves paths relative to the graph directory, rejects escapes, rejects symlink parent/target escapes, and writes report bodies under the graph directory. Tests: report-path containment and worker report tests; manual review required before sharing generated reports. |
| Worker process boundary | Code: `worker` and Worker Manager use process spawning with argument arrays rather than shell command strings. Tests: one-shot worker execution, spawn failures, non-zero exits, timeout handling, `--codex-arg` parsing, and managed-worker start/stop cases. |
| Worker output/report boundary | Code: worker reports escape Markdown code fences and redact common secret shapes in commands, args, stdout, stderr, errors, and isolation metadata. Tests: report-format and failed-worker tests assert redaction of Slack webhook and token-shaped output. |
| Git isolation boundary | Code: isolation requires `scheduler.remote` or `--remote`, rejects placeholders, creates per-run clones/refs, records redacted provenance, and keeps workspace roots inside the graph directory. Tests: isolated worker setup, concurrent clone/ref separation, placeholder rejection, workspace-root rejection, fetch-failure redaction, and no-shell Git invocation. |
| Visualizer loopback boundary | Code: default host is `127.0.0.1`; `localhost`, `127.0.0.1`, `::1`, and `[::1]` are treated as local. Tests: visualizer host warning tests assert default loopback behavior and non-loopback warning text. |
| Visualizer non-loopback write boundary | Code: non-loopback startup refuses without `--visualizer-write-token` or `--unsafe-visualizer-write`; write routes require `X-SPG-Visualizer-Token` or `Authorization: Bearer` when a token is configured. Tests: serve rejects unprotected non-loopback binding; write-token tests verify 403 for missing/wrong tokens and success with valid headers. |
| Visualizer read/disclosure boundary | Code: `GET /api/graph`, `GET /api/workers`, and `GET /events` return graph state, worker manager state, and log tails without token checks. Tests: visualizer payload and Worker Manager tests assert exposed state; manual review required before any non-loopback read exposure. |
| Visualizer HTML/script boundary | Code: browser renderers escape dynamic graph text and worker logs before DOM insertion; static renderer escapes graph document HTML fields and link hrefs. Tests: visualizer browser renderer escaping, planar SVG escaping, and static renderer escaping/link-safety tests. |
| Slack boundary | Code: `sendSlackNotification` only runs when `SLACK_WEBHOOK_URL` is set, posts compact event text, escapes Slack formatting, includes only selected detail keys, and times out via `SPG_SLACK_TIMEOUT_MS`. Tests: Slack notification behavior is covered in scheduler tests; manual review required for workspace membership and webhook storage. |
| Generated HTML boundary | Code: renderer validates graph input before layout traversal and writes generated HTML next to the graph or configured output. Tests: renderer path, validation, escaping, and smoke tests; manual review required before publishing generated HTML externally. |

## Safe Operator Checklist

- Keep the visualizer on the default `127.0.0.1` bind unless every reachable client is trusted.
- Use `--visualizer-write-token` for non-loopback viewing when remote clients need browser controls.
- Use `--unsafe-visualizer-write` only when every reachable client is trusted to mutate the graph and start or stop workers.
- Prefer SSH port forwarding over `--host 0.0.0.0` when remote viewing is needed.
- Stop `npm run serve` when the Worker Manager is no longer needed.
- Do not expose the visualizer directly to the internet.
- Use a dedicated working directory and verify `--graph` and `--cwd` before starting workers.
- For `--isolation git`, set a concrete `scheduler.remote` in the graph or pass
  `--remote`; do not use placeholder text, token-bearing remotes in committed
  graphs, or `--cwd` as a non-Git isolation workaround.
- Verify isolated worker reports, graph history, diagnostics, visualizer output,
  and logs redact credential-bearing remote URLs before sharing them.
- Treat `runs/git/cache/repo.git` and retained `runs/workspaces/*` clones as
  sensitive repository data. Keep them private, inspect them before cleanup, and
  avoid committing or publishing them.
- Review any custom `--codex-command`, `--codex-arg`, template path, worker count, and lease settings before launching a pool.
- Keep `SLACK_WEBHOOK_URL` in the environment only, never in graph files, reports, prompts, or committed scripts.
- Avoid putting secrets in node titles, descriptions, questions, answers, failure reasons, report bodies, or worker stdout/stderr.
- Treat Slack as an attention channel. By default it receives compact status context only; report bodies, worker output, questions, answers, and failure reasons remain in the graph and reports.
- Store graph files, reports, generated HTML, and redirected logs in directories readable only by trusted operators.
- Check `reports/` and worker logs before sharing or committing them.
- Use version control or backups for important graph files before large resets, decompositions, or worker pools.
- If a non-loopback visualizer was accidentally exposed, stop it, inspect graph history/reports/logs for unexpected mutations, and rotate any exposed Slack webhook.

## Residual Risks

- There is no authentication, authorization, CSRF protection, TLS, or per-route permission model in the visualizer.
- Worker processes are not sandboxed by the scheduler; they inherit the operator environment and rely on OS-level controls.
- Git-backed worker isolation separates working trees and refs for scheduler
  correctness, not for containment of malicious code or secrets.
- Localhost is not a security boundary against local malware, compromised browser extensions, or other users on the same host.
- Slack notifications intentionally leave the local trust boundary when the webhook is configured.
- Graph and report confidentiality ultimately depends on filesystem permissions, log handling, and operator discipline.
