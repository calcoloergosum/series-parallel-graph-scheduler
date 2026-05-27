#!/usr/bin/env node
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";

import type { GraphNode, PlanGraphFile } from "./contracts.js";
import { claimNode, completeNode, renewNodeLease, resetNode, startNode } from "./plan-scheduler.js";
import { errorMessage } from "./shared-utils.js";

const mutationPaths = ["claim", "start", "renew", "done", "reset"] as const;
type MutationPath = typeof mutationPaths[number];

interface BenchmarkOptions {
  concurrencyLevels: number[];
  rounds: number;
  paths: MutationPath[];
  keepGraphs: boolean;
  json: boolean;
  lockTimeoutMs?: number;
  lockRetryMs?: number;
  p95ThresholdMs: number;
}

interface TimedMutation {
  latencyMs: number;
  ok: boolean;
  message?: string;
}

interface BenchmarkRow {
  path: MutationPath;
  concurrency: number;
  rounds: number;
  samples: number;
  errors: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  meanMs: number;
  wallMs: number;
  suggestedTimeoutMs: number;
  threshold: "ok" | "warn";
}

export async function runLockContentionBenchmark(options: Partial<BenchmarkOptions> = {}): Promise<BenchmarkRow[]> {
  const benchmarkOptions = normalizeOptions(options);
  const previousTimeoutMs = process.env.SPG_GRAPH_LOCK_TIMEOUT_MS;
  const previousRetryMs = process.env.SPG_GRAPH_LOCK_RETRY_MS;
  if (benchmarkOptions.lockTimeoutMs !== undefined) {
    process.env.SPG_GRAPH_LOCK_TIMEOUT_MS = String(benchmarkOptions.lockTimeoutMs);
  }
  if (benchmarkOptions.lockRetryMs !== undefined) {
    process.env.SPG_GRAPH_LOCK_RETRY_MS = String(benchmarkOptions.lockRetryMs);
  }

  const rootDir = await mkdtemp(join(tmpdir(), "spg-lock-contention-"));
  let failed = false;

  try {
    const rows: BenchmarkRow[] = [];
    for (const path of benchmarkOptions.paths) {
      for (const concurrency of benchmarkOptions.concurrencyLevels) {
        rows.push(await runScenario({
          rootDir,
          path,
          concurrency,
          rounds: benchmarkOptions.rounds,
          p95ThresholdMs: benchmarkOptions.p95ThresholdMs
        }));
      }
    }

    failed = rows.some((row) => row.errors > 0);
    return rows;
  } finally {
    restoreEnv("SPG_GRAPH_LOCK_TIMEOUT_MS", previousTimeoutMs);
    restoreEnv("SPG_GRAPH_LOCK_RETRY_MS", previousRetryMs);
    if (!benchmarkOptions.keepGraphs && !failed) {
      await rm(rootDir, { recursive: true, force: true });
    } else {
      console.error(`benchmark graphs retained at ${rootDir}`);
    }
  }
}

async function runScenario({
  rootDir,
  path,
  concurrency,
  rounds,
  p95ThresholdMs
}: {
  rootDir: string;
  path: MutationPath;
  concurrency: number;
  rounds: number;
  p95ThresholdMs: number;
}): Promise<BenchmarkRow> {
  const timings: TimedMutation[] = [];
  let wallMs = 0;

  for (let round = 0; round < rounds; round += 1) {
    const graphPath = join(rootDir, `${path}-${concurrency}-${round}`, "plan.graph.json");
    await writeBenchmarkGraph(graphPath, path, concurrency);
    const startedAt = performance.now();
    timings.push(...await Promise.all(Array.from({ length: concurrency }, (_, index) => {
      return timeMutation(() => runMutation(graphPath, path, index));
    })));
    wallMs += performance.now() - startedAt;
  }

  const latencies = timings.map((timing) => timing.latencyMs).sort((left, right) => left - right);
  const maxMs = percentile(latencies, 1);
  return {
    path,
    concurrency,
    rounds,
    samples: timings.length,
    errors: timings.filter((timing) => !timing.ok).length,
    minMs: percentile(latencies, 0),
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
    maxMs,
    meanMs: latencies.reduce((sum, value) => sum + value, 0) / Math.max(1, latencies.length),
    wallMs,
    suggestedTimeoutMs: suggestedTimeout(maxMs),
    threshold: percentile(latencies, 0.95) <= p95ThresholdMs ? "ok" : "warn"
  };
}

