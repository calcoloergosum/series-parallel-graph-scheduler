import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import type {
  CodexRunResult,
  GraphNode,
  GraphSummary,
  LeaseClaimResult,
  NodeIsolationDetails,
  NodeMutationResult,
  PlanGraphFile,
  ReadyNode,
  RenewLeaseResult,
  RunWorkerOptions,
  RunWorkerResult,
  SlackNotificationResult,
  WorkerRunRefMetadata,
  WorkerOutcome
} from "./contracts.js";
import {
  createWorkBranch,
  createRunClone,
  defaultBareRepositoryPath,
  prepareBareRepository,
  publishOutputRef,
  redactGitRemote,
  validateGitRemote
} from "./git-runtime.js";
import { nodeIsolationDetails } from "./graph-traversal.js";
import { numericArgumentRanges, parseNumericArgument } from "./numeric-args.js";
import { operationalEvents } from "./operational-events.js";
import { runtimePathsFromModuleUrl } from "./runtime-paths.js";
import { errorMessage, redactSecretText, safeFilePart, sleep } from "./shared-utils.js";

const { rootDir } = runtimePathsFromModuleUrl(import.meta.url);
const defaultGraphPath = resolve(rootDir, "plan.graph.json");
const workerProcessLimits = {
  commandLength: 4096,
  argCount: 64,
  argLength: 4096,
  cwdLength: 4096
} as const;

export interface WorkerRuntime {
  defaultGraphPath: string;
  defaultPromptTemplatePath: string;
  schedulerCommand: string;
  readGraph(graphPath: string): Promise<PlanGraphFile>;
  getNode(graph: PlanGraphFile, nodeId: string): GraphNode;
  listReadyLeafNodes(graph: PlanGraphFile): ReadyNode[];
  summarizeGraph(graph: PlanGraphFile): GraphSummary;
  defaultReportPath(nodeId: string, runId: string): string;
  claimNode(graphPath: string, options: {
    session?: string;
    nodeId?: string;
    leaseSeconds?: number;
    resolveBaseRef?: boolean;
  }): Promise<LeaseClaimResult>;
  startNode(graphPath: string, options: {
    nodeId?: string;
    session?: string;
    runId?: string;
  }): Promise<NodeMutationResult>;
  renewNodeLease(graphPath: string, options: {
    nodeId?: string;
    session?: string;
    runId?: string;
    leaseSeconds?: number;
  }): Promise<RenewLeaseResult>;
  completeNode(graphPath: string, options: {
    nodeId?: string;
    report?: string;
    session?: string;
    runId?: string;
    refMetadata?: WorkerRunRefMetadata;
  }): Promise<NodeMutationResult>;
  failNode(graphPath: string, options: {
    nodeId?: string;
    reason?: string;
    report?: string;
    session?: string;
    runId?: string;
    refMetadata?: WorkerRunRefMetadata;
  }): Promise<NodeMutationResult>;
  recordWorkerRefMetadata(graphPath: string, options: {
    nodeId?: string;
    report?: string;
    session?: string;
    runId?: string;
    refMetadata?: WorkerRunRefMetadata;
  }): Promise<NodeMutationResult>;
  writeReportFile(graphPath: string, reportPath: string | undefined, reportBody: unknown): Promise<unknown>;
  sendSlackNotification(
    graphPath: string,
    event: string,
    details?: Record<string, string | undefined>
  ): Promise<SlackNotificationResult>;
  renderPlanAfterUpdate(graphPath: string): Promise<void>;
}

export interface BuildWorkerPromptOptions {
  nodeId?: string;
  session?: string;
  runId?: string;
  templatePath?: string;
  cwd?: string;
  reportPath?: string;
}

export interface WaitForReadyJobOptions {
  session: string;
  graphPath: string;
  idleMs: number;
  stream: boolean;
}

export interface LeaseHeartbeat {
  stop(): void;
}

export interface RunCodexPromptOptions extends RunWorkerOptions {
  graphPath?: string;
  logPrefix?: string;
  abortSignal?: AbortSignal;
}

export type ResolvedWorkerIsolation =
  | { mode: "off" }
  | {
    mode: "git";
    remote: string;
    redactedRemote: string;
    remoteSource: "--remote" | "scheduler.remote";
    bareRepoPath: string;
    workspaceRoot: string;
    workspaceRetention: WorkerWorkspaceRetention;
  };

export type WorkerWorkspaceRetention = "on-failure" | "always" | "never";

