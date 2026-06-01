import { dirname } from "node:path";

import type {
  DiagnosticNode,
  GraphDiagnostics,
  GraphHistoryEntry,
  GraphNode,
  GitDiffStatMetadata,
  GitFileFootprintMetadata,
  GitRefFootprintMetadata,
  NodeIntegrationRefMetadata,
  NodeWorkspaceMetadata,
  PlanGraphFile,
  VisualizerAttentionSummary,
  VisualizerGitAction,
  VisualizerGitChangedFileRow,
  VisualizerGitDiffStatDisplay,
  VisualizerGitFootprintDetail,
  VisualizerGitRefDisplay,
  VisualizerNodeDetail,
  VisualizerNodeUi,
  VisualizerPayload,
  VisualizerRecommendedAction,
  VisualizerRunState,
  VisualizerDefaultSelection,
  VisualizerWorkspaceDisplay,
  VisualizerWorkQueue,
  VisualizerWorkQueueItem,
  WorkerManager,
  WorkerManagerStatus
} from "./contracts.js";
import { defaultGraphPath, inspectGraphLock, readGraph } from "./graph-io.js";
import { buildGraphDiagnostics, buildStableRootPathMap, isLeaf, listReadyLeafNodes, listWorkingNodes, summarizeGraph } from "./graph-traversal.js";
import { gitFootprintFromNode } from "./git-footprint.js";
import { exportOperationalEvents, redactOperationalEventDetails } from "./operational-events.js";
import { renderPlanarSvg } from "./sp-layout.js";
import { buildVisualizerNodeActionMap, visualizerActionPolicy } from "./visualizer-actions.js";

export const visualizerNodeHistoryLimit = 10;
export const visualizerRecentEventLimit = 20;
export const visualizerChangedFilesLimit = 50;

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
  const nodes = buildVisualizerNodeDetails(graph, visualizerNodeHistoryLimit, actionMap);
  const recentEvents = exportOperationalEvents(graph, { limit: visualizerRecentEventLimit });
  const ready = listReadyLeafNodes(graph);
  const working = listWorkingNodes(graph);
  const summary = summarizeGraph(graph);
  const operationalView = buildVisualizerOperationalView({
    graph,
    nodes,
    diagnostics,
    managerStatus,
    ready,
    working,
    summary
  });
  return {
    graph: redactGraphPayload(graph),
    graphSvg: renderPlanarSvg(graph),
    nodes,
    nodeHistoryLimit: visualizerNodeHistoryLimit,
    actionPolicy: visualizerActionPolicy,
    ...operationalView,
    attention: buildVisualizerAttentionSummary(diagnostics, managerStatus),
    diagnostics,
    gitFootprint: diagnostics.gitFootprint,
    recentEvents,
    ready,
    working,
    summary,
    workerManager: managerStatus
  };
}

interface VisualizerOperationalViewInput {
  graph: PlanGraphFile;
  nodes: VisualizerNodeDetail[];
  diagnostics: GraphDiagnostics;
  managerStatus: WorkerManagerStatus;
  ready: ReturnType<typeof listReadyLeafNodes>;
  working: ReturnType<typeof listWorkingNodes>;
  summary: ReturnType<typeof summarizeGraph>;
}

