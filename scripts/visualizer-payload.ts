import { dirname } from "node:path";

import type {
  GraphDiagnostics,
  GraphHistoryEntry,
  GraphNode,
  PlanGraphFile,
  VisualizerAttentionSummary,
  VisualizerNodeDetail,
  VisualizerPayload,
  WorkerManager,
  WorkerManagerStatus
} from "./contracts.js";
import { defaultGraphPath, inspectGraphLock, readGraph } from "./graph-io.js";
import { buildGraphDiagnostics, listReadyLeafNodes, listWorkingNodes, summarizeGraph } from "./graph-traversal.js";
import { gitFootprintFromNode } from "./git-footprint.js";
import { exportOperationalEvents, redactOperationalEventDetails } from "./operational-events.js";
import { renderPlanarSvg } from "./sp-layout.js";
import { buildVisualizerNodeActionMap, visualizerActionPolicy } from "./visualizer-actions.js";

export const visualizerNodeHistoryLimit = 10;
export const visualizerRecentEventLimit = 20;

export async function buildVisualizerPayload(
  graphPath = defaultGraphPath,
  workerManager?: Pick<WorkerManager, "status">
): Promise<VisualizerPayload> {
  const graph = await readGraph(graphPath);
  const actionMap = buildVisualizerNodeActionMap(graph);
  const managerStatus = workerManager?.status?.() || emptyWorkerManagerStatus(dirname(graphPath));
  const diagnostics = buildGraphDiagnostics(graph, {
    graphPath,
    lock: await inspectGraphLock(graphPath)
  });
  return {
    graph: redactGraphPayload(graph),
    graphSvg: renderPlanarSvg(graph),
    nodes: buildVisualizerNodeDetails(graph, visualizerNodeHistoryLimit, actionMap),
    nodeHistoryLimit: visualizerNodeHistoryLimit,
    actionPolicy: visualizerActionPolicy,
    attention: buildVisualizerAttentionSummary(diagnostics, managerStatus),
    diagnostics,
    gitFootprint: diagnostics.gitFootprint,
    recentEvents: exportOperationalEvents(graph, { limit: visualizerRecentEventLimit }),
    ready: listReadyLeafNodes(graph),
    working: listWorkingNodes(graph),
    summary: summarizeGraph(graph),
    workerManager: managerStatus
  };
}

export function buildVisualizerNodeDetails(
  graph: PlanGraphFile,
  historyLimit = visualizerNodeHistoryLimit,
  actionMap = buildVisualizerNodeActionMap(graph)
): VisualizerNodeDetail[] {
  const boundedHistoryLimit = Math.max(0, Math.floor(historyLimit));
  return Object.entries(graph.graph.nodes)
    .map(([id, node]) => normalizeVisualizerNode(id, node, boundedHistoryLimit, actionMap[id] || []))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function normalizeVisualizerNode(
  id: string,
  node: GraphNode,
  historyLimit: number,
  actions: VisualizerNodeDetail["actions"]
): VisualizerNodeDetail {
  const history = Array.isArray(node.history) ? node.history : [];
  const gitFootprint = gitFootprintFromNode(node);
  return redactNodeDetail(omitUndefined({
    id,
    title: node.title,
    kind: node.kind || "task",
    status: node.status || "pending",
    description: node.description,
    goal: node.goal,
    children: Array.isArray(node.children) ? [...node.children] : [],
    deliverables: Array.isArray(node.deliverables) ? [...node.deliverables] : [],
    acceptanceCriteria: Array.isArray(node.acceptanceCriteria) ? [...node.acceptanceCriteria] : [],
    lease: node.lease,
    refs: omitUndefined({
      baseRef: node.baseRef,
      workRef: node.workRef,
      outputRef: node.outputRef,
      integrationRef: node.integrationRef,
      gitFootprint
    }),
    gitFootprint,
    gitDiffStat: gitFootprint?.diffStat,
    changedFiles: gitFootprint?.files,
    workspace: node.workspace,
    report: node.report,
    question: node.question,
    answer: node.answer,
    answeredBy: node.answeredBy,
    blockedReason: node.blockedReason,
    failureReason: node.failureReason,
    timestamps: omitUndefined({
      startedAt: node.startedAt,
      completedAt: node.completedAt,
      blockedAt: node.blockedAt,
      answeredAt: node.answeredAt,
      failedAt: node.failedAt,
      expiredAt: node.expiredAt
    }),
    history: historyTail(history, historyLimit),
    historyCount: history.length,
    historyLimit,
    actions
  }));
}

function historyTail(history: GraphHistoryEntry[], limit: number): GraphHistoryEntry[] {
  if (limit <= 0) {
    return [];
  }
  return history.slice(-limit);
}

function redactNodeDetail(detail: Record<string, unknown>): VisualizerNodeDetail {
  return redactOperationalEventDetails(detail) as unknown as VisualizerNodeDetail;
}

function redactGraphPayload(graph: PlanGraphFile): PlanGraphFile {
  return redactOperationalEventDetails(graph as unknown as Record<string, unknown>) as unknown as PlanGraphFile;
}

function omitUndefined<T extends Record<string, unknown>>(details: T): T {
  return Object.fromEntries(Object.entries(details).filter(([, value]) => value !== undefined)) as T;
}

function buildVisualizerAttentionSummary(
  diagnostics: GraphDiagnostics,
  workerManager: WorkerManagerStatus
): VisualizerAttentionSummary {
  const expired = diagnostics.leases.expired;
  const workerErrors = workerManager.workers.filter((worker) => worker.status === "error");
  return {
    failed: {
      count: diagnostics.failed.length,
      nodeIds: diagnostics.failed.map((node) => node.id)
    },
    blocked: {
      count: diagnostics.blocked.length,
      nodeIds: diagnostics.blocked.map((node) => node.id)
    },
    expired: {
      count: expired.length,
      nodeIds: expired.map((node) => node.id),
      releasable: expired.filter((node) => node.releasable).length
    },
    workerErrors: {
      count: workerErrors.length,
      workerIds: workerErrors.map((worker) => worker.id)
    }
  };
}

function emptyWorkerManagerStatus(cwd: string): WorkerManagerStatus {
  return {
    defaults: {
      cwd,
      sessionPrefix: "codex",
      codexCommand: "codex",
      isolation: "off",
      workspaceRoot: "runs/workspaces",
      workspaceRetention: "on-failure"
    },
    running: 0,
    stopping: 0,
    exited: 0,
    error: 0,
    retainedWorkers: 0,
    totalStarted: 0,
    workers: []
  };
}