export async function buildWorkerPrompt(
  graphPath: string,
  {
    nodeId,
    session,
    runId,
    templatePath,
    cwd = dirname(graphPath),
    reportPath
  }: BuildWorkerPromptOptions = {},
  runtime: WorkerRuntime
): Promise<string> {
  if (!nodeId) {
    throw new Error("Missing node id");
  }

  const graph = await runtime.readGraph(graphPath);
  const node = runtime.getNode(graph, nodeId);
  const template = await readFile(resolveTemplatePath(graphPath, templatePath, runtime.defaultPromptTemplatePath), "utf8");
  const ready = runtime.listReadyLeafNodes(graph);
  const effectiveRunId = runId || node.lease?.runId || "";
  const context = {
    cwd,
    graphPath,
    nodeId,
    runId: effectiveRunId,
    session: session || node.lease?.session || "codex",
    reportPath: reportPath || runtime.defaultReportPath(nodeId, effectiveRunId || "manual"),
    schedulerCommand: runtime.schedulerCommand,
    planTitle: graph.title || "",
    planDescription: graph.description || "",
    nodeTitle: node.title || nodeId,
    nodeKind: node.kind || "task",
    nodeStatus: node.status || "pending",
    nodeJson: JSON.stringify(node, null, 2),
    readyJson: JSON.stringify(ready, null, 2),
    summaryJson: JSON.stringify(runtime.summarizeGraph(graph), null, 2)
  };

  return renderPromptTemplate(template, context);
}

export async function runWorker(
  graphPath: string,
  options: RunWorkerOptions = {},
  runtime: WorkerRuntime
): Promise<RunWorkerResult> {
  const session = options.session || "codex-worker";
  const once = Boolean(options.once);
  const idleMs = parseNumericArgument(options.idleMs, { flag: "--idle-ms", ...numericArgumentRanges.idleMs, defaultValue: 5000 })!;
  const leaseSeconds = parseNumericArgument(options.leaseSeconds, { flag: "--lease", ...numericArgumentRanges.leaseSeconds });
  validateCodexProcessOptions(options, graphPath);
  const stream = options.stream !== false;
  const results: WorkerOutcome[] = [];

  while (true) {
    const isolation = await prepareBareRepositoryForIsolatedRun(graphPath, options, runtime);
    let claim: LeaseClaimResult;
    try {
      claim = await runtime.claimNode(graphPath, {
        session,
        nodeId: options.nodeId,
        leaseSeconds,
        resolveBaseRef: normalizeWorkerIsolationMode(options.isolation) === "git"
      });
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error);
      if (!message.includes("No ready nodes") && !message.includes("Node is not ready")) {
        throw error;
      }
      if (once) {
        return { session, idle: true, results };
      }
      await waitForReadyJob({ session, graphPath, idleMs, stream });
      continue;
    }

    await runtime.renderPlanAfterUpdate(graphPath);
    await runtime.startNode(graphPath, { nodeId: claim.nodeId, session, runId: claim.runId });
    await runtime.renderPlanAfterUpdate(graphPath);

    const refMetadata = isolation.mode === "git"
      ? await prepareIsolatedRunClone(graphPath, { isolation, claim, session }, runtime)
      : undefined;
    if (refMetadata) {
      await runtime.renderPlanAfterUpdate(graphPath);
    }

    const reportPath = options.reportPath || runtime.defaultReportPath(claim.nodeId, claim.runId);
    const workerCwd = refMetadata?.cloneCwd || options.cwd;
    const prompt = await buildWorkerPrompt(graphPath, {
      nodeId: claim.nodeId,
      session,
      runId: claim.runId,
      templatePath: options.templatePath,
      cwd: workerCwd,
      reportPath
    }, runtime);
    const abortController = new AbortController();
    const heartbeat = startLeaseHeartbeat(graphPath, {
      claim,
      session,
      leaseSeconds,
      onFailure: (error) => {
        if (!abortController.signal.aborted) {
          abortController.abort(`lease heartbeat failed: ${errorMessage(error)}`);
        }
      }
    }, runtime);
    const signalHandlers = installWorkerSignalHandlers(abortController);
    let run: CodexRunResult;
    try {
      run = await runCodexPrompt(prompt, {
        ...options,
        cwd: workerCwd,
        graphPath,
        logPrefix: `${session}:${claim.nodeId}`,
        abortSignal: abortController.signal
      });
    } finally {
      heartbeat.stop();
      signalHandlers.restore();
    }
    const outcome = await finalizeWorkerRun(graphPath, { claim, session, run, reportPath, refMetadata }, runtime);
    results.push(outcome);
    if (signalHandlers.interruptedSignal) {
      process.exitCode = signalExitCode(signalHandlers.interruptedSignal);
    }

    await runtime.renderPlanAfterUpdate(graphPath);
    if (once) {
      return { session, idle: false, results };
    }
  }
}