function buildVisualizerOperationalView({
  graph,
  nodes,
  diagnostics,
  managerStatus,
  ready,
  working,
  summary
}: VisualizerOperationalViewInput): Pick<VisualizerPayload, "runState" | "workQueue" | "defaultSelection" | "nodeUi"> {
  const generatedAtMs = Date.parse(diagnostics.generatedAt);
  const nowMs = Number.isFinite(generatedAtMs) ? generatedAtMs : Date.now();
  const nodeDetailsById = Object.fromEntries(nodes.map((node) => [node.id, node]));
  const latestEventsByNode = latestEventMap(graph);
  const pathMap = buildStableRootPathMap(graph);
  const expiredIds = new Set(diagnostics.leases.expired.map((node) => node.id));
  const releasableExpiredIds = new Set(diagnostics.leases.expired.filter((node) => node.releasable).map((node) => node.id));
  const readyIds = new Set(ready.map((node) => node.id));
  const nodeUi = buildVisualizerNodeUi({
    graph,
    nodeDetailsById,
    latestEventsByNode,
    pathMap,
    nowMs,
    readyIds,
    expiredIds,
    releasableExpiredIds
  });
  const workQueue = buildVisualizerWorkQueue({
    nodeUi,
    diagnostics,
    managerStatus,
    ready,
    working
  });
  const defaultSelection = buildVisualizerDefaultSelection({
    graph,
    diagnostics,
    managerStatus,
    workQueue,
    ready
  });
  const runState = buildVisualizerRunState({
    diagnostics,
    managerStatus,
    ready,
    workQueue,
    summary
  });

  return {
    runState,
    workQueue,
    defaultSelection,
    nodeUi
  };
}

function latestEventMap(graph: PlanGraphFile): Map<string, ReturnType<typeof exportOperationalEvents>[number]> {
  return new Map(Object.keys(graph.graph.nodes).map((nodeId) => [
    nodeId,
    exportOperationalEvents(graph, { nodeId, limit: 1 })[0]
  ]));
}

function buildVisualizerNodeUi({
  graph,
  nodeDetailsById,
  latestEventsByNode,
  pathMap,
  nowMs,
  readyIds,
  expiredIds,
  releasableExpiredIds
}: {
  graph: PlanGraphFile;
  nodeDetailsById: Record<string, VisualizerNodeDetail>;
  latestEventsByNode: Map<string, ReturnType<typeof exportOperationalEvents>[number]>;
  pathMap: Record<string, string[]>;
  nowMs: number;
  readyIds: ReadonlySet<string>;
  expiredIds: ReadonlySet<string>;
  releasableExpiredIds: ReadonlySet<string>;
}): Record<string, VisualizerNodeUi> {
  const entries = Object.entries(graph.graph.nodes).map(([nodeId, node]) => {
    const detail = nodeDetailsById[nodeId];
    const latestEvent = latestEventsByNode.get(nodeId);
    const leaseRemainingMs = leaseRemainingMsForNode(node, nowMs);
    const parentPath = (pathMap[nodeId] || [nodeId]).slice(0, -1);
    const nodeUi: VisualizerNodeUi = omitUndefined({
      parentPath,
      latestEvent,
      ageMs: eventAgeMs(latestEvent, nowMs),
      leaseRemainingMs,
      recommendedAction: recommendedActionForNode({
        graph,
        nodeId,
        detail,
        ready: readyIds.has(nodeId),
        expired: expiredIds.has(nodeId),
        releasableExpired: releasableExpiredIds.has(nodeId)
      })
    });
    return [nodeId, nodeUi];
  });
  return redactOperationalEventDetails(Object.fromEntries(entries)) as Record<string, VisualizerNodeUi>;
}

