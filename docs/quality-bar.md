# 10/10 Quality Bar

This repository is 10/10 only when it is production-grade for trusted local
operation: graph mutations are correct and recoverable, public interfaces stay
compatible, unsafe inputs are rejected or escaped, and every claim is backed by
tests, docs, or CI evidence.

The bar is intentionally evidence-based. A criterion scores 1 point only when
the required evidence exists in source, tests, docs, or CI. Nice-to-have polish
does not count toward the score. Any unresolved blocker in the final section
caps the repository below 10/10 even if the numeric score appears complete.

## Non-Negotiable Criteria

| # | Criterion | Required evidence for 1 point | Nice-to-have polish |
|---|---|---|---|
| 1 | Graph correctness | A single validator rejects invalid JSON shape, missing roots, missing child ids, cycles, invalid child lists, and invalid lease/timestamp shapes before traversal or mutation, and reports non-fatal status/kind compatibility warnings separately. Fixture tests cover valid, invalid, legacy-compatible, and edge-case graphs. | Generated schema docs or editor integration. |
| 2 | Scheduler semantics | Readiness, claim, start, renew, done, block, answer, fail, reset, reset-subtree, reset-reachable, decompose, reconcile, and release-expired have a documented transition table and tests for allowed and important disallowed transitions. | A state-machine diagram rendered in docs. |
| 3 | Storage, locking, and recovery | Atomic graph writes, lock acquisition, stale lock handling, expired lease release, and crash/retry behavior are deterministic under concurrent claims. Tests prove no double-claim under contention and no partial graph write is accepted. | Pluggable storage backend. |
| 4 | Security and trust boundaries | Local-only assumptions, exposed-host risks, visualizer write controls, request size limits, path containment, report path safety, shell/process boundaries, and HTML escaping are documented and tested. No known unescaped user-controlled HTML or path traversal remains. | Optional authentication for non-local deployments. |
| 5 | Public API stability | `docs/compatibility-boundaries.md` names stable CLI commands, flags, npm scripts, package binaries, JSON output fields, graph semantics, worker prompt variables, visualizer routes, report paths, and renderer behavior. Compatibility changes update tests and docs together. | Versioned compatibility matrix. |
| 6 | Tests | The test suite is layered and deterministic: unit, contract, CLI, integration, smoke, browser or DOM, security, concurrency, and regression responsibilities are documented. Required CI tests assert exact behavior, not only counts or snapshots. | Coverage percentage reporting. |
| 7 | Operability | Operators can inspect ready work, active sessions, leases, blocked questions, worker status, reports, and summary diagnostics from CLI and visualizer paths. Failures include actionable messages and non-zero exits where appropriate. | Structured log export for external observability tools. |
| 8 | Documentation | README and docs cover quickstart, operating model, graph authoring, compatibility, security, testing, architecture, troubleshooting, runbook, checks, and release. Examples match current commands and do not rely on generated `dist/` source edits. | Tutorial-style walkthroughs for large teams. |
| 9 | CI and release hygiene | CI runs the authoritative local gate: `npm ci`, `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm run schema:graph`, `npm run build`, `npm test`, `npm run test:visualizer`, `npm run smoke:migration`, and `npm run release:check` where browser install and server binding are supported. Package metadata, ignored files, generated artifacts, changelog notes, and release checklist are consistent. | Multi-platform release automation. |
| 10 | Maintainability | TypeScript contracts define public graph, CLI, worker, renderer, and visualizer shapes without broad untyped escape hatches. Large modules have reviewed boundaries, duplication is controlled, complexity hot spots have explicit follow-up notes or tests, and dead code is removed. | Automated complexity trend reports. |

## Exit Criteria

The final quality review may mark the repository 10/10 only when all of these
conditions are true:

- The score is 10/10 using the rubric above.
- `npm run format:check`, `npm run lint`, `npm run typecheck`,
  `npm run schema:graph`, `npm run build`, `npm test`, `npm run test:visualizer`,
  `npm run smoke:migration`, and `npm run release:check` pass locally, or a
  documented environment-specific exception explains why browser or smoke checks
  cannot run before rerunning them in a supported environment.
- CI runs the same required checks or documents the exact unsupported smoke
  condition and still runs the remaining gate.
- Every public behavior change is reflected in compatibility docs, README
  examples, and tests.
- Every security-sensitive boundary has a test or documented manual audit note.
- The release checklist in `docs/release-checklist.md` has been completed,
  including package dry-run review and changelog summary.
- The final review records each criterion as satisfied or names an explicit
  exception with owner, risk, and follow-up.

## Rubric Details

Use this scoring rule for each criterion:

- `1`: Required evidence exists, is current, and is enforced by tests, CI, or a
  documented review step.
- `0`: Required evidence is missing, stale, untested, or contradicted by code.

Nice-to-have polish is deliberately excluded from the score. It can improve the
repository after the 10/10 gate, but it must not block completion unless it is
needed to satisfy required evidence.

The following blockers cap the final score below 10/10 until fixed:

- A known high-severity correctness bug in readiness, mutation, locking, or
  graph persistence.
- A known path traversal, unescaped HTML/script injection, unsafe public bind,
  or report/write escape.
- A public CLI, JSON, graph, worker, visualizer, report, or renderer contract
  break without tests and documentation.
- A required local or CI quality command failing without a documented
  environment-specific exception.
- A flaky test that regularly fails without code changes.

## Parallel Branch Coverage

Every parallel branch in `plan-improve.graph.json` maps to at least one
criterion:

| Branch | Criteria improved |
|---|---|
| `GRAPH_MODEL` | 1, 5, 8 |
| `SCHEDULER_CORRECTNESS` | 2, 5, 6 |
| `LOCKING_STORAGE` | 3, 6, 7 |
| `SECURITY` | 4, 5, 6 |
| `CLI_UX` | 5, 6, 7, 8 |
| `WORKER_RUNTIME` | 5, 7, 8 |
| `VISUALIZER_RENDERER` | 4, 6, 7, 8 |
| `TEST_STRATEGY` | 6, 9, 10 |
| `CI_RELEASE` | 6, 9 |
| `OBSERVABILITY` | 7, 8 |
| `DOCUMENTATION` | 5, 8 |
| `ARCHITECTURE_MAINTAINABILITY` | 6, 10 |

## Non-Goals

These are outside the 10/10 scope unless a future plan explicitly adds them:

- Turning the local scheduler into a hosted multi-tenant service.
- Supporting untrusted public visualizer access without additional auth design.
- Replacing the plain JSON graph format with a database or remote API.
- Guaranteeing compatibility for invalid graphs that were previously accepted by
  accident.
- Supporting Node versions older than the package `engines` requirement.
- Adding Slack, Codex, or browser credentials to CI.
- Rewriting working modules solely for style when behavior, tests, contracts,
  and docs already satisfy the rubric.
- Blocking release on optional polish listed in the nice-to-have column.
