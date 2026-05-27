# Lock Contention Benchmark

`npm run benchmark:lock-contention` is a manual release and operator diagnostic
command for measuring graph mutation latency under controlled local contention.
It is intentionally not part of normal CI because lock wait latency depends on
the host filesystem, CPU scheduling, and active background load.

The benchmark creates disposable temporary graphs and runs concurrent
`claim`, `start`, `renew`, `done`, and `reset` mutations through the same public
mutation functions used by the CLI. Each mutation acquires the graph lock, reads
and validates the graph, writes through the atomic temp-file and rename path, and
releases the lock.

## Command

```bash
npm run benchmark:lock-contention
```

Useful variants:

```bash
npm run benchmark:lock-contention -- --concurrency 1,2,4,8,16,32 --rounds 5
npm run benchmark:lock-contention -- --paths claim,done --json
npm run benchmark:lock-contention -- --lock-timeout-ms 10000 --lock-retry-ms 25
```

The default run uses concurrency levels `1,2,4,8,16`, three rounds per level,
and the lock implementation defaults unless `SPG_GRAPH_LOCK_TIMEOUT_MS`,
`SPG_GRAPH_LOCK_RETRY_MS`, or matching flags are supplied.

## Interpreting Results

Rows report per-mutation latency, not full worker runtime:

- `p50_ms`: median mutation latency.
- `p95_ms`: practical contention budget for ordinary bursts.
- `max_ms`: worst observed mutation latency in the sample.
- `wall_ms`: total elapsed time for all rounds in that row.
- `suggested_timeout_ms`: at least twice the observed max, rounded up, with a
  floor of 5000 ms.
- `threshold`: `ok` when p95 is at or below the configured threshold. The
  default threshold is 2500 ms.

For supported local macOS and Linux filesystems, a normal development machine
should keep 16-way mutation bursts below 2500 ms p95 and below the default
5000 ms lock timeout. A p95 above 2500 ms at 16-way contention is not a release
failure by itself, but it should be recorded with the filesystem type, Node.js
version, and system load before relying on highly parallel workers.

For 32 or more concurrent mutators, use the larger of 5000 ms and the reported
`suggested_timeout_ms` as timeout guidance. If p95 approaches the timeout, raise
`SPG_GRAPH_LOCK_TIMEOUT_MS` or reduce worker parallelism. If any row reports
errors, inspect whether the messages are lock timeouts; timeout rows mean the
current lock timeout is too low for the requested contention level or the graph
is on an unsuitable filesystem.

## Filesystem Expectations

The lock design is supported on local filesystems with coherent atomic `mkdir`,
same-directory `rename`, directory `mtime`, and metadata visibility. Networked,
synced, or cloud-mounted directories are not a supported correctness boundary
for concurrent workers. On those filesystems, the expected safe outcome under
contention is bounded waiting followed by timeout diagnostics, not guaranteed
mutual exclusion.