async function prepareBareRepositoryForIsolatedRun(
  graphPath: string,
  options: RunWorkerOptions,
  runtime: WorkerRuntime
): Promise<ResolvedWorkerIsolation> {
  if (normalizeWorkerIsolationMode(options.isolation) !== "git") {
    return { mode: "off" };
  }

  const graph = await runtime.readGraph(graphPath);
  const resolved = resolveWorkerIsolation(graphPath, graph, options);
  if (resolved.mode !== "git") {
    return resolved;
  }
  await prepareBareRepository({
    bareRepoPath: resolved.bareRepoPath,
    remote: resolved.remote
  });
  return resolved;
}

async function prepareIsolatedRunClone(
  graphPath: string,
  {
    isolation,
    claim,
    session
  }: {
    isolation: Extract<ResolvedWorkerIsolation, { mode: "git" }>;
    claim: LeaseClaimResult;
    session: string;
  },
  runtime: WorkerRuntime
): Promise<WorkerRunRefMetadata> {
  const clone = await createRunClone({
    bareRepoPath: isolation.bareRepoPath,
    cloneCwd: workerCloneCwd(isolation.workspaceRoot, session, claim.nodeId, claim.runId)
  });
  const baseRef = claim.baseRef?.name || "HEAD";
  const branch = await createWorkBranch({
    cloneCwd: clone.cloneCwd,
    nodeId: claim.nodeId,
    runId: claim.runId,
    baseRef,
    bareRepoPath: clone.bareRepoPath
  });
  const refMetadata: WorkerRunRefMetadata = {
    remote: isolation.remote,
    bareRepo: clone.bareRepoPath,
    cloneCwd: clone.cloneCwd,
    baseRef: {
      ...(claim.baseRef || { source: "graph-default" }),
      name: branch.baseRef,
      commit: claim.baseRef?.commit || branch.commit
    },
    workRef: {
      name: branch.workRef,
      commit: branch.commit
    },
    retained: isolation.workspaceRetention !== "never"
  };
  await runtime.recordWorkerRefMetadata(graphPath, {
    nodeId: claim.nodeId,
    session,
    runId: claim.runId,
    refMetadata
  });
  return refMetadata;
}

function workerCloneCwd(workspaceRoot: string, session: string, nodeId: string, runId: string): string {
  return join(
    workspaceRoot,
    safeFilePart(session),
    safeFilePart(nodeId),
    safeFilePart(runId)
  );
}

export function resolveWorkerIsolation(
  graphPath: string,
  graph: PlanGraphFile,
  options: Pick<RunWorkerOptions, "isolation" | "remote" | "workspaceRoot" | "workspaceRetention"> = {}
): ResolvedWorkerIsolation {
  const mode = normalizeWorkerIsolationMode(options.isolation);
  if (mode === "off") {
    return { mode };
  }

  const remoteSource = options.remote !== undefined ? "--remote" : "scheduler.remote";
  const remote = validateGitRemote(options.remote !== undefined ? options.remote : graph.scheduler?.remote);
  return {
    mode,
    remote,
    redactedRemote: redactGitRemote(remote),
    remoteSource,
    bareRepoPath: defaultBareRepositoryPath(graphPath),
    workspaceRoot: validateWorkerWorkspaceRoot(graphPath, options.workspaceRoot),
    workspaceRetention: validateWorkspaceRetention(options.workspaceRetention)
  };
}

function normalizeWorkerIsolationMode(mode: unknown): ResolvedWorkerIsolation["mode"] {
  if (mode === undefined || mode === null || mode === "") {
    return "off";
  }
  if (typeof mode !== "string") {
    throw new Error("Invalid --isolation: expected off or git");
  }
  const normalized = mode.trim();
  if (normalized === "off" || normalized === "git") {
    return normalized;
  }
  throw new Error(`Invalid --isolation: expected off or git; received ${JSON.stringify(mode)}`);
}