function buildVisualizerWorkQueue({
  nodeUi,
  diagnostics,
  managerStatus,
  ready,
  working
}: {
  nodeUi: Record<string, VisualizerNodeUi>;
  diagnostics: GraphDiagnostics;
  managerStatus: WorkerManagerStatus;
  ready: ReturnType<typeof listReadyLeafNodes>;
  working: ReturnType<typeof listWorkingNodes>;
}): VisualizerWorkQueue {
  const attention = [
    ...diagnostics.failed.map((node) => queueNodeItem("attention", 100, "critical", node, nodeUi[node.id], node.failureReason || node.nextStep || node.report)),
    ...(diagnostics.lock?.stale ? [queueLockItem(diagnostics.lock.ageMs, diagnostics.lock.path)] : []),
    ...diagnostics.leases.expired.map((node) => queueNodeItem("attention", 300, "warning", node, nodeUi[node.id], expiredLeaseReason(node))),
    ...diagnostics.blocked.map((node) => queueNodeItem("attention", 400, "warning", node, nodeUi[node.id], node.question || node.blockedReason || node.nextStep)),
    ...managerStatus.workers
      .filter((worker) => worker.status === "error")
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((worker, index) => queueWorkerItem(worker, 500 + index, "critical", worker.error || worker.recentFailureReason || "Worker error"))
  ].map((item, index) => ({ ...item, order: index + 1 }));

  const expiredIds = new Set(diagnostics.leases.expired.map((node) => node.id));
  const readyItems = ready.map((node, index) => queueNodeItem("ready", index + 1, "info", node, nodeUi[node.id], "Ready under scheduler priority."));
  const activeItems = working
    .filter((node) => (node.status === "claimed" || node.status === "running") && !expiredIds.has(node.id))
    .map((node, index) => queueNodeItem("active", index + 1, "info", node, nodeUi[node.id], activeNodeReason(node)));
  const workerItems = [...managerStatus.workers]
    .sort(compareWorkersForQueue)
    .map((worker, index) => queueWorkerItem(worker, index + 1, worker.status === "error" ? "critical" : "info"));
  const defaultSection = attention.length > 0
    ? "attention"
    : readyItems.length > 0 && activeItems.length === 0 && managerStatus.running === 0
      ? "ready"
      : activeItems.length > 0
        ? "active"
        : workerItems.length > 0
          ? "workers"
          : "attention";

  return redactOperationalEventDetails({
    sectionOrder: ["attention", "ready", "active", "workers"],
    defaultSection,
    sort: "attention: failed, stale lock, expired lease, blocked/review, worker error; ready: scheduler priority; active: working order; workers: error, running, stopping, exited, id",
    attention,
    ready: readyItems,
    active: activeItems,
    workers: workerItems
  }) as unknown as VisualizerWorkQueue;
}

function buildVisualizerDefaultSelection({
  graph,
  diagnostics,
  managerStatus,
  workQueue,
  ready
}: {
  graph: PlanGraphFile;
  diagnostics: GraphDiagnostics;
  managerStatus: WorkerManagerStatus;
  workQueue: VisualizerWorkQueue;
  ready: ReturnType<typeof listReadyLeafNodes>;
}): VisualizerDefaultSelection {
  const failed = diagnostics.failed[0];
  if (failed) {
    return { type: "node", id: failed.id, reason: "failed-node" };
  }
  const blocked = diagnostics.blocked[0];
  if (blocked) {
    return { type: "node", id: blocked.id, reason: "blocked-node" };
  }
  const expired = diagnostics.leases.expired[0];
  if (expired) {
    return { type: "node", id: expired.id, reason: "expired-node" };
  }
  const workerError = managerStatus.workers
    .filter((worker) => worker.status === "error")
    .sort((left, right) => left.id.localeCompare(right.id))[0];
  if (workerError) {
    return { type: "worker", id: workerError.id, reason: "worker-error" };
  }
  const active = workQueue.active[0];
  if (active?.nodeId) {
    return { type: "node", id: active.nodeId, reason: "active-node" };
  }
  const readyNode = ready[0];
  if (readyNode) {
    return { type: "node", id: readyNode.id, reason: "ready-node" };
  }
  return { type: "node", id: graph.graph.root, reason: "graph-root" };
}

