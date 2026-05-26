# Series-Parallel Graph Scheduler

A filesystem-backed, CLI-controlled scheduler for running multiple Codex sessions against one evolving
series-parallel implementation plan.

It is designed for operator-supervised work where many Codex CLI workers, scripts, or humans can safely claim
independent tasks, keep moving in parallel, ask for human attention only when needed, and leave behind durable reports.
The graph remains inspectable, versionable, and recoverable from plain files.

`plan.graph.json` is the source of truth. The checked-in graph is a compact launch-checklist example: small enough to scan, but large enough to show series order, parallel branches, nested branch-local sequencing, and a post-build integration gate. `plan.html` is the generated readable view.

## Operating model

This project treats an implementation plan as a series-parallel graph:

- `series` nodes enforce ordered work.
- `parallel` nodes expose independent branches that can run at the same time.
- Leaf `task` nodes are the only units that Codex workers claim and execute.

The scheduler is the control plane. It decides which leaf tasks are ready, grants leases so two workers do not perform
the same task, records status transitions, and regenerates `plan.html` after graph updates. The CLI is primary because
this workflow needs direct control over worker processes, filesystem state, recovery, reports, and automation.

Slack is only the attention channel. When a worker needs operator discussion, it marks its task `blocked` and posts the
question to Slack, while unrelated ready tasks continue in other sessions. When a worker finishes, it writes a report,
marks the node done, and posts a quiet status notification with the report path and current graph state.

Tasks can also be recursively refined. If a worker discovers that a claimed task is too large or underspecified, it can
replace that leaf with a smaller series-parallel subgraph. That updates the shared plan dynamically without disturbing
other running jobs.

Use a different graph file with `--graph`:

```bash
npm run ready -- --graph /path/to/plan.graph.json
npm run worker -- --graph /path/to/plan.graph.json --session codex-A --once
npm run render -- --graph /path/to/plan.graph.json
```

Or set it once for a shell:

```bash
export PLAN_GRAPH=/path/to/plan.graph.json
npm run ready
npm run worker -- --session codex-A --once
```

## Quickstart

Run the tests, inspect the first ready task, claim it, and open the live visualizer:

```bash
npm test
npm run ready
node scripts/plan-scheduler.mjs claim --session codex-A
npm run serve -- --port 8787
```

Then open:

```text
http://127.0.0.1:8787
```

The visualizer shows both active sessions and ready leaves. Active sessions include claimed, running, blocked, review, and failed nodes, with session/run/lease details when available. Blocked nodes include an inline answer box; submitting an answer records it and returns the task to the ready queue.

Complete the claimed task with a report path:

```bash
node scripts/plan-scheduler.mjs done --node KICKOFF --session codex-A --report reports/KICKOFF.md
npm run ready
```

Answer a blocked task and return it to the ready queue:

```bash
node scripts/plan-scheduler.mjs answer --node WEB1 --answer "Use the CLI path first." --responder jason
```

If `SLACK_WEBHOOK_URL` is set, `done`, `block`, `answer`, `fail`, and `decompose` post a quiet status notification to Slack. `done` includes the report path, but report details stay in the report file. You can create the report in the same command:

```bash
node scripts/plan-scheduler.mjs done --node KICKOFF --session codex-A --report reports/KICKOFF.md --report-body "Implemented scope agreement and acceptance checks."
```

## Background Codex workers

The scheduler can also run asynchronous Codex workers. A worker claims the next ready leaf, starts it, renders a prompt from `prompts/codex-worker-task.md`, runs Codex non-interactively, writes a report, and marks the node done or failed.
Claims are leases. When a worker dies before marking a node done, another claim attempt automatically releases expired claimed/running leases before selecting work. Active workers renew their own lease while Codex is running, so a long-running task is not mistaken for a dead worker.

Run one node and exit:

```bash
npm run worker -- --session codex-A --once --cwd /Users/jasonhan/Documents/Blackjack
```

Run several background workers:

