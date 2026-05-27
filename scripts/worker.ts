import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import type {
  CodexRunResult,
  GraphNode,
  GraphSummary,
  LeaseClaimResult,
  NodeMutationResult,
  PlanGraphFile,
  ReadyNode,
  RenewLeaseResult,
  RunWorkerOptions,
  RunWorkerResult,
  SlackNotificationResult,
  WorkerOutcome
} from "./contracts.js";
import { numericArgumentRanges, parseNumericArgument } from "./numeric-args.js";
import { runtimePathsFromModuleUrl } from "./runtime-paths.js";

const { rootDir } = runtimePathsFromModuleUrl(import.meta.url);
const defaultGraphPath = resolve(rootDir, "plan.graph.json");

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
  }): Promise<NodeMutationResult>;
  failNode(graphPath: string, options: {
    nodeId?: string;
    reason?: string;
    report?: string;
    session?: string;
    runId?: string;
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
}

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
  const stream = options.stream !== false;
  const results: WorkerOutcome[] = [];

  while (true) {
    let claim: LeaseClaimResult;
    try {
      claim = await runtime.claimNode(graphPath, {
        session,
        nodeId: options.nodeId,
        leaseSeconds
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

    const reportPath = options.reportPath || runtime.defaultReportPath(claim.nodeId, claim.runId);
    const prompt = await buildWorkerPrompt(graphPath, {
      nodeId: claim.nodeId,
      session,
      runId: claim.runId,
      templatePath: options.templatePath,
      cwd: options.cwd,
      reportPath
    }, runtime);
    const heartbeat = startLeaseHeartbeat(graphPath, { claim, session, leaseSeconds }, runtime);
    let run: CodexRunResult;
    try {
      run = await runCodexPrompt(prompt, {
        ...options,
        graphPath,
        logPrefix: `${session}:${claim.nodeId}`
      });
    } finally {
      heartbeat.stop();
    }
    const outcome = await finalizeWorkerRun(graphPath, { claim, session, run, reportPath }, runtime);
    results.push(outcome);

    await runtime.renderPlanAfterUpdate(graphPath);
    if (once) {
      return { session, idle: false, results };
    }
  }
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
  { claim, session, leaseSeconds }: { claim: LeaseClaimResult; session: string; leaseSeconds?: number },
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
    } catch {
      stopped = true;
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
  const cwd = options.cwd || dirname(options.graphPath || defaultGraphPath);
  const command = options.codexCommand || "codex";
  const commandArgs = options.codexArgs || ["exec"];
  const stream = options.stream !== false;
  const prefix = options.logPrefix ? `[${options.logPrefix}] ` : "";
  const startedAt = new Date().toISOString();

  const result = await new Promise<Omit<CodexRunResult, "command" | "args" | "startedAt" | "finishedAt">>((resolveRun) => {
    const child = spawn(command, [...commandArgs, prompt], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk;
      if (stream) {
        process.stdout.write(prefixChunk(chunk, prefix));
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk;
      if (stream) {
        process.stderr.write(prefixChunk(chunk, prefix));
      }
    });
    child.on("error", (error) => {
      resolveRun({ code: 1, error: error.message, stdout, stderr });
    });
    child.on("exit", (code, signal) => {
      resolveRun({ code: code ?? 1, signal, stdout, stderr });
    });
  });

  return {
    ...result,
    command,
    args: commandArgs,
    startedAt,
    finishedAt: new Date().toISOString()
  };
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
  { claim, session, run, reportPath }: { claim: LeaseClaimResult; session: string; run: CodexRunResult; reportPath: string },
  runtime: WorkerRuntime
): Promise<WorkerOutcome> {
  const graph = await runtime.readGraph(graphPath);
  const node = runtime.getNode(graph, claim.nodeId);
  const stillOwned = node.lease?.runId === claim.runId && node.lease?.session === session;
  const reportBody = formatWorkerReport({ claim, run });

  if (!stillOwned || !["claimed", "running"].includes(node.status || "pending")) {
    return {
      nodeId: claim.nodeId,
      runId: claim.runId,
      status: node.status || "pending",
      code: run.code,
      note: "node state was changed by the Codex run"
    };
  }

  if (run.code === 0) {
    await runtime.writeReportFile(graphPath, reportPath, reportBody);
    const result = await runtime.completeNode(graphPath, {
      nodeId: claim.nodeId,
      session,
      runId: claim.runId,
      report: reportPath
    });
    return {
      ...result,
      runId: claim.runId,
      code: run.code,
      slack: await runtime.sendSlackNotification(graphPath, "done", { nodeId: claim.nodeId, report: reportPath })
    };
  }

  await runtime.writeReportFile(graphPath, reportPath, reportBody);
  const reason = `codex exited with ${run.code}`;
  const result = await runtime.failNode(graphPath, {
    nodeId: claim.nodeId,
    session,
    runId: claim.runId,
    reason,
    report: reportPath
  });
  return {
    ...result,
    runId: claim.runId,
    code: run.code,
    slack: await runtime.sendSlackNotification(graphPath, "failed", {
      nodeId: claim.nodeId,
      reason,
      report: reportPath
    })
  };
}

export function formatWorkerReport({ claim, run }: { claim: LeaseClaimResult; run: CodexRunResult }): string {
  const sections = [
    `# ${claim.nodeId}: ${claim.title}`,
    "",
    `- Run: ${claim.runId}`,
    `- Exit code: ${run.code}`,
    `- Started: ${run.startedAt}`,
    `- Finished: ${run.finishedAt}`
  ];

  if (run.stdout?.trim()) {
    sections.push("", "## Stdout", "", "```text", run.stdout.trim(), "```");
  }
  if (run.stderr?.trim()) {
    sections.push("", "## Stderr", "", "```text", run.stderr.trim(), "```");
  }
  if (run.error) {
    sections.push("", "## Error", "", run.error);
  }

  return sections.join("\n");
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