async function timeMutation(fn: () => Promise<unknown>): Promise<TimedMutation> {
  const startedAt = performance.now();
  try {
    await fn();
    return { ok: true, latencyMs: performance.now() - startedAt };
  } catch (error) {
    return { ok: false, latencyMs: performance.now() - startedAt, message: errorMessage(error) };
  }
}

async function runMutation(graphPath: string, path: MutationPath, index: number): Promise<unknown> {
  const nodeId = nodeIdFor(index);
  const session = sessionFor(index);
  const runId = runIdFor(index);
  switch (path) {
    case "claim":
      return claimNode(graphPath, { nodeId, session, leaseSeconds: 60 });
    case "start":
      return startNode(graphPath, { nodeId, session, runId });
    case "renew":
      return renewNodeLease(graphPath, { nodeId, session, runId, leaseSeconds: 120 });
    case "done":
      return completeNode(graphPath, { nodeId, session, runId });
    case "reset":
      return resetNode(graphPath, { nodeId, reason: "lock contention benchmark" });
  }
}

async function writeBenchmarkGraph(graphPath: string, path: MutationPath, concurrency: number): Promise<void> {
  await mkdir(dirname(graphPath), { recursive: true });
  await writeFile(graphPath, `${JSON.stringify(benchmarkGraph(path, concurrency), null, 2)}\n`, "utf8");
}

function benchmarkGraph(path: MutationPath, concurrency: number): PlanGraphFile {
  const nodes: Record<string, GraphNode> = {
    ROOT: {
      title: "Lock contention benchmark",
      kind: "parallel",
      status: path === "reset" ? "done" : "pending",
      children: Array.from({ length: concurrency }, (_, index) => nodeIdFor(index))
    }
  };

  for (let index = 0; index < concurrency; index += 1) {
    nodes[nodeIdFor(index)] = nodeForPath(path, index);
  }

  return {
    graphVersion: 1,
    title: "Lock Contention Benchmark",
    scheduler: { leaseSeconds: 60 },
    graph: {
      root: "ROOT",
      nodes
    }
  };
}

function nodeForPath(path: MutationPath, index: number): GraphNode {
  const base = {
    title: `Benchmark node ${index}`,
    kind: "task" as const
  };
  if (path === "claim") {
    return { ...base, status: "pending" };
  }
  if (path === "reset") {
    return { ...base, status: "done", completedAt: "2026-05-27T00:00:00.000Z" };
  }
  return {
    ...base,
    status: path === "start" ? "claimed" : "running",
    lease: {
      session: sessionFor(index),
      runId: runIdFor(index),
      claimedAt: "2026-05-27T00:00:00.000Z",
      expiresAt: "2999-01-01T00:00:00.000Z"
    }
  };
}

function percentile(sortedValues: number[], rank: number): number {
  if (sortedValues.length === 0) {
    return 0;
  }
  if (rank <= 0) {
    return sortedValues[0];
  }
  if (rank >= 1) {
    return sortedValues[sortedValues.length - 1];
  }
  return sortedValues[Math.ceil(sortedValues.length * rank) - 1];
}

function suggestedTimeout(maxMs: number): number {
  return Math.max(5000, Math.ceil((maxMs * 2) / 100) * 100);
}

function nodeIdFor(index: number): string {
  return `BENCH_${String(index).padStart(4, "0")}`;
}

function sessionFor(index: number): string {
  return `bench-${index}`;
}

function runIdFor(index: number): string {
  return `run-bench-${index}`;
}

function normalizeOptions(options: Partial<BenchmarkOptions>): BenchmarkOptions {
  return {
    concurrencyLevels: options.concurrencyLevels ?? [1, 2, 4, 8, 16],
    rounds: options.rounds ?? 3,
    paths: options.paths ?? [...mutationPaths],
    keepGraphs: options.keepGraphs ?? false,
    json: options.json ?? false,
    ...(options.lockTimeoutMs !== undefined ? { lockTimeoutMs: options.lockTimeoutMs } : {}),
    ...(options.lockRetryMs !== undefined ? { lockRetryMs: options.lockRetryMs } : {}),
    p95ThresholdMs: options.p95ThresholdMs ?? 2500
  };
}