export function validateWorkspaceRetention(value: unknown): WorkerWorkspaceRetention {
  if (value === undefined || value === null || value === "") {
    return "on-failure";
  }
  if (typeof value !== "string") {
    throw new Error("Invalid --workspace-retention: expected on-failure, always, or never");
  }
  const normalized = value.trim();
  if (normalized === "on-failure" || normalized === "always" || normalized === "never") {
    return normalized;
  }
  throw new Error(`Invalid --workspace-retention: expected on-failure, always, or never; received ${JSON.stringify(value)}`);
}

export function validateWorkerWorkspaceRoot(graphPath: string, workspaceRoot?: string, repositoryRoot = rootDir): string {
  const graphDir = dirname(resolve(graphPath));
  const rawRoot = workspaceRoot === undefined || workspaceRoot === null || workspaceRoot === ""
    ? join(graphDir, "runs/workspaces")
    : String(workspaceRoot).trim();
  if (!rawRoot) {
    throw new Error("Invalid --workspace-root: expected non-empty path");
  }
  if (rawRoot.includes("\0")) {
    throw new Error("Invalid --workspace-root: null bytes are not allowed");
  }

  const resolvedRoot = isAbsolute(rawRoot) ? resolve(rawRoot) : resolve(graphDir, rawRoot);
  if (!isWithinPath(graphDir, resolvedRoot)) {
    throw new Error("Invalid --workspace-root: path must stay inside the graph directory");
  }
  if (samePath(resolvedRoot, resolve(graphPath))) {
    throw new Error("Invalid --workspace-root: path overlaps the graph file");
  }
  if (samePath(resolvedRoot, resolve(repositoryRoot))) {
    throw new Error("Invalid --workspace-root: path overlaps the repository root");
  }
  if (pathsOverlap(resolvedRoot, join(resolve(repositoryRoot), ".git"))) {
    throw new Error("Invalid --workspace-root: path overlaps the repository .git directory");
  }
  if (pathsOverlap(resolvedRoot, defaultBareRepositoryPath(graphPath))) {
    throw new Error("Invalid --workspace-root: path overlaps the bare repository cache");
  }
  return resolvedRoot;
}

