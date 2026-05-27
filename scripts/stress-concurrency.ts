#!/usr/bin/env node
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { validatePlanGraphFileResult, type PlanGraphFile } from "./contracts.js";
import {
  claimNode,
  completeNode,
  decomposeNode,
  failNode,
  readGraph,
  releaseExpiredLeases,
  renewNodeLease,
  resetNode,
  startNode
} from "./plan-scheduler.js";
import { errorMessage, sleep } from "./shared-utils.js";

interface StressOptions {
  iterations: number;
  seed: number;
  keepFailed: boolean;
}

interface OperationTraceEntry {
  phase: string;
  op: string;
  status: "ok" | "error";
  graphVersionBefore?: number;
  graphVersionAfter?: number;
  nodeId?: string;
  runId?: string;
  message?: string;
}

interface ClaimOwner {
  nodeId: string;
  session: string;
  runId: string;
}

class StressInvariantError extends Error {
  constructor(message: string, readonly context: Record<string, unknown>) {
    super(`${message}\n${JSON.stringify(context, null, 2)}`);
    this.name = "StressInvariantError";
  }
}

export async function runDeterministicConcurrencyStress(options: Partial<StressOptions> = {}): Promise<void> {
  const stressOptions = normalizeOptions(options);
  const previousLockRetryMs = process.env.SPG_GRAPH_LOCK_RETRY_MS;
  process.env.SPG_GRAPH_LOCK_RETRY_MS ||= "1";
  const rootDir = await mkdtemp(join(tmpdir(), "spg-concurrency-stress-"));
  let failed = false;

  try {
    for (let index = 0; index < stressOptions.iterations; index += 1) {
      const iterationSeed = mixSeed(stressOptions.seed, index);
      const graphDir = join(rootDir, `iteration-${String(index).padStart(4, "0")}`);
      const graphPath = join(graphDir, "plan.graph.json");
      const trace: OperationTraceEntry[] = [];

      try {
        await writeStressGraph(graphPath);
        await runStressIteration({ graphPath, seed: iterationSeed, trace });
      } catch (error) {
        failed = true;
        throw new StressInvariantError("Deterministic concurrency stress iteration failed", {
          seed: stressOptions.seed,
          iteration: index,
          iterationSeed,
          graphPath,
          trace,
          cause: errorMessage(error)
        });
      }
    }
  } finally {
    if (previousLockRetryMs === undefined) {
      delete process.env.SPG_GRAPH_LOCK_RETRY_MS;
    } else {
      process.env.SPG_GRAPH_LOCK_RETRY_MS = previousLockRetryMs;
    }
    if (!failed || !stressOptions.keepFailed) {
      await rm(rootDir, { recursive: true, force: true });
    }
  }
}

async function runStressIteration({
  graphPath,
  seed,
  trace
}: {
  graphPath: string;
  seed: number;
  trace: OperationTraceEntry[];
}): Promise<void> {
  const random = mulberry32(seed);

  const sameNodeClaims = await runConcurrentPhase({
    graphPath,
    phase: "same-node-claim",
    trace,
    random,
    operations: Array.from({ length: 8 }, (_, index) => ({
      name: `claim-shared-${index}`,
      run: () => claimNode(graphPath, { nodeId: "CLAIM_0", session: `shared-${index}`, leaseSeconds: 60 })
    }))
  });
  const sameNodeSuccesses = fulfilledClaims(sameNodeClaims);
  assertInvariant(sameNodeSuccesses.length === 1, "same-node claim race produced multiple winners", {
    graphPath,
    trace,
    sameNodeSuccesses
  });
  assertGraphVersion(graphPath, 2, "same-node claim race should increment once", trace);

  const genericClaims = await runConcurrentPhase({
    graphPath,
    phase: "generic-claim-burst",
    trace,
    random,
    operations: Array.from({ length: 12 }, (_, index) => ({
      name: `claim-explicit-${index}`,
      run: () => claimNode(graphPath, {
        nodeId: `CLAIM_${(index % 5) + 1}`,
        session: `generic-${index}`,
        leaseSeconds: 60
      })
    }))
  });
  const claimedOwners = [...sameNodeSuccesses, ...fulfilledClaims(genericClaims)];
  const claimedNodeIds = claimedOwners.map((claim) => claim.nodeId);
  assertInvariant(new Set(claimedNodeIds).size === claimedNodeIds.length, "claim burst double-claimed a leaf", {
    graphPath,
    trace,
    claimedNodeIds
  });
  assertInvariant(claimedOwners.length === 6, "claim burst did not claim every ready leaf exactly once", {
    graphPath,
    trace,
    claimedNodeIds
  });
  assertGraphVersion(graphPath, 7, "claim burst graphVersion lost an increment", trace);

  await runConcurrentPhase({
    graphPath,
    phase: "lifecycle-race",
    trace,
    random,
    operations: shuffle([
      {
        name: "start",
        run: () => startNode(graphPath, { nodeId: "START", session: "start-owner", runId: "run-start" })
      },
      {
        name: "renew",
        run: () => renewNodeLease(graphPath, {
          nodeId: "RENEW",
          session: "renew-owner",
          runId: "run-renew",
          leaseSeconds: 120
        })
      },
      {
        name: "done",
        run: () => completeNode(graphPath, {
          nodeId: "DONE",
          session: "done-owner",
          runId: "run-done",
          report: "reports/done.md"
        })
      },
      {
        name: "fail",
        run: () => failNode(graphPath, {
          nodeId: "FAIL",
          session: "fail-owner",
          runId: "run-fail",
          reason: "stress failure path",
          report: "reports/fail.md"
        })
      },
      {
        name: "reset",
        run: () => resetNode(graphPath, { nodeId: "RESET", reason: "stress retry" })
      },
      {
        name: "release-expired",
        run: () => releaseExpiredLeases(graphPath, new Date("2026-05-27T00:00:01.000Z"))
      },
      {
        name: "decompose",
        run: () => decomposeNode(graphPath, {
          nodeId: "DECOMPOSE",
          session: "decompose-owner",
          runId: "run-decompose",
          kind: "series",
          children: [
            { id: "DECOMPOSE_1", title: "First decomposed child" },
            { id: "DECOMPOSE_2", title: "Second decomposed child" }
          ]
        })
      }
    ], random)
  });
  assertGraphVersion(graphPath, 13, "lifecycle race graphVersion lost an increment", trace);

  await runConcurrentPhase({
    graphPath,
    phase: "complete-claimed",
    trace,
    random,
    operations: shuffle(claimedOwners.map((owner) => ({
      name: `complete-${owner.nodeId}`,
      run: () => completeNode(graphPath, {
        nodeId: owner.nodeId,
        session: owner.session,
        runId: owner.runId,
        report: `reports/${owner.nodeId}.md`
      })
    })), random)
  });
  assertGraphVersion(graphPath, 19, "claim completion graphVersion lost an increment", trace);

  await assertFinalGraph(graphPath, trace);
}