function buildVisualizerRunState({
  diagnostics,
  managerStatus,
  ready,
  workQueue,
  summary
}: {
  diagnostics: GraphDiagnostics;
  managerStatus: WorkerManagerStatus;
  ready: ReturnType<typeof listReadyLeafNodes>;
  workQueue: VisualizerWorkQueue;
  summary: ReturnType<typeof summarizeGraph>;
}): VisualizerRunState {
  if (workQueue.attention.length > 0) {
    const critical = diagnostics.failed.length > 0 || Boolean(diagnostics.lock?.stale) || managerStatus.error > 0;
    return {
      state: "needs-attention",
      severity: critical ? "critical" : "warning",
      message: `Needs attention: ${attentionSummaryParts(diagnostics, managerStatus).join(", ")}.`,
      reason: "Failed, blocked/review, expired, stale lock, or worker-error state exists.",
      primaryAction: {
        id: "open-attention",
        label: "Open attention",
        kind: "navigation",
        section: "attention"
      }
    };
  }

  const activeNodes = workQueue.active.length;
  const activeWorkers = managerStatus.running + managerStatus.stopping;
  if (ready.length > 0 && activeNodes === 0 && activeWorkers === 0) {
    return {
      state: "ready-to-run",
      severity: "info",
      message: `Ready work is available: ${ready.length} node(s) can be claimed.`,
      reason: "Ready work exists and no managed worker or active node is running.",
      primaryAction: {
        id: "start-workers",
        label: "Start workers",
        kind: "global-action",
        section: "ready"
      }
    };
  }

  if (activeNodes > 0 || activeWorkers > 0) {
    return {
      state: "running",
      severity: "info",
      message: `Running: ${activeNodes} active node(s) across ${activeWorkers} active worker(s).`,
      reason: "Active nodes or managed workers exist and no attention item exists.",
      primaryAction: {
        id: "view-active",
        label: "View active work",
        kind: "navigation",
        section: activeNodes > 0 ? "active" : "workers"
      }
    };
  }

  if ((summary.counts.done || 0) === summary.totalNodes && summary.totalNodes > 0) {
    return {
      state: "complete",
      severity: "success",
      message: "Plan complete. Review results and Git output.",
      reason: "All graph nodes are done.",
      primaryAction: {
        id: "review-results",
        label: "Review results",
        kind: "navigation"
      }
    };
  }

  return {
    state: "idle",
    severity: "neutral",
    message: "No ready work. Inspect diagnostics or blocked parent state.",
    reason: "No attention item, ready work, active work, active worker, or complete graph state exists.",
    primaryAction: {
      id: "view-diagnostics",
      label: "View diagnostics",
      kind: "navigation"
    }
  };
}

function recommendedActionForNode({
  graph,
  nodeId,
  detail,
  ready,
  expired,
  releasableExpired
}: {
  graph: PlanGraphFile;
  nodeId: string;
  detail: VisualizerNodeDetail | undefined;
  ready: boolean;
  expired: boolean;
  releasableExpired: boolean;
}): VisualizerRecommendedAction | undefined {
  if (!detail) {
    return undefined;
  }
  if (detail.status === "failed") {
    return {
      id: detail.report ? "open-report" : "inspect-failure",
      label: detail.report ? "Open report" : "Inspect failure",
      kind: "navigation",
      nodeId
    };
  }
  if ((detail.status === "blocked" || detail.status === "review") && detail.question) {
    return nodeActionRecommendation(detail, "answer", "Answer");
  }
  if (expired && releasableExpired) {
    return {
      id: "release-expired",
      label: "Release expired lease",
      kind: "global-action",
      nodeId
    };
  }
  if (ready) {
    return nodeActionRecommendation(detail, "claim", "Claim node")
      || nodeActionRecommendation(detail, "start", "Start worker for node");
  }
  if (detail.status === "running" || detail.status === "claimed") {
    return {
      id: "monitor",
      label: "Monitor run",
      kind: "navigation",
      nodeId
    };
  }
  if (detail.status === "done" && detail.git) {
    const openDiff = detail.git.actions.find((action) => action.id === "open-diff" && !action.disabledReason);
    if (openDiff) {
      return {
        id: "open-diff",
        label: "Open diff",
        kind: "git-action",
        gitActionId: "open-diff",
        nodeId
      };
    }
    return {
      id: "review-result",
      label: "Review result",
      kind: "navigation",
      nodeId
    };
  }
  if (!isLeaf(graph, nodeId)) {
    return {
      id: "inspect-children",
      label: "Inspect children",
      kind: "navigation",
      nodeId
    };
  }
  return undefined;
}

