import { dirname } from "node:path";

import type {
  GraphHistoryEntry,
  GraphNode,
  PlanGraphFile,
  VisualizerNodeDetail,
  VisualizerPayload,
  WorkerManager,
  WorkerManagerStatus
} from "./contracts.js";
import { defaultGraphPath, readGraph } from "./graph-io.js";
import { listReadyLeafNodes, listWorkingNodes, summarizeGraph } from "./graph-traversal.js";
import { redactOperationalEventDetails } from "./operational-events.js";
import { renderPlanarSvg } from "./sp-layout.js";
import { buildVisualizerNodeActionMap, visualizerActionPolicy } from "./visualizer-actions.js";

export const visualizerNodeHistoryLimit = 10;

export async function buildVisualizerPayload(
  graphPath = defaultGraphPath,
  workerManager?: Pick<WorkerManager, "status">
): Promise<VisualizerPayload> {
  const graph = await readGraph(graphPath);
  const actionMap = buildVisualizerNodeActionMap(graph);
  return {
    graph,
    graphSvg: renderPlanarSvg(graph),
    nodes: buildVisualizerNodeDetails(graph, visualizerNodeHistoryLimit, actionMap),
    nodeHistoryLimit: visualizerNodeHistoryLimit,
    actionPolicy: visualizerActionPolicy,
    ready: listReadyLeafNodes(graph),
    working: listWorkingNodes(graph),
    summary: summarizeGraph(graph),
    workerManager: workerManager?.status?.() || emptyWorkerManagerStatus(dirname(graphPath))
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
  return redactNodeDetail(omitUndefined({
    id,
    title: node.title,
    kind: node.kind || "task",
    status: node.status || "pending",
    description: node.description,
    children: Array.isArray(node.children) ? [...node.children] : [],
    deliverables: Array.isArray(node.deliverables) ? [...node.deliverables] : [],
    acceptanceCriteria: Array.isArray(node.acceptanceCriteria) ? [...node.acceptanceCriteria] : [],
    lease: node.lease,
    refs: omitUndefined({
      baseRef: node.baseRef,
      workRef: node.workRef,
      outputRef: node.outputRef,
      integrationRef: node.integrationRef
    }),
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

function omitUndefined<T extends Record<string, unknown>>(details: T): T {
  return Object.fromEntries(Object.entries(details).filter(([, value]) => value !== undefined)) as T;
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