```bash
mkdir -p runs/logs
npm run worker -- --session codex-A --cwd /Users/jasonhan/Documents/Blackjack > runs/logs/codex-A.log 2>&1 &
npm run worker -- --session codex-B --cwd /Users/jasonhan/Documents/Blackjack > runs/logs/codex-B.log 2>&1 &
npm run worker -- --session codex-C --cwd /Users/jasonhan/Documents/Blackjack > runs/logs/codex-C.log 2>&1 &
```

Add `--graph /path/to/plan.graph.json` to those commands, or set `PLAN_GRAPH`, when running a graph outside this package directory.

Render the prompt without running Codex:

```bash
node scripts/plan-scheduler.mjs prompt --node KICKOFF --session codex-A
```

By default the worker runs:

```bash
codex exec "<rendered prompt>"
```

The worker sets the child process working directory from `--cwd`.
Worker output is verbose by default: stdout and stderr from the Codex process are streamed to the worker process and also captured in the report file. When a daemon worker has no ready job, it shows a waiting spinner in an interactive terminal, or a periodic waiting line in redirected logs. Add `--quiet` to capture output without streaming it live and suppress waiting output.

You can provide a custom runner for testing or a different Codex CLI shape:

```bash
node scripts/plan-scheduler.mjs worker --session codex-A --once --codex-command /path/to/runner --codex-arg arg1 --codex-arg arg2
node scripts/plan-scheduler.mjs worker --session codex-A --once --codex-arg=--model=gpt-5
node scripts/plan-scheduler.mjs worker --session codex-A --once --codex-arg=--dangerously-bypass-approvals-and-sandbox
```

## Files

- `plan.graph.json`: canonical graph state.
- `plan.html`: generated human-readable plan view.
- `scripts/plan-scheduler.mjs`: scheduler CLI and live visualizer server.
- `scripts/render-plan.mjs`: renders `plan.html` from `plan.graph.json`.
- `tests/plan-scheduler.test.mjs`: scheduler behavior tests.

## Commands

```bash
npm test
npm run render
npm run ready
npm run summary
npm run serve -- --port 8787
npm run worker -- --session codex-A --once
```

Direct CLI usage:

```bash
node scripts/plan-scheduler.mjs ready
node scripts/plan-scheduler.mjs claim --session codex-A
node scripts/plan-scheduler.mjs start --node KICKOFF --session codex-A
node scripts/plan-scheduler.mjs renew --node KICKOFF --session codex-A
node scripts/plan-scheduler.mjs reset --node KICKOFF --reason "retry with fresh context"
node scripts/plan-scheduler.mjs done --node KICKOFF --session codex-A --report reports/KICKOFF.md
node scripts/plan-scheduler.mjs block --node WEB1 --session codex-A --question "Need operator decision"
node scripts/plan-scheduler.mjs answer --node WEB1 --answer "Proceed with option A." --responder jason
node scripts/plan-scheduler.mjs decompose --node WEB1 --session codex-A --kind series --child WEB1a="Draft shell" --child WEB1b="Review shell"
node scripts/plan-scheduler.mjs prompt --node WEB1 --session codex-A
node scripts/plan-scheduler.mjs worker --graph plan.graph.json --session codex-A --once
node scripts/plan-scheduler.mjs reconcile --graph plan.graph.json
node scripts/plan-scheduler.mjs serve --port 8787
```

Leased nodes require the claiming `--session` or `--run` id for normal mutation. `answer` is an operator command for blocked leaves: it records the operator response, clears the lease, and returns the task to `pending` so a worker can claim it with the question and answer in its node JSON. `reset` is also an operator command: it clears a leaf task back to `pending`, removes its lease/report/timestamps, and reopens any completed ancestors so the task becomes ready when its dependencies are satisfied. Internal series/parallel nodes are marked `done` automatically when every child subtree is done; `reconcile` applies that rule to an existing graph. The scheduler writes graph updates atomically with a filesystem lock. `plan.graph.json` is the source of truth; `plan.html` is regenerated atomically from the latest graph after updates.