function isWithinPath(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function samePath(left: string, right: string): boolean {
  return resolve(left) === resolve(right);
}

function pathsOverlap(left: string, right: string): boolean {
  return isWithinPath(left, right) || isWithinPath(right, left);
}

export async function waitForReadyJob({ session, graphPath, idleMs, stream }: WaitForReadyJobOptions): Promise<void> {
  if (!stream) {
    await sleep(idleMs);
    return;
  }

  const label = `[${session}] waiting for ready job in ${graphPath}`;
  if (!process.stdout.isTTY) {
    process.stdout.write(`${label}; next check in ${Math.round(idleMs / 1000)}s\n`);
    await sleep(idleMs);
    return;
  }

  const frames = ["-", "\\", "|", "/"];
  let index = 0;
  process.stdout.write("\x1B[?25l");
  const timer = setInterval(() => {
    process.stdout.write(`\r${frames[index % frames.length]} ${label}`);
    index += 1;
  }, 180);

  try {
    await sleep(idleMs);
  } finally {
    clearInterval(timer);
    process.stdout.write("\r\x1B[2K\x1B[?25h");
  }
}

export function startLeaseHeartbeat(
  graphPath: string,
  {
    claim,
    session,
    leaseSeconds,
    onFailure
  }: {
    claim: LeaseClaimResult;
    session: string;
    leaseSeconds?: number;
    onFailure?: (error: unknown) => void;
  },
  runtime: WorkerRuntime
): LeaseHeartbeat {
  const claimedAtMs = new Date(claim.lease?.claimedAt || Date.now()).getTime();
  const expiresAtMs = new Date(claim.lease?.expiresAt || Date.now() + 1800 * 1000).getTime();
  const leaseMs = Number.isFinite(expiresAtMs - claimedAtMs) && expiresAtMs > claimedAtMs
    ? expiresAtMs - claimedAtMs
    : (leaseSeconds ?? 1800) * 1000;
  const intervalMs = Math.max(250, Math.min(60_000, Math.floor(leaseMs / 3)));
  let stopped = false;
  let inFlight = false;

  const renew = async (): Promise<void> => {
    if (stopped || inFlight) {
      return;
    }
    inFlight = true;
    try {
      await runtime.renewNodeLease(graphPath, {
        nodeId: claim.nodeId,
        session,
        runId: claim.runId,
        leaseSeconds
      });
    } catch (error) {
      stopped = true;
      onFailure?.(error);
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(renew, intervalMs);
  timer.unref?.();

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    }
  };
}

export async function runCodexPrompt(prompt: string, options: RunCodexPromptOptions = {}): Promise<CodexRunResult> {
  const { command, commandArgs, cwd } = resolveCodexProcessOptions(options, options.graphPath || defaultGraphPath);
  const stream = options.stream !== false;
  const prefix = options.logPrefix ? `[${options.logPrefix}] ` : "";
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  const timeoutMs = parseNumericArgument(options.timeoutMs, { flag: "--timeout-ms", ...numericArgumentRanges.timeoutMs });

  const result = await new Promise<Omit<CodexRunResult, "command" | "args" | "cwd" | "startedAt" | "finishedAt" | "durationMs">>((resolveRun) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let abortReason: string | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let child: ReturnType<typeof spawn> | undefined;

    const cleanup = (): void => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
      if (killTimer) {
        clearTimeout(killTimer);
      }
      options.abortSignal?.removeEventListener("abort", abortChild);
    };

    const resolveOnce = (run: Omit<CodexRunResult, "command" | "args" | "cwd" | "startedAt" | "finishedAt" | "durationMs">): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolveRun({
        ...run,
        timedOut: run.timedOut ?? (timedOut ? true : undefined),
        timeoutMs: run.timeoutMs ?? (timedOut ? timeoutMs : undefined),
        aborted: run.aborted ?? (aborted ? true : undefined),
        abortReason: run.abortReason ?? abortReason
      });
    };

    const requestChildTermination = (reason: string): void => {
      aborted = true;
      abortReason = reason;
      if (!child || child.killed) {
        resolveOnce({ code: 1, stdout, stderr });
        return;
      }
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (child && !child.killed) {
          child.kill("SIGKILL");
        }
      }, 5000);
      killTimer.unref?.();
    };

    function abortChild(): void {
      requestChildTermination(formatAbortReason(options.abortSignal?.reason));
    }

    if (options.abortSignal?.aborted) {
      aborted = true;
      abortReason = formatAbortReason(options.abortSignal.reason);
      resolveOnce({ code: 1, stdout, stderr });
      return;
    }

    try {
      child = spawn(command, [...commandArgs, prompt], {
        cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      resolveOnce({ code: 1, error: errorMessage(error), stdout, stderr });
      return;
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk;
      if (stream) {
        process.stdout.write(prefixChunk(redactSecrets(String(chunk)), prefix));
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk;
      if (stream) {
        process.stderr.write(prefixChunk(redactSecrets(String(chunk)), prefix));
      }
    });
    child.on("error", (error) => {
      resolveOnce({ code: 1, error: error.message, stdout, stderr });
    });
    child.on("exit", (code, signal) => {
      resolveOnce({ code: code ?? 1, signal, stdout, stderr });
    });

    options.abortSignal?.addEventListener("abort", abortChild, { once: true });
    if (timeoutMs !== undefined) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        requestChildTermination(`timeout after ${timeoutMs}ms`);
      }, timeoutMs);
      timeoutTimer.unref?.();
    }
  });

  return {
    ...result,
    command,
    args: commandArgs,
    cwd,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAtMs
  };
}

function validateCodexProcessOptions(options: RunCodexPromptOptions, graphPath: string): void {
  resolveCodexProcessOptions(options, graphPath);
}

function resolveCodexProcessOptions(options: RunCodexPromptOptions, graphPath: string): {
  command: string;
  commandArgs: string[];
  cwd: string;
} {
  return {
    command: validateOptionalProcessString("codexCommand", options.codexCommand, "codex", workerProcessLimits.commandLength),
    commandArgs: validateCodexArgs(options.codexArgs),
    cwd: validateOptionalProcessString("cwd", options.cwd, dirname(graphPath), workerProcessLimits.cwdLength)
  };
}

function validateCodexArgs(value: unknown): string[] {
  if (value === undefined || value === null) {
    return ["exec"];
  }
  if (!Array.isArray(value)) {
    throw new Error("Invalid codexArgs: expected string array");
  }
  if (value.length > workerProcessLimits.argCount) {
    throw new Error(`Invalid codexArgs: expected at most ${workerProcessLimits.argCount} entries`);
  }
  return value.map((item, index) => validateProcessString(`codexArgs[${index}]`, item, workerProcessLimits.argLength));
}