async function runConcurrentPhase({
  graphPath,
  phase,
  trace,
  random,
  operations
}: {
  graphPath: string;
  phase: string;
  trace: OperationTraceEntry[];
  random: () => number;
  operations: Array<{ name: string; run: () => Promise<unknown> }>;
}): Promise<Array<PromiseSettledResult<unknown>>> {
  const scheduled = operations.map((operation) => ({
    ...operation,
    delayMs: Math.floor(random() * 5)
  }));

  const results = await Promise.allSettled(scheduled.map(async (operation) => {
    await sleep(operation.delayMs);
    const before = await currentGraphVersion(graphPath);
    try {
      const value = await operation.run();
      trace.push({
        phase,
        op: operation.name,
        status: "ok",
        graphVersionBefore: before,
        graphVersionAfter: await currentGraphVersion(graphPath),
        ...traceResult(value)
      });
      return value;
    } catch (error) {
      trace.push({
        phase,
        op: operation.name,
        status: "error",
        graphVersionBefore: before,
        graphVersionAfter: await currentGraphVersion(graphPath),
        message: errorMessage(error)
      });
      throw error;
    }
  }));

  return results;
}

function fulfilledClaims(results: Array<PromiseSettledResult<unknown>>): ClaimOwner[] {
  return results
    .filter((result): result is PromiseFulfilledResult<unknown> => result.status === "fulfilled")
    .map((result) => {
      const value = result.value as { nodeId?: unknown; lease?: { session?: unknown }; runId?: unknown };
      return {
        nodeId: String(value.nodeId),
        session: String(value.lease?.session),
        runId: String(value.runId)
      };
    });
}