function parseArgs(argv: string[]): BenchmarkOptions {
  const options = normalizeOptions({});
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") {
      printHelp();
      process.exit(0);
    }
    if (arg === "--keep-graphs") {
      options.keepGraphs = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--concurrency" || arg === "--paths") {
      const value = readValue(argv, index, arg);
      if (arg === "--concurrency") {
        options.concurrencyLevels = parseIntegerList(value, arg);
      } else {
        options.paths = parsePathList(value);
      }
      index += 1;
      continue;
    }
    if (arg === "--rounds" || arg === "--lock-timeout-ms" || arg === "--lock-retry-ms" || arg === "--p95-threshold-ms") {
      const parsed = parsePositiveInteger(readValue(argv, index, arg), arg);
      if (arg === "--rounds") {
        options.rounds = parsed;
      } else if (arg === "--lock-timeout-ms") {
        options.lockTimeoutMs = parsed;
      } else if (arg === "--lock-retry-ms") {
        options.lockRetryMs = parsed;
      } else {
        options.p95ThresholdMs = parsed;
      }
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function readValue(argv: string[], index: number, arg: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${arg}`);
  }
  return value;
}

function parseIntegerList(value: string, arg: string): number[] {
  const parsed = value.split(",").map((item) => parsePositiveInteger(item.trim(), arg));
  return [...new Set(parsed)].sort((left, right) => left - right);
}

function parsePathList(value: string): MutationPath[] {
  const parsed: MutationPath[] = [];
  const rawValues = value.split(",").map((item) => item.trim());
  for (const item of rawValues) {
    if (!isMutationPath(item)) {
      throw new Error(`Unknown mutation path: ${item}`);
    }
    parsed.push(item);
  }
  return parsed;
}

function isMutationPath(value: string): value is MutationPath {
  return mutationPaths.some((path) => path === value);
}

function parsePositiveInteger(value: string, arg: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${arg} must be a positive integer`);
  }
  return parsed;
}

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previous;
  }
}

function printRows(rows: BenchmarkRow[], options: BenchmarkOptions): void {
  console.log("Lock contention benchmark");
  console.log(`rounds=${options.rounds} concurrency=${options.concurrencyLevels.join(",")} paths=${options.paths.join(",")}`);
  console.log(`lockTimeoutMs=${process.env.SPG_GRAPH_LOCK_TIMEOUT_MS || "default"} lockRetryMs=${process.env.SPG_GRAPH_LOCK_RETRY_MS || "default"} p95ThresholdMs=${options.p95ThresholdMs}`);
  console.log("");
  console.log("path   conc  samples  errors  p50_ms  p95_ms  max_ms  wall_ms  suggested_timeout_ms  threshold");
  for (const row of rows) {
    console.log([
      row.path.padEnd(6),
      String(row.concurrency).padStart(4),
      String(row.samples).padStart(7),
      String(row.errors).padStart(6),
      formatMs(row.p50Ms).padStart(6),
      formatMs(row.p95Ms).padStart(6),
      formatMs(row.maxMs).padStart(6),
      formatMs(row.wallMs).padStart(7),
      String(row.suggestedTimeoutMs).padStart(20),
      row.threshold
    ].join("  "));
  }
}

function formatMs(value: number): string {
  return value.toFixed(1);
}

function printHelp(): void {
  console.log(`Usage: node dist/scripts/benchmark-lock-contention.js [flags]

Manual benchmark for graph lock contention. This command creates temporary
graphs and runs concurrent claim/start/renew/done/reset mutations against them.

Flags:
  --concurrency LIST       Comma-separated concurrency levels. Default: 1,2,4,8,16
  --rounds N              Rounds per path/concurrency level. Default: 3
  --paths LIST            Comma-separated paths from ${mutationPaths.join(",")}. Default: all
  --lock-timeout-ms N     Override SPG_GRAPH_LOCK_TIMEOUT_MS for this run.
  --lock-retry-ms N       Override SPG_GRAPH_LOCK_RETRY_MS for this run.
  --p95-threshold-ms N    Warn threshold for p95 mutation latency. Default: 2500
  --keep-graphs           Keep temporary benchmark graphs for inspection.
  --json                  Print JSON instead of a text table.
`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const rows = await runLockContentionBenchmark(options);
    if (options.json) {
      console.log(JSON.stringify({ rows }, null, 2));
    } else {
      printRows(rows, options);
    }
    if (rows.some((row) => row.errors > 0)) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 1;
  }
}