function nodeActionRecommendation(
  detail: VisualizerNodeDetail,
  actionId: VisualizerNodeDetail["actions"][number]["id"],
  label: string
): VisualizerRecommendedAction | undefined {
  const action = detail.actions.find((candidate) => candidate.id === actionId);
  if (!action) {
    return undefined;
  }
  return {
    id: actionId,
    label,
    kind: "node-action",
    nodeActionId: actionId,
    nodeId: detail.id,
    ...(action.disabledReason ? { disabledReason: action.disabledReason } : {})
  };
}

function queueNodeItem(
  section: VisualizerWorkQueue["sectionOrder"][number],
  order: number,
  severity: VisualizerWorkQueueItem["severity"],
  node: Pick<DiagnosticNode, "id" | "title" | "status" | "expiresAt">,
  nodeUi: VisualizerNodeUi | undefined,
  reason?: string
): VisualizerWorkQueueItem {
  return omitUndefined({
    id: `${section}:node:${node.id}`,
    type: "node" as const,
    order,
    severity,
    nodeId: node.id,
    status: node.status,
    title: node.title,
    reason,
    ageMs: nodeUi?.ageMs,
    leaseRemainingMs: nodeUi?.leaseRemainingMs,
    latestEvent: nodeUi?.latestEvent,
    recommendedAction: nodeUi?.recommendedAction
  });
}

function queueLockItem(ageMs: number | undefined, path: string): VisualizerWorkQueueItem {
  return omitUndefined({
    id: "attention:lock:stale",
    type: "lock" as const,
    order: 200,
    severity: "warning" as const,
    status: "stale-lock",
    title: "Stale graph lock",
    reason: `Graph lock appears stale: ${path}`,
    ageMs,
    recommendedAction: {
      id: "view-diagnostics",
      label: "View diagnostics",
      kind: "navigation" as const
    }
  });
}

function queueWorkerItem(
  worker: WorkerManagerStatus["workers"][number],
  order: number,
  severity: VisualizerWorkQueueItem["severity"],
  reason?: string
): VisualizerWorkQueueItem {
  const startedAt = Date.parse(worker.startedAt);
  return omitUndefined({
    id: `workers:worker:${worker.id}`,
    type: "worker" as const,
    order,
    severity,
    workerId: worker.id,
    status: worker.status,
    title: worker.session,
    reason,
    ageMs: Number.isFinite(startedAt) ? worker.durationMs : undefined,
    recommendedAction: worker.status === "error"
      ? {
        id: "inspect-worker",
        label: "Inspect worker",
        kind: "navigation" as const,
        workerId: worker.id,
        section: "workers" as const
      }
      : undefined
  });
}

function compareWorkersForQueue(left: WorkerManagerStatus["workers"][number], right: WorkerManagerStatus["workers"][number]): number {
  return workerStatusRank(left.status) - workerStatusRank(right.status)
    || left.id.localeCompare(right.id);
}

function workerStatusRank(status: string): number {
  switch (status) {
    case "error":
      return 0;
    case "running":
      return 1;
    case "stopping":
      return 2;
    case "exited":
      return 3;
    default:
      return 4;
  }
}

function attentionSummaryParts(diagnostics: GraphDiagnostics, managerStatus: WorkerManagerStatus): string[] {
  const parts = [
    countPart(diagnostics.failed.length, "failed node"),
    countPart(diagnostics.blocked.length, "blocked/review node"),
    countPart(diagnostics.leases.expired.length, "expired lease"),
    diagnostics.lock?.stale ? "1 stale lock" : "",
    countPart(managerStatus.error, "worker error")
  ].filter(Boolean);
  return parts.length > 0 ? parts : ["attention item"];
}