function validateOptionalProcessString(field: string, value: unknown, defaultValue: string, maxLength: number): string {
  if (value === undefined || value === null) {
    return defaultValue;
  }
  return validateProcessString(field, value, maxLength);
}

function validateProcessString(field: string, value: unknown, maxLength: number): string {
  if (typeof value !== "string") {
    throw new Error(`Invalid ${field}: expected string`);
  }
  if (!value.trim()) {
    throw new Error(`Invalid ${field}: expected non-empty string`);
  }
  if (value.length > maxLength) {
    throw new Error(`Invalid ${field}: expected string length <= ${maxLength}`);
  }
  if (value.includes("\0")) {
    throw new Error(`Invalid ${field}: null bytes are not allowed`);
  }
  return value;
}

export function prefixChunk(chunk: Buffer | string, prefix: string): Buffer | string {
  if (!prefix) {
    return chunk;
  }
  return String(chunk)
    .split(/(\r?\n)/)
    .map((part, index, parts) => {
      if (part === "\n" || part === "\r\n" || part === "") {
        return part;
      }
      const previous = parts[index - 1];
      return index === 0 || previous === "\n" || previous === "\r\n" ? `${prefix}${part}` : part;
    })
    .join("");
}

export async function finalizeWorkerRun(
  graphPath: string,
  {
    claim,
    session,
    run,
    reportPath,
    refMetadata
  }: { claim: LeaseClaimResult; session: string; run: CodexRunResult; reportPath: string; refMetadata?: WorkerRunRefMetadata },
  runtime: WorkerRuntime
): Promise<WorkerOutcome> {
  const graph = await runtime.readGraph(graphPath);
  const node = runtime.getNode(graph, claim.nodeId);
  const stillOwned = node.lease?.runId === claim.runId && node.lease?.session === session;
  const currentRefMetadata: WorkerRunRefMetadata | undefined = refMetadata ? { ...refMetadata } : undefined;
  let finalizedRun = run;
  if (run.code === 0 && stillOwned && ["claimed", "running"].includes(node.status || "pending") && currentRefMetadata?.cloneCwd && currentRefMetadata.workRef?.name) {
    try {
      const published = await publishOutputRef({
        cloneCwd: currentRefMetadata.cloneCwd,
        workRef: currentRefMetadata.workRef.name,
        outputRef: currentRefMetadata.outputRef?.name
      });
      const noOp = Boolean(currentRefMetadata.baseRef?.commit && currentRefMetadata.baseRef.commit === published.commit);
      currentRefMetadata.outputRef = {
        ...(currentRefMetadata.outputRef || {}),
        name: published.outputRef,
        commit: published.commit,
        source: noOp ? "no-op-base" : "worker-commit",
        noOp
      };
    } catch (error) {
      finalizedRun = {
        ...run,
        code: 1,
        error: `worker output publication failed: ${errorMessage(error)}`
      };
    }
  }
  const reportBody = formatWorkerReport({
    claim,
    node,
    run: finalizedRun,
    reportPath,
    refMetadata: currentRefMetadata,
    finalState: {
      status: node.status || "pending",
      stillOwned
    }
  });

  await runtime.writeReportFile(graphPath, reportPath, reportBody);

  if (!stillOwned || !["claimed", "running"].includes(node.status || "pending")) {
    return {
      nodeId: claim.nodeId,
      runId: claim.runId,
      status: node.status || "pending",
      code: finalizedRun.code,
      signal: finalizedRun.signal,
      report: reportPath,
      note: "node state was changed by the Codex run"
    };
  }

  if (finalizedRun.code === 0) {
    const completionRefMetadata = currentRefMetadata?.outputRef
      ? { outputRef: currentRefMetadata.outputRef }
      : currentRefMetadata;
    const result = await runtime.completeNode(graphPath, {
      nodeId: claim.nodeId,
      session,
      runId: claim.runId,
      report: reportPath,
      refMetadata: completionRefMetadata
    });
    return {
      ...result,
      runId: claim.runId,
      code: finalizedRun.code,
      signal: finalizedRun.signal,
      report: reportPath,
      slack: await runtime.sendSlackNotification(graphPath, operationalEvents.done, { nodeId: claim.nodeId, report: reportPath })
    };
  }

  const reason = describeWorkerFailure(finalizedRun);
  const failureRefMetadata = currentRefMetadata?.outputRef
    ? { outputRef: currentRefMetadata.outputRef }
    : undefined;
  const result = await runtime.failNode(graphPath, {
    nodeId: claim.nodeId,
    session,
    runId: claim.runId,
    reason,
    report: reportPath,
    refMetadata: failureRefMetadata
  });
  return {
    ...result,
    runId: claim.runId,
    code: finalizedRun.code,
    signal: finalizedRun.signal,
    report: reportPath,
    slack: await runtime.sendSlackNotification(graphPath, operationalEvents.failed, {
      nodeId: claim.nodeId,
      reason,
      report: reportPath
    })
  };
}