async function assertFinalGraph(graphPath: string, trace: OperationTraceEntry[]): Promise<void> {
  const raw = await readFile(graphPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  const validation = validatePlanGraphFileResult(parsed);
  assertInvariant(validation.errors.length === 0, "final graph failed schema validation", {
    graphPath,
    trace,
    errors: validation.errors
  });

  const graph = parsed as PlanGraphFile;
  const nodes = graph.graph.nodes;
  assertInvariant(nodes.CLAIM_0.status === "done", "claimed node did not complete", { graphPath, trace });
  assertInvariant(nodes.START.status === "running", "start race did not leave node running", { graphPath, trace });
  assertInvariant(nodes.RENEW.lease?.renewedAt !== undefined, "renew race did not persist renewal", { graphPath, trace });
  assertInvariant(nodes.DONE.status === "done", "done race did not complete node", { graphPath, trace });
  assertInvariant(nodes.FAIL.status === "failed", "fail race did not fail node", { graphPath, trace });
  assertInvariant(nodes.RESET.status === "pending", "reset race did not reopen node", { graphPath, trace });
  assertInvariant(nodes.EXPIRE.status === "pending", "expired lease was not released", { graphPath, trace });
  assertInvariant(nodes.DECOMPOSE.children?.length === 2, "decompose race did not create children", { graphPath, trace });
}

async function assertGraphVersion(
  graphPath: string,
  expectedGraphVersion: number,
  message: string,
  trace: OperationTraceEntry[]
): Promise<void> {
  const graph = await readGraph(graphPath);
  assertInvariant(graph.graphVersion === expectedGraphVersion, message, {
    graphPath,
    expectedGraphVersion,
    actualGraphVersion: graph.graphVersion,
    trace
  });
}

function assertInvariant(condition: boolean, message: string, context: Record<string, unknown>): asserts condition {
  if (!condition) {
    throw new StressInvariantError(message, context);
  }
}

async function currentGraphVersion(graphPath: string): Promise<number | undefined> {
  return (await readGraph(graphPath)).graphVersion;
}

function traceResult(value: unknown): Partial<OperationTraceEntry> {
  if (!value || typeof value !== "object") {
    return {};
  }
  const result = value as { nodeId?: unknown; runId?: unknown };
  return {
    ...(typeof result.nodeId === "string" ? { nodeId: result.nodeId } : {}),
    ...(typeof result.runId === "string" ? { runId: result.runId } : {})
  };
}

async function writeStressGraph(graphPath: string): Promise<void> {
  await mkdir(dirname(graphPath), { recursive: true });
  await writeFile(graphPath, `${JSON.stringify(stressGraph(), null, 2)}\n`, "utf8");
}

function stressGraph(): PlanGraphFile {
  const future = "2999-01-01T00:00:00.000Z";
  const expired = "2026-05-27T00:00:00.000Z";
  const leasedNode = (title: string, status: "claimed" | "running", session: string, runId: string, expiresAt = future) => ({
    title,
    kind: "task",
    status,
    lease: {
      session,
      runId,
      claimedAt: "2026-05-27T00:00:00.000Z",
      expiresAt
    }
  });

  return {
    graphVersion: 1,
    title: "Deterministic Concurrency Stress Plan",
    scheduler: { leaseSeconds: 30 },
    graph: {
      root: "ROOT",
      nodes: {
        ROOT: {
          title: "Root",
          kind: "parallel",
          status: "pending",
          children: [
            "CLAIM_0",
            "CLAIM_1",
            "CLAIM_2",
            "CLAIM_3",
            "CLAIM_4",
            "CLAIM_5",
            "START",
            "RENEW",
            "DONE",
            "FAIL",
            "RESET",
            "EXPIRE",
            "DECOMPOSE"
          ]
        },
        CLAIM_0: { title: "Claim race zero", kind: "task", status: "pending" },
        CLAIM_1: { title: "Claim race one", kind: "task", status: "pending" },
        CLAIM_2: { title: "Claim race two", kind: "task", status: "pending" },
        CLAIM_3: { title: "Claim race three", kind: "task", status: "pending" },
        CLAIM_4: { title: "Claim race four", kind: "task", status: "pending" },
        CLAIM_5: { title: "Claim race five", kind: "task", status: "pending" },
        START: leasedNode("Start concurrently", "claimed", "start-owner", "run-start"),
        RENEW: leasedNode("Renew concurrently", "running", "renew-owner", "run-renew"),
        DONE: leasedNode("Complete concurrently", "running", "done-owner", "run-done"),
        FAIL: leasedNode("Fail concurrently", "running", "fail-owner", "run-fail"),
        RESET: { title: "Reset concurrently", kind: "task", status: "done", report: "reports/reset.md" },
        EXPIRE: leasedNode("Release expired concurrently", "running", "expired-owner", "run-expired", expired),
        DECOMPOSE: leasedNode("Decompose concurrently", "running", "decompose-owner", "run-decompose")
      }
    }
  };
}

function shuffle<T>(values: T[], random: () => number): T[] {
  const shuffled = [...values];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function mixSeed(seed: number, iteration: number): number {
  return (seed ^ Math.imul(iteration + 1, 0x9E3779B1)) >>> 0;
}

function normalizeOptions(options: Partial<StressOptions>): StressOptions {
  return {
    iterations: options.iterations ?? 100,
    seed: options.seed ?? 0xC0FFEE,
    keepFailed: options.keepFailed ?? false
  };
}

function parseStressArgs(argv: string[]): StressOptions {
  const options = normalizeOptions({});
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--keep-failed") {
      options.keepFailed = true;
      continue;
    }
    if (arg === "--iterations" || arg === "--seed") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for ${arg}`);
      }
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new Error(`${arg} must be a non-negative integer`);
      }
      if (arg === "--iterations") {
        if (parsed < 1) {
          throw new Error("--iterations must be at least 1");
        }
        options.iterations = parsed;
      } else {
        options.seed = parsed >>> 0;
      }
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const options = parseStressArgs(process.argv.slice(2));
    await runDeterministicConcurrencyStress(options);
    console.log(`deterministic concurrency stress passed: iterations=${options.iterations} seed=${options.seed}`);
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 1;
  }
}