function countPart(count: number, singular: string): string {
  if (count <= 0) {
    return "";
  }
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function expiredLeaseReason(node: DiagnosticNode): string {
  if (node.releasable) {
    return "Expired claimed/running lease can be released.";
  }
  return "Expired lease is parked on non-releasable work; inspect before recovery.";
}

function activeNodeReason(node: ReturnType<typeof listWorkingNodes>[number]): string {
  if (node.expiresAt) {
    return `Lease expires at ${node.expiresAt}.`;
  }
  return "Active scheduler work.";
}

function leaseRemainingMsForNode(node: GraphNode, nowMs: number): number | undefined {
  if (!node.lease?.expiresAt) {
    return undefined;
  }
  const expiresAtMs = Date.parse(node.lease.expiresAt);
  return Number.isFinite(expiresAtMs) ? expiresAtMs - nowMs : undefined;
}

function eventAgeMs(event: ReturnType<typeof exportOperationalEvents>[number] | undefined, nowMs: number): number | undefined {
  if (!event?.at) {
    return undefined;
  }
  const eventTime = Date.parse(event.at);
  return Number.isFinite(eventTime) ? Math.max(0, nowMs - eventTime) : undefined;
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
  const git = normalizeVisualizerGitDetail(node, gitFootprint);
  return redactNodeDetail(omitUndefined({
    id,
    title: node.title,
    kind: node.kind || "task",
    status: node.status || "pending",
    description: node.description,
    goal: node.goal,
    goalText: goalTextForNode(node.goal),
    planner: node.planner,
    plannerDecision: plannerDecisionForNode(node),
    decompositionReason: decompositionReasonForNode(node),
    pendingPlannerPreview: node.pendingPlannerPreview,
    contextRefs: Array.isArray(node.contextRefs) ? [...node.contextRefs] : undefined,
    outputContract: node.outputContract,
    resultSummary: node.resultSummary,
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
    git,
    gitFootprint,
    gitFootprintWarning: node.gitFootprintWarning,
    gitDiffStat: git?.diffStat,
    changedFiles: git?.changedFiles,
    workspace: node.workspace,
    workspaceDisplay: workspaceDisplay(node.workspace),
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

function normalizeVisualizerGitDetail(
  node: GraphNode,
  gitFootprint: ReturnType<typeof gitFootprintFromNode>
): VisualizerGitFootprintDetail | undefined {
  if (!gitFootprint && !node.baseRef && !node.workRef && !node.outputRef && !node.integrationRef) {
    return undefined;
  }

  const baseRef = visualizerRef(gitFootprint?.baseRef || node.baseRef);
  const headRef = visualizerRef(gitFootprint?.headRef || node.outputRef || node.workRef);
  const workRef = visualizerRef(node.workRef);
  const outputRef = visualizerRef(node.outputRef || gitFootprint?.headRef);
  const integrationRef = visualizerIntegrationRef(node.integrationRef);
  const diffStat = visualizerDiffStat(gitFootprint?.diffStat || node.outputRef?.diffStat, gitFootprint?.files || node.outputRef?.files || []);
  const allFiles = sortedChangedFileRows(gitFootprint?.files || node.outputRef?.files || []);
  const changedFiles = allFiles.slice(0, visualizerChangedFilesLimit);
  const workspace = workspaceDisplay(node.workspace);
  const commit = gitFootprint?.commit || gitFootprint?.headRef?.commit || node.outputRef?.commit || node.workRef?.commit;
  const branch = gitFootprint?.branch || branchName(gitFootprint?.headRef?.name || node.outputRef?.name || node.workRef?.name);
  const actions = visualizerGitActions({
    baseRef,
    headRef,
    outputRef,
    integrationRef,
    workRef,
    remote: node.workspace?.remote
  });

  return omitUndefined({
    source: gitFootprint?.source,
    warning: node.gitFootprintWarning,
    commit,
    branch,
    baseRef,
    headRef,
    workRef,
    outputRef,
    integrationRef,
    diffStat,
    filesChanged: diffStat?.filesChanged,
    insertions: diffStat?.insertions,
    deletions: diffStat?.deletions,
    totalChanges: diffStat?.totalChanges,
    binaryFiles: diffStat?.binaryFiles,
    changedFiles,
    changedFilesTotal: allFiles.length,
    changedFilesLimit: visualizerChangedFilesLimit,
    changedFilesTruncated: Math.max(0, allFiles.length - changedFiles.length),
    actions,
    aggregation: gitFootprint?.aggregation,
    collectedAt: gitFootprint?.collectedAt || node.outputRef?.collectedAt,
    remoteDisplay: workspace?.remote,
    workspaceDisplay: workspace?.cloneCwd,
    bareRepoDisplay: workspace?.bareRepo
  });
}

function visualizerRef(ref: GitRefFootprintMetadata | undefined): VisualizerGitRefDisplay | undefined {
  if (!ref?.name && !ref?.commit) {
    return undefined;
  }
  const display = [ref.name, ref.commit].filter(Boolean).join(" @ ");
  return omitUndefined({
    name: ref.name,
    commit: ref.commit,
    display
  });
}

function visualizerIntegrationRef(ref: NodeIntegrationRefMetadata | undefined): VisualizerGitFootprintDetail["integrationRef"] {
  if (!ref?.name && !ref?.status && !ref?.publishedOutputRef) {
    return undefined;
  }
  return omitUndefined({
    name: ref.name,
    status: ref.status,
    publishedOutputRef: ref.publishedOutputRef
  });
}

function visualizerDiffStat(
  stat: GitDiffStatMetadata | undefined,
  files: GitFileFootprintMetadata[]
): VisualizerGitDiffStatDisplay | undefined {
  if (stat) {
    const insertions = stat.insertions ?? stat.additions ?? 0;
    return {
      filesChanged: stat.filesChanged,
      insertions,
      deletions: stat.deletions,
      totalChanges: stat.totalChanges,
      ...(stat.binaryFiles !== undefined ? { binaryFiles: stat.binaryFiles } : {})
    };
  }

  if (!files.length) {
    return undefined;
  }

  let insertions = 0;
  let deletions = 0;
  let totalChanges = 0;
  let binaryFiles = 0;
  for (const file of files) {
    insertions += fileInsertions(file) ?? 0;
    deletions += file.deletions ?? 0;
    totalChanges += file.totalChanges ?? 0;
    if (file.binary) {
      binaryFiles += 1;
    }
  }
  return {
    filesChanged: files.length,
    insertions,
    deletions,
    totalChanges,
    ...(binaryFiles > 0 ? { binaryFiles } : {})
  };
}

function sortedChangedFileRows(files: GitFileFootprintMetadata[]): VisualizerGitChangedFileRow[] {
  return files
    .map((file) => omitUndefined({
      path: file.path,
      oldPath: file.oldPath,
      changeType: file.changeType,
      insertions: fileInsertions(file),
      deletions: file.deletions,
      totalChanges: file.totalChanges,
      binary: Boolean(file.binary),
      childIds: Array.isArray(file.childIds) ? [...file.childIds].sort() : undefined
    }))
    .sort((left, right) => (
      left.path.localeCompare(right.path)
      || String(left.oldPath || "").localeCompare(String(right.oldPath || ""))
      || String(left.changeType || "").localeCompare(String(right.changeType || ""))
    ));
}

function visualizerGitActions({
  baseRef,
  headRef,
  outputRef,
  integrationRef,
  workRef,
  remote
}: {
  baseRef?: VisualizerGitRefDisplay;
  headRef?: VisualizerGitRefDisplay;
  outputRef?: VisualizerGitRefDisplay;
  integrationRef?: VisualizerGitFootprintDetail["integrationRef"];
  workRef?: VisualizerGitRefDisplay;
  remote?: string;
}): VisualizerGitAction[] {
  const base = compareToken(baseRef);
  const head = compareToken(headRef || outputRef || integrationRef || workRef);
  const missing = [];
  if (!base) {
    missing.push("base ref");
  }
  if (!head) {
    missing.push("head ref");
  }
  const disabledReason = missing.length
    ? `Missing ${missing.join(" and ")}.`
    : !remote
      ? "Missing git remote metadata."
      : !githubProjectUrl(remote)
        ? "Compare links require a GitHub remote."
        : undefined;

  if (disabledReason) {
    return gitActionRows(undefined, disabledReason);
  }

  const range = `${encodeURIComponent(base)}...${encodeURIComponent(head)}`;
  const compareUrl = `${githubProjectUrl(remote)}/compare/${range}`;
  return gitActionRows(compareUrl);
}

function gitActionRows(compareUrl: string | undefined, disabledReason?: string): VisualizerGitAction[] {
  return [
    {
      id: "open-diff",
      label: "Open diff",
      ...(compareUrl ? { href: `${compareUrl}.diff` } : { disabledReason })
    },
    {
      id: "compare",
      label: "Compare",
      ...(compareUrl ? { href: compareUrl } : { disabledReason })
    }
  ];
}

function compareToken(ref: VisualizerGitRefDisplay | VisualizerGitFootprintDetail["integrationRef"] | undefined): string {
  if (!ref) {
    return "";
  }
  const candidate = ref as VisualizerGitRefDisplay & { publishedOutputRef?: string };
  const value = candidate.commit || candidate.publishedOutputRef || candidate.name;
  if (!value) {
    return "";
  }
  return value
    .replace(/^refs\/heads\//, "")
    .replace(/^refs\/remotes\/origin\//, "")
    .replace(/^refs\/remotes\/[^/]+\//, "");
}

function githubProjectUrl(remote: string | undefined): string {
  const text = String(remote || "").trim();
  const httpsMatch = text.match(/^https?:\/\/(?:[^/@]+@)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  const sshMatch = text.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i)
    || text.match(/^ssh:\/\/git@github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  const match = httpsMatch || sshMatch;
  if (!match) {
    return "";
  }
  return `https://github.com/${encodeURIComponent(match[1])}/${encodeURIComponent(match[2].replace(/\.git$/i, ""))}`;
}

function fileInsertions(file: GitFileFootprintMetadata): number | null {
  return file.insertions ?? file.additions ?? null;
}

function workspaceDisplay(workspace: NodeWorkspaceMetadata | undefined): VisualizerWorkspaceDisplay | undefined {
  if (!workspace) {
    return undefined;
  }
  return omitUndefined({
    remote: workspace.remote,
    cloneCwd: workspace.cloneCwd,
    bareRepo: workspace.bareRepo,
    retained: workspace.retained
  });
}

function branchName(refName: string | undefined): string | undefined {
  if (!refName) {
    return undefined;
  }
  return refName
    .replace(/^refs\/heads\//, "")
    .replace(/^refs\/remotes\//, "");
}

function goalTextForNode(goal: GraphNode["goal"]): string | undefined {
  if (typeof goal === "string" && goal.trim()) {
    return goal;
  }
  if (goal && typeof goal === "object" && typeof goal.text === "string" && goal.text.trim()) {
    return goal.text;
  }
  return undefined;
}

function plannerDecisionForNode(node: GraphNode): string | undefined {
  return firstString(
    node.plannerDecision,
    stringMetadata(node, "decision"),
    node.planner?.decision,
    node.planner?.rationale
  );
}

function decompositionReasonForNode(node: GraphNode): string | undefined {
  return firstString(
    node.decompositionReason,
    stringMetadata(node, "decomposeReason"),
    node.planner?.decompositionReason,
    node.rationale
  );
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return undefined;
}

function stringMetadata(node: GraphNode, key: string): string | undefined {
  const value = node[key];
  return typeof value === "string" ? value : undefined;
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