export function formatWorkerReport({
  claim,
  node,
  run,
  reportPath,
  refMetadata,
  finalState
}: {
  claim: LeaseClaimResult;
  node?: GraphNode;
  run: CodexRunResult;
  reportPath?: string;
  refMetadata?: WorkerRunRefMetadata;
  finalState?: { status?: string; stillOwned?: boolean };
}): string {
  const sections = [
    `# ${reportInlineValue(claim.nodeId)}: ${reportInlineValue(claim.title)}`,
    "",
    `- Node: ${reportInlineValue(claim.nodeId)}`,
    `- Run: ${reportInlineValue(claim.runId)}`,
    ...(reportPath ? [`- Report path: ${reportInlineValue(reportPath)}`] : []),
    `- Exit code: ${reportInlineValue(run.code)}`,
    `- Signal: ${reportInlineValue(run.signal || "none")}`,
    `- Command: ${reportInlineValue(run.command)}`,
    `- Args: ${run.args.length > 0 ? reportInlineValue(JSON.stringify(run.args)) : "[]"}`,
    `- Cwd: ${run.cwd ? reportInlineValue(run.cwd) : "unknown"}`,
    `- Started: ${reportInlineValue(run.startedAt)}`,
    `- Finished: ${reportInlineValue(run.finishedAt)}`,
    `- Duration ms: ${reportInlineValue(run.durationMs ?? "unknown")}`
  ];

  if (finalState) {
    sections.push(`- Final graph status: ${reportInlineValue(finalState.status || "unknown")}`);
    sections.push(`- Lease still owned at finalization: ${finalState.stillOwned === undefined ? "unknown" : reportInlineValue(finalState.stillOwned)}`);
  }
  if (run.timedOut) {
    sections.push(`- Timed out: true`);
    sections.push(`- Timeout ms: ${reportInlineValue(run.timeoutMs ?? "unknown")}`);
  }
  if (run.aborted) {
    sections.push(`- Aborted: true`);
    sections.push(`- Abort reason: ${reportInlineValue(run.abortReason || "unknown")}`);
  }
  const isolation = mergeReportIsolationDetails(node ? nodeIsolationDetails(node) : undefined, refMetadata);
  if (isolation || run.cwd) {
    sections.push("", "## Isolation", "");
    sections.push(`- Worker cwd: ${run.cwd ? reportInlineValue(run.cwd) : "unknown"}`);
    if (isolation?.remote) {
      sections.push(`- Remote: ${reportInlineValue(isolation.remote)}`);
    }
    if (isolation?.bareRepo) {
      sections.push(`- Bare repository: ${reportInlineValue(isolation.bareRepo)}`);
    }
    sections.push(`- Clone cwd: ${reportInlineValue(isolation?.cloneCwd || run.cwd || "unknown")}`);
    sections.push(`- Base ref: ${reportInlineValue(isolation?.baseRef || "unknown")}`);
    if (isolation?.baseCommit) {
      sections.push(`- Base commit: ${reportInlineValue(isolation.baseCommit)}`);
    }
    sections.push(`- Work branch/ref: ${reportInlineValue(isolation?.workRef || "unknown")}`);
    sections.push(`- Output ref: ${reportInlineValue(isolation?.outputRef || isolation?.publishedOutputRef || "unknown")}`);
    if (isolation?.outputCommit) {
      sections.push(`- Output commit: ${reportInlineValue(isolation.outputCommit)}`);
    }
    if (refMetadata?.outputRef?.noOp === true) {
      sections.push(`- No-op output: true`);
    }
    if (isolation?.integrationRef) {
      sections.push(`- Integration ref: ${reportInlineValue(isolation.integrationRef)}`);
      sections.push(`- Integration status: ${reportInlineValue(isolation.integrationStatus || "unknown")}`);
    }
    const mergeRefs = isolation?.mergeRefs?.map((input) => `${input.nodeId}: ${input.outputRef}`) || [];
    const conflictedMergeRefs = isolation?.conflictedMergeRefs?.map((input) => `${input.nodeId}: ${input.outputRef}`) || [];
    sections.push(`- Merge refs: ${mergeRefs.length > 0 ? reportInlineValue(mergeRefs.join(", ")) : "none"}`);
    if (conflictedMergeRefs.length > 0) {
      sections.push(`- Conflicted merge refs: ${reportInlineValue(conflictedMergeRefs.join(", "))}`);
    }
  }
  if (run.stdout?.trim()) {
    sections.push("", "## Stdout", "", reportCodeBlock(run.stdout.trim()));
  }
  if (run.stderr?.trim()) {
    sections.push("", "## Stderr", "", reportCodeBlock(run.stderr.trim()));
  }
  if (run.error) {
    sections.push("", "## Error", "", reportCodeBlock(run.error));
  }

  return sections.join("\n");
}

