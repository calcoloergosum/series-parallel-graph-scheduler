import { dirname } from "node:path";

import type {
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
  VisualizerPayload,
  VisualizerWorkspaceDisplay,
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