function mergeReportIsolationDetails(
  nodeDetails: NodeIsolationDetails | undefined,
  refMetadata: WorkerRunRefMetadata | undefined
): NodeIsolationDetails | undefined {
  if (!refMetadata) {
    return nodeDetails;
  }

  return {
    ...(nodeDetails || {}),
    ...(refMetadata.remote ? { remote: refMetadata.remote } : {}),
    ...(refMetadata.bareRepo ? { bareRepo: refMetadata.bareRepo } : {}),
    ...(refMetadata.cloneCwd ? { cloneCwd: refMetadata.cloneCwd } : {}),
    ...(refMetadata.baseRef?.name ? { baseRef: refMetadata.baseRef.name } : {}),
    ...(refMetadata.baseRef?.commit ? { baseCommit: refMetadata.baseRef.commit } : {}),
    ...(refMetadata.workRef?.name ? { workRef: refMetadata.workRef.name } : {}),
    ...(refMetadata.outputRef?.name ? { outputRef: refMetadata.outputRef.name } : {}),
    ...(refMetadata.outputRef?.commit ? { outputCommit: refMetadata.outputRef.commit } : {}),
    ...(refMetadata.integrationResult ? { integrationStatus: refMetadata.integrationResult } : {})
  };
}

function installWorkerSignalHandlers(abortController: AbortController): {
  interruptedSignal?: NodeJS.Signals;
  restore(): void;
} {
  const state: { interruptedSignal?: NodeJS.Signals; restore(): void } = {
    restore: () => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    state.interruptedSignal = signal;
    if (!abortController.signal.aborted) {
      abortController.abort(`worker interrupted by ${signal}`);
    }
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  return state;
}

function signalExitCode(signal: NodeJS.Signals): number {
  return signal === "SIGINT" ? 130 : 143;
}

function describeWorkerFailure(run: CodexRunResult): string {
  if (run.timedOut) {
    return `codex timed out after ${run.timeoutMs ?? "unknown"}ms`;
  }
  if (run.aborted) {
    return `codex aborted: ${run.abortReason || "unknown"}`;
  }
  if (run.signal) {
    return `codex terminated by signal ${run.signal}`;
  }
  if (run.error) {
    return `codex process error: ${run.error}`;
  }
  return `codex exited with ${run.code}`;
}

function formatAbortReason(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.message;
  }
  if (typeof reason === "string") {
    return reason;
  }
  return reason === undefined ? "aborted" : String(reason);
}

function redactSecrets(value: string): string {
  return redactSecretText(value);
}

function reportInlineValue(value: unknown): string {
  return redactSecrets(String(value))
    .replaceAll("\r", "\\r")
    .replaceAll("\n", "\\n");
}

function reportCodeBlock(value: string): string {
  const redacted = redactSecrets(value);
  const longestFence = Math.max(2, ...Array.from(redacted.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(longestFence + 1);
  return `${fence}text\n${redacted}\n${fence}`;
}

function resolveTemplatePath(graphPath: string, templatePath: string | undefined, defaultTemplatePath: string): string {
  if (!templatePath) {
    return defaultTemplatePath;
  }
  return isAbsolute(templatePath) ? resolve(templatePath) : resolve(dirname(graphPath), templatePath);
}

function renderPromptTemplate(template: string, context: Record<string, unknown>): string {
  return template.replaceAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key) => {
    if (Object.hasOwn(context, key)) {
      return String(context[key]);
    }
    return match;
  });
}
