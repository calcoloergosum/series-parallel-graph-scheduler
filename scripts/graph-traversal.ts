import type {
  DiagnosticRemediation,
  DynamicContextPayload,
  DiagnosticNode,
  GraphDiagnostics,
  GraphHistoryEntry,
  GraphLockDiagnostics,
  GraphNode,
  GraphSummary,
  NodeContextRelation,
  NodeContextSummary,
  NodeBaseRefMetadata,
  NodeBaseRefSource,
  NodeId,
  NodeIntegrationInputRefMetadata,
  NodeIsolationDetails,
  PlanGraphFile,
  ReachableDepthMap,
  ReachableParentMap,
  ReachablePathMap,
  ReadyNode,
  ReadyNodePriorityFields,
  WorkingNode
} from "./contracts.js";
import { buildGraphGitFootprintSummary, gitFootprintFromNode } from "./git-footprint.js";
import { redactOperationalEventDetails } from "./operational-events.js";

export const terminalStatuses = new Set<string>(["done"]);
export const busyStatuses = new Set<string>(["claimed", "running", "blocked", "review", "failed"]);
export const autoReleasableStatuses = new Set<string>(["claimed", "running"]);

export interface ReadyPriorityCandidate extends ReadyNodePriorityFields {
  id: NodeId;
}

export interface ReadyPrioritySelection {
  ready: ReadyNode;
  priority: ReadyPriorityCandidate;
}

export interface BuildRelevantContextOptions {
  maxItems?: number;
  maxSummaryChars?: number;
}

interface InternalReadyPriorityCandidate extends ReadyPriorityCandidate {
  parentSet: Set<NodeId>;
}

const defaultRelevantContextMaxItems = 12;
const defaultRelevantContextMaxSummaryChars = 400;

export function compareReadyPriorityCandidates(left: ReadyPriorityCandidate, right: ReadyPriorityCandidate): number {
  return left.depth - right.depth
    || right.child_count - left.child_count
    || left.shared_parent_count_with_current_task - right.shared_parent_count_with_current_task
    || compareRawNodeIds(left.id, right.id);
}

function compareRawNodeIds(left: NodeId, right: NodeId): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

export function getNode(graph: PlanGraphFile, nodeId: NodeId): GraphNode {
  const node = graph.graph?.nodes?.[nodeId];
  if (!node) {
    throw new Error(`Unknown node: ${nodeId}`);
  }
  return node;
}

export function isLeaf(graph: PlanGraphFile, nodeId: NodeId): boolean {
  const node = getNode(graph, nodeId);
  return !Array.isArray(node.children) || node.children.length === 0;
}

export function isSubtreeDone(graph: PlanGraphFile, nodeId: NodeId): boolean {
  const node = getNode(graph, nodeId);
  const statusDone = terminalStatuses.has(node.status ?? "pending");
  if (isLeaf(graph, nodeId)) {
    return statusDone;
  }
  return statusDone && (node.children?.every((childId) => isSubtreeDone(graph, childId)) ?? true);
}

export function summarizeGraph(graph: PlanGraphFile): GraphSummary {
  const counts: Record<string, number> = {};
  for (const node of Object.values(graph.graph.nodes)) {
    const status = node.status || "pending";
    counts[status] = (counts[status] || 0) + 1;
  }

  return {
    graphVersion: graph.graphVersion,
    title: graph.title,
    description: graph.description,
    totalNodes: Object.keys(graph.graph.nodes).length,
    root: graph.graph.root,
    counts
  };
}

export function buildRelevantContext(
  graph: PlanGraphFile,
  nodeId: NodeId,
  options: BuildRelevantContextOptions = {}
): DynamicContextPayload {
  const maxItems = Math.max(1, options.maxItems ?? defaultRelevantContextMaxItems);
  const maxSummaryChars = Math.max(80, options.maxSummaryChars ?? defaultRelevantContextMaxSummaryChars);
  const path = buildStableRootPathMap(graph)[nodeId] || [nodeId];
  const selected = new Map<NodeId, NodeContextSummary>();
  const omittedNodeIds: NodeId[] = [];

  const select = (candidateId: NodeId, relation: NodeContextRelation): NodeContextSummary | undefined => {
    const candidate = contextSummaryForNode(graph, candidateId, relation, maxSummaryChars);
    if (!candidate) {
      return undefined;
    }
    if (!selected.has(candidateId)) {
      if (selected.size >= maxItems) {
        omittedNodeIds.push(candidateId);
      } else {
        selected.set(candidateId, candidate);
      }
    }
    return selected.get(candidateId) || candidate;
  };

  const self = select(nodeId, "self") || contextSummaryForNode(graph, nodeId, "self", maxSummaryChars)!;
  const root = graph.graph.root && graph.graph.root !== nodeId ? select(graph.graph.root, "root") : undefined;
  const parents = path.slice(0, -1)
    .filter((parentId) => parentId !== graph.graph.root)
    .map((parentId) => select(parentId, "parent"))
    .filter((summary): summary is NodeContextSummary => Boolean(summary));
  const seriesPredecessors: NodeContextSummary[] = [];
  const completedSiblings: NodeContextSummary[] = [];

  for (let index = 0; index < path.length - 1; index += 1) {
    const parentId = path[index];
    const pathChildId = path[index + 1];
    const parent = graph.graph.nodes[parentId];
    const children = Array.isArray(parent?.children) ? parent.children : [];
    const childIndex = children.indexOf(pathChildId);
    if (childIndex < 0) {
      continue;
    }

    if (parent.kind === "series") {
      for (const predecessorId of children.slice(0, childIndex)) {
        if (isSubtreeDone(graph, predecessorId)) {
          const summary = select(predecessorId, "series-predecessor");
          if (summary && !seriesPredecessors.some((entry) => entry.nodeId === summary.nodeId)) {
            seriesPredecessors.push(summary);
          }
        }
      }
    }

    if (index === path.length - 2) {
      for (const siblingId of children) {
        if (siblingId !== nodeId && isSubtreeDone(graph, siblingId)) {
          const summary = select(siblingId, parent.kind === "series" && children.indexOf(siblingId) < childIndex ? "series-predecessor" : "completed-sibling");
          if (summary && !completedSiblings.some((entry) => entry.nodeId === summary.nodeId)) {
            completedSiblings.push(summary);
          }
        }
      }
    }
  }

  const reports = [...selected.values()].filter((summary) => summary.report || summary.resultSummary?.report);

  return {
    nodeId,
    self,
    ...(root ? { root } : {}),
    parents,
    seriesPredecessors,
    completedSiblings,
    explicitRefs: graph.graph.nodes[nodeId]?.contextRefs,
    reports,
    selection: {
      maxItems,
      maxSummaryChars,
      includedRelations: ["self", "root", "parent", "series-predecessor", "completed-sibling", "explicit-ref"],
      ...(omittedNodeIds.length > 0 ? { omittedNodeIds } : {}),
      reportBodyPolicy: "paths-and-summaries-only"
    }
  };
}

function contextSummaryForNode(
  graph: PlanGraphFile,
  nodeId: NodeId,
  relation: NodeContextRelation,
  maxSummaryChars: number
): NodeContextSummary | undefined {
  const node = graph.graph.nodes[nodeId];
  if (!node) {
    return undefined;
  }
  const summaryText = typeof node.resultSummary?.summary === "string"
    ? truncateSummary(node.resultSummary.summary, maxSummaryChars)
    : undefined;
  const truncated = Boolean(node.resultSummary?.summary && summaryText !== node.resultSummary.summary);
  const outputRefName = typeof node.outputRef?.name === "string" ? node.outputRef.name : undefined;
  return {
    nodeId,
    relation,
    title: node.title,
    kind: node.kind || "task",
    status: node.status || "pending",
    ...(summaryText ? { summary: summaryText } : {}),
    ...(node.resultSummary ? { resultSummary: { ...node.resultSummary, summary: summaryText || node.resultSummary.summary } } : {}),
    ...(node.report ? { report: node.report } : {}),
    ...(outputRefName ? { outputRef: outputRefName } : {}),
    ...(node.resultSummary?.artifacts ? { artifacts: [...node.resultSummary.artifacts] } : {}),
    ...(node.completedAt || node.resultSummary?.completedAt ? { completedAt: node.resultSummary?.completedAt || node.completedAt } : {}),
    ...(truncated ? { truncated } : {})
  };
}

function truncateSummary(value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(1, maxChars - 15)).trimEnd()} [truncated]`;
}

export function buildReachableParentMap(graph: PlanGraphFile, startId: NodeId = graph.graph.root): ReachableParentMap {
  return collectReachableMetadata(graph, startId).parentMap;
}

export function buildReachableDepthMap(graph: PlanGraphFile, startId: NodeId = graph.graph.root): ReachableDepthMap {
  return collectReachableMetadata(graph, startId).depthMap;
}

export function buildStableRootPathMap(graph: PlanGraphFile, startId: NodeId = graph.graph.root): ReachablePathMap {
  return collectReachableMetadata(graph, startId).pathMap;
}

export function listReadyLeafNodes(graph: PlanGraphFile, startId: NodeId = graph.graph.root): ReadyNode[] {
  const ready: ReadyNode[] = [];

  function visit(nodeId: NodeId): void {
    const node = getNode(graph, nodeId);
    const status = node.status || "pending";
    if (isSubtreeDone(graph, nodeId) || busyStatuses.has(status)) {
      return;
    }

    if (isLeaf(graph, nodeId)) {
      if (!busyStatuses.has(status) && !terminalStatuses.has(status)) {
        ready.push({
          id: nodeId,
          title: node.title,
          kind: node.kind || "task",
          status,
          question: node.question,
          answer: node.answer,
          answeredAt: node.answeredAt
        });
      }
      return;
    }

    if (node.kind === "series") {
      const nextChild = node.children?.find((childId) => !isSubtreeDone(graph, childId));
      if (nextChild) {
        visit(nextChild);
      }
      return;
    }

    if (node.kind === "parallel") {
      for (const childId of node.children ?? []) {
        visit(childId);
      }
      return;
    }

    for (const childId of node.children ?? []) {
      visit(childId);
    }
  }

  visit(startId);
  return attachReadyPriorityFields(graph, ready);
}

export function buildReadyPrioritySelections(
  graph: PlanGraphFile,
  readyNodes: ReadyNode[],
  currentTaskId?: NodeId
): ReadyPrioritySelection[] {
  const { depthMap, pathMap } = collectReachableMetadata(graph, graph.graph.root);

  return readyNodes.map((ready) => {
    const candidate = buildInternalReadyPriorityCandidate(graph, ready.id, depthMap, pathMap, currentTaskId);

    return {
      ready,
      priority: publicReadyPriorityCandidate(candidate)
    };
  });
}

export function attachReadyPriorityFields(
  graph: PlanGraphFile,
  readyNodes: ReadyNode[],
  currentTaskId?: NodeId
): ReadyNode[] {
  return sortedReadyPrioritySelections(graph, readyNodes, currentTaskId)
    .map(({ ready, priority }) => ({
      ...ready,
      depth: priority.depth,
      child_count: priority.child_count,
      shared_parent_count_with_current_task: priority.shared_parent_count_with_current_task
    }));
}

export function countSharedParentsWithCurrentTask(
  candidateParentSet: ReadonlySet<NodeId>,
  pathMap: ReachablePathMap,
  currentTaskId?: NodeId
): number {
  if (!currentTaskId || !pathMap[currentTaskId]) {
    return 0;
  }

  const currentParentSet = parentSetFromPath(pathMap[currentTaskId]);
  return [...candidateParentSet].filter((parentId) => currentParentSet.has(parentId)).length;
}

export function selectReadyNodeByPriority(
  graph: PlanGraphFile,
  readyNodes: ReadyNode[],
  currentTaskId?: NodeId
): ReadyNode | undefined {
  return sortedReadyPrioritySelections(graph, readyNodes, currentTaskId)[0]?.ready;
}

function sortedReadyPrioritySelections(
  graph: PlanGraphFile,
  readyNodes: ReadyNode[],
  currentTaskId?: NodeId
): ReadyPrioritySelection[] {
  return buildReadyPrioritySelections(graph, readyNodes, currentTaskId)
    .sort((left, right) => compareReadyPriorityCandidates(left.priority, right.priority));
}

function buildInternalReadyPriorityCandidate(
  graph: PlanGraphFile,
  nodeId: NodeId,
  depthMap: ReachableDepthMap,
  pathMap: ReachablePathMap,
  currentTaskId?: NodeId
): InternalReadyPriorityCandidate {
  const node = getNode(graph, nodeId);
  // Shared-child DAGs keep every direct parent in parentMap, but priority
  // metadata uses one stable shortest root path so shared-parent counts do not
  // depend on traversal timing or duplicate parent encounters.
  const parentSet = parentSetFromPath(pathMap[nodeId] ?? []);

  return {
    id: nodeId,
    depth: depthMap[nodeId] ?? Number.MAX_SAFE_INTEGER,
    child_count: Array.isArray(node.children) ? node.children.length : 0,
    parentSet,
    shared_parent_count_with_current_task: countSharedParentsWithCurrentTask(parentSet, pathMap, currentTaskId)
  };
}

function publicReadyPriorityCandidate(candidate: InternalReadyPriorityCandidate): ReadyPriorityCandidate {
  return {
    id: candidate.id,
    depth: candidate.depth,
    child_count: candidate.child_count,
    shared_parent_count_with_current_task: candidate.shared_parent_count_with_current_task
  };
}

function parentSetFromPath(path: NodeId[]): Set<NodeId> {
  return new Set(path.slice(0, -1));
}

export function resolveNodeBaseRef(graph: PlanGraphFile, nodeId: NodeId): NodeBaseRefMetadata {
  return resolveNodeBaseRefInContext(graph, nodeId, []);
}

export function listWorkingNodes(graph: PlanGraphFile): WorkingNode[] {
  return Object.entries(graph.graph?.nodes || {})
    .filter(([, node]) => node.lease || busyStatuses.has(node.status || "pending"))
    .map(([id, node]) => ({
      id,
      title: node.title || id,
      kind: node.kind || "task",
      status: node.status || "pending",
      session: node.lease?.session,
      runId: node.lease?.runId,
      claimedAt: node.lease?.claimedAt,
      expiresAt: node.lease?.expiresAt,
      question: node.question,
      answer: node.answer,
      answeredAt: node.answeredAt,
      report: node.report,
      isolation: nodeIsolationDetails(node)
    }))
    .sort((left, right) => {
      const leftTime = left.claimedAt || left.expiresAt || "";
      const rightTime = right.claimedAt || right.expiresAt || "";
      return leftTime.localeCompare(rightTime) || left.id.localeCompare(right.id);
    });
}

function resolveNodeBaseRefInContext(graph: PlanGraphFile, nodeId: NodeId, stack: NodeId[]): NodeBaseRefMetadata {
  if (stack.includes(nodeId)) {
    throw new Error(`Cycle detected while resolving base refs: ${[...stack, nodeId].join(" -> ")}`);
  }

  const node = getNode(graph, nodeId);
  const explicitBaseRef = refName(node.baseRef?.name);
  if (explicitBaseRef) {
    return {
      ...node.baseRef,
      name: explicitBaseRef,
      source: node.baseRef?.source || "explicit"
    };
  }

  const relation = findParentRelation(graph, nodeId);
  if (!relation) {
    return graphDefaultBaseRef(graph);
  }

  const parent = getNode(graph, relation.parentId);
  if (parent.kind === "series" && relation.childIndex > 0) {
    const predecessorId = relation.children[relation.childIndex - 1];
    const predecessor = getNode(graph, predecessorId);
    const predecessorOutputRef = refName(predecessor.outputRef?.name);
    if (!predecessorOutputRef) {
      throw new Error(`Cannot resolve base ref for ${nodeId}: series predecessor ${predecessorId} is missing outputRef.name`);
    }
    return {
      name: predecessorOutputRef,
      ...(predecessor.outputRef?.commit ? { commit: predecessor.outputRef.commit } : {}),
      source: "series-predecessor",
      predecessorId
    };
  }

  if (relation.parentId === graph.graph.root) {
    return graphDefaultBaseRef(graph);
  }

  const parentBaseRef = resolveNodeBaseRefInContext(graph, relation.parentId, [...stack, nodeId]);
  return {
    name: parentBaseRef.name,
    ...(parentBaseRef.commit ? { commit: parentBaseRef.commit } : {}),
    source: parent.kind === "parallel" || parent.kind === "series" ? "parent-base" : parentBaseRef.source,
    parentId: relation.parentId,
    parentBaseSource: parentBaseRef.source
  };
}

function graphDefaultBaseRef(graph: PlanGraphFile): NodeBaseRefMetadata {
  const schedulerBaseRef = graph.scheduler?.baseRef;
  if (typeof schedulerBaseRef === "string" && schedulerBaseRef.trim()) {
    return { name: schedulerBaseRef.trim(), source: "graph-default" };
  }
  if (schedulerBaseRef && typeof schedulerBaseRef === "object") {
    const baseRef = schedulerBaseRef as { name?: unknown; commit?: unknown; source?: unknown };
    const name = refName(baseRef.name);
    if (name) {
      return {
        ...(schedulerBaseRef as Record<string, unknown>),
        name,
        ...(typeof baseRef.commit === "string" && baseRef.commit ? { commit: baseRef.commit } : {}),
        source: sourceFromUnknown(baseRef.source, "graph-default")
      };
    }
  }
  return { name: "HEAD", source: "graph-default" };
}

function findParentRelation(
  graph: PlanGraphFile,
  nodeId: NodeId
): { parentId: NodeId; childIndex: number; children: NodeId[] } | undefined {
  const rootId = graph.graph?.root;
  if (!rootId || rootId === nodeId) {
    return undefined;
  }

  function visit(currentId: NodeId, stack: NodeId[] = []): { parentId: NodeId; childIndex: number; children: NodeId[] } | undefined {
    if (stack.includes(currentId)) {
      throw new Error(`Cycle detected in graph: ${[...stack, currentId].join(" -> ")}`);
    }

    const current = getNode(graph, currentId);
    const children = Array.isArray(current.children) ? current.children : [];
    const childIndex = children.indexOf(nodeId);
    if (childIndex >= 0) {
      return { parentId: currentId, childIndex, children };
    }

    for (const childId of children) {
      const found = visit(childId, [...stack, currentId]);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  return visit(rootId);
}

function refName(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function sourceFromUnknown(value: unknown, fallback: NodeBaseRefSource): NodeBaseRefSource {
  return typeof value === "string" && value.trim() ? value.trim() as NodeBaseRefSource : fallback;
}

export function buildGraphDiagnostics(
  graph: PlanGraphFile,
  options: {
    graphPath?: string;
    now?: Date;
    lock?: GraphLockDiagnostics;
  } = {}
): GraphDiagnostics {
  const now = options.now || new Date();
  const diagnostics: GraphDiagnostics = {
    generatedAt: now.toISOString(),
    ...(options.graphPath ? { graphPath: options.graphPath } : {}),
    summary: summarizeGraph(graph),
    nextReady: listReadyLeafNodes(graph),
    leases: {
      active: [],
      expired: []
    },
    blocked: [],
    failed: [],
    isolation: {
      activeWorkers: [],
      missingOutputRefs: [],
      unresolvedBufferConflicts: []
    },
    ...(options.lock ? { lock: options.lock } : {}),
    actions: [],
    remediation: []
  };
  const gitFootprint = buildGraphGitFootprintSummary(graph);
  if (gitFootprint) {
    diagnostics.gitFootprint = redactOperationalEventDetails({ gitFootprint }).gitFootprint as GraphDiagnostics["gitFootprint"];
  }

  for (const [id, node] of Object.entries(graph.graph.nodes)) {
    const status = node.status || "pending";
    const isolation = nodeIsolationDetails(node);
    if (node.lease) {
      const leaseNode = diagnosticNode(id, node, now);
      if (leaseNode.expired) {
        leaseNode.remediation = leaseNode.releasable
          ? expiredLeaseRemediation(id, options.graphPath)
          : parkedExpiredLeaseRemediation(id, options.graphPath, status);
      }
      if (leaseNode.expired) {
        diagnostics.leases.expired.push(leaseNode);
      } else {
        diagnostics.leases.active.push(leaseNode);
        if (isolation) {
          diagnostics.isolation.activeWorkers.push(leaseNode);
        }
      }
    }
    if (isolation?.missingOutputRef) {
      diagnostics.isolation.missingOutputRefs.push({
        ...diagnosticNode(id, node, now),
        nextStep: `record or recover outputRef for ${id} before isolated downstream work continues`,
        remediation: missingOutputRefRemediation(id, options.graphPath)
      });
    }
    if (isolation?.unresolvedBufferConflict) {
      diagnostics.isolation.unresolvedBufferConflicts.push({
        ...diagnosticNode(id, node, now),
        nextStep: `resolve integrationRef conflict for ${id}, then publish or reset the buffer`,
        remediation: unresolvedBufferConflictRemediation(id, options.graphPath)
      });
    }
    if (status === "blocked" || status === "review") {
      const leaf = isLeaf(graph, id);
      diagnostics.blocked.push({
        ...diagnosticNode(id, node, now),
        blockedReason: node.blockedReason,
        nextStep: leaf
          ? `answer --node ${id} --answer "..." or reset --node ${id} --reason "..."`
          : `inspect events for ${id}, then reset-subtree --node ${id} if retrying the blocked composition`,
        remediation: blockedWorkRemediation(id, options.graphPath, status, leaf)
      });
    }
    if (status === "failed") {
      diagnostics.failed.push({
        ...diagnosticNode(id, node, now),
        failureReason: node.failureReason,
        nextStep: `inspect report${node.report ? ` ${node.report}` : ""}, then reset --node ${id} --reason "..."`,
        remediation: failedNodeRemediation(id, options.graphPath, node.report)
      });
    }
  }

  sortDiagnosticNodes(diagnostics.leases.active);
  sortDiagnosticNodes(diagnostics.leases.expired);
  sortDiagnosticNodes(diagnostics.blocked);
  sortDiagnosticNodes(diagnostics.failed);
  sortDiagnosticNodes(diagnostics.isolation.activeWorkers);
  sortDiagnosticNodes(diagnostics.isolation.missingOutputRefs);
  sortDiagnosticNodes(diagnostics.isolation.unresolvedBufferConflicts);
  diagnostics.remediation = diagnosticRemediation(diagnostics, options.graphPath);
  diagnostics.actions = diagnosticActions(diagnostics);
  return diagnostics;
}

export function findAncestorIds(graph: PlanGraphFile, nodeId: NodeId): NodeId[] {
  const ancestors: NodeId[] = [];
  const rootId = graph.graph?.root;
  if (!rootId || rootId === nodeId) {
    return ancestors;
  }

  function visit(currentId: NodeId, path: NodeId[] = []): boolean {
    const current = getNode(graph, currentId);
    if (!Array.isArray(current.children)) {
      return false;
    }
    if (current.children.includes(nodeId)) {
      ancestors.push(...path, currentId);
      return true;
    }
    return current.children.some((childId) => visit(childId, [...path, currentId]));
  }

  visit(rootId);
  return ancestors.reverse();
}

function collectReachableMetadata(
  graph: PlanGraphFile,
  startId: NodeId
): {
  parentMap: ReachableParentMap;
  depthMap: ReachableDepthMap;
  pathMap: ReachablePathMap;
} {
  assertReachableSubgraphAcyclic(graph, startId);

  const parentMap: ReachableParentMap = { [startId]: [] };
  const depthMap: ReachableDepthMap = { [startId]: 0 };
  const pathMap: ReachablePathMap = { [startId]: [startId] };
  const queue: NodeId[] = [startId];

  for (let index = 0; index < queue.length; index += 1) {
    const nodeId = queue[index];
    const node = getNode(graph, nodeId);
    const children = Array.isArray(node.children) ? [...node.children].sort(compareRawNodeIds) : [];

    for (const childId of children) {
      if (!parentMap[childId]) {
        parentMap[childId] = [];
        depthMap[childId] = depthMap[nodeId] + 1;
        pathMap[childId] = [...pathMap[nodeId], childId];
        queue.push(childId);
      }
      if (!parentMap[childId].includes(nodeId)) {
        parentMap[childId].push(nodeId);
      }
    }
  }

  return { parentMap, depthMap, pathMap };
}

function assertReachableSubgraphAcyclic(graph: PlanGraphFile, startId: NodeId): void {
  const visited = new Set<NodeId>();
  const visiting = new Set<NodeId>();

  function visit(nodeId: NodeId, stack: NodeId[]): void {
    if (visiting.has(nodeId)) {
      const cycleStart = stack.indexOf(nodeId);
      const cycle = [...stack.slice(Math.max(0, cycleStart)), nodeId].join(" -> ");
      throw new Error(`Cycle detected in graph: ${cycle}`);
    }
    if (visited.has(nodeId)) {
      return;
    }

    const node = getNode(graph, nodeId);
    visiting.add(nodeId);
    for (const childId of Array.isArray(node.children) ? node.children : []) {
      visit(childId, [...stack, nodeId]);
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
  }

  visit(startId, []);
}

function diagnosticNode(id: string, node: GraphNode, now: Date): DiagnosticNode {
  const status = node.status || "pending";
  const expiresAtTime = node.lease?.expiresAt ? Date.parse(node.lease.expiresAt) : Number.NaN;
  const expired = Number.isFinite(expiresAtTime) ? expiresAtTime <= now.getTime() : undefined;
  const gitFootprint = gitFootprintFromNode(node);
  const details: DiagnosticNode = {
    id,
    title: node.title || id,
    kind: node.kind || "task",
    status,
    session: node.lease?.session,
    runId: node.lease?.runId,
    claimedAt: node.lease?.claimedAt,
    expiresAt: node.lease?.expiresAt,
    question: node.question,
    answer: node.answer,
    answeredAt: node.answeredAt,
    report: node.report,
    isolation: nodeIsolationDetails(node),
    ...(gitFootprint ? { gitFootprint } : {}),
    ...(gitFootprint?.diffStat ? { gitDiffStat: gitFootprint.diffStat } : {}),
    ...(gitFootprint?.files ? { changedFiles: gitFootprint.files } : {}),
    ...(expired !== undefined ? { expired } : {}),
    ...(expired !== undefined ? { releasable: expired && autoReleasableStatuses.has(status) } : {})
  };
  return redactOperationalEventDetails(details as unknown as Record<string, unknown>) as unknown as DiagnosticNode;
}

export function nodeIsolationDetails(node: GraphNode): NodeIsolationDetails | undefined {
  const history = Array.isArray(node.history) ? node.history : [];
  const mergeRefs = mergeRefInputs(history, "merge-attempted", node.integrationRef?.inputRefs);
  const conflictedMergeRefs = mergeRefInputs(history, "merge-conflicted");
  const lastConflictIndex = lastHistoryIndex(history, "merge-conflicted");
  const lastPublishIndex = lastHistoryIndex(history, "parent-ref-published");
  const unresolvedBufferConflict = node.integrationRef?.status === "conflicted"
    || (lastConflictIndex >= 0 && lastConflictIndex > lastPublishIndex);
  const outputRef = stringFromUnknown(node.outputRef?.name) || historyString(history, "outputRef") || historyString(history, "publishedOutputRef");
  const baseRef = stringFromUnknown(node.baseRef?.name) || historyString(history, "baseRef");
  const workRef = stringFromUnknown(node.workRef?.name) || historyString(history, "workRef");
  const integrationRef = stringFromUnknown(node.integrationRef?.name) || historyString(history, "integrationRef");
  const hasIsolationSignal = Boolean(
    baseRef
      || workRef
      || outputRef
      || integrationRef
      || node.outputRef?.commit
      || node.baseRef?.commit
      || gitFootprintFromNode(node)
      || node.integrationRef?.status
      || history.some((entry) => isolationHistoryEvents.has(entry.event))
      || stringFromUnknown(node.workspace?.cloneCwd)
      || stringFromUnknown(node.workspace?.bareRepo)
      || stringFromUnknown(node.lease?.cloneCwd)
      || stringFromUnknown(node.lease?.bareRepo)
  );

  if (!hasIsolationSignal) {
    return undefined;
  }

  const details: NodeIsolationDetails = {
    remote: stringFromUnknown(node.workspace?.remote) || historyString(history, "remote"),
    bareRepo: stringFromUnknown(node.workspace?.bareRepo) || stringFromUnknown(node.lease?.bareRepo) || historyString(history, "bareRepo"),
    cloneCwd: stringFromUnknown(node.workspace?.cloneCwd) || stringFromUnknown(node.lease?.cloneCwd) || stringFromUnknown(node.lease?.workspace) || historyString(history, "cloneCwd"),
    baseRef,
    baseCommit: stringFromUnknown(node.baseRef?.commit) || historyString(history, "baseCommit") || historyString(history, "commit", "clone-prepared"),
    workRef,
    outputRef,
    outputCommit: stringFromUnknown(node.outputRef?.commit) || historyString(history, "commit", "output-ref-recorded"),
    gitFootprint: gitFootprintFromNode(node),
    integrationRef,
    integrationStatus: stringFromUnknown(node.integrationRef?.status),
    publishedOutputRef: stringFromUnknown(node.integrationRef?.publishedOutputRef) || historyString(history, "publishedOutputRef"),
    ...(mergeRefs.length > 0 ? { mergeRefs } : {}),
    ...(conflictedMergeRefs.length > 0 ? { conflictedMergeRefs } : {}),
    ...(unresolvedBufferConflict ? { unresolvedBufferConflict: true } : {})
  };
  if ((node.status === "done" || node.integrationRef?.status === "clean") && !details.outputRef && !details.publishedOutputRef) {
    details.missingOutputRef = true;
  }
  return redactOperationalEventDetails(details as Record<string, unknown>) as unknown as NodeIsolationDetails;
}

function sortDiagnosticNodes(nodes: DiagnosticNode[]): void {
  nodes.sort((left, right) => {
    const leftTime = left.expiresAt || left.claimedAt || "";
    const rightTime = right.expiresAt || right.claimedAt || "";
    return leftTime.localeCompare(rightTime) || left.id.localeCompare(right.id);
  });
}

function diagnosticActions(diagnostics: GraphDiagnostics): string[] {
  const actions: string[] = [];
  const releasableExpired = diagnostics.leases.expired.filter((node) => node.releasable);
  const parkedExpired = diagnostics.leases.expired.filter((node) => !node.releasable);

  if (releasableExpired.length > 0) {
    actions.push(`Run release-expired to clear ${releasableExpired.length} expired claimed/running lease(s).`);
  }
  if (parkedExpired.length > 0) {
    actions.push(`Review ${parkedExpired.length} expired lease(s) on blocked/review/failed/done or custom-status work before reset, answer, or renew.`);
  }
  if (diagnostics.blocked.length > 0) {
    const answerable = diagnostics.blocked.filter((node) => node.remediation?.commands.some((command) => command.command.includes(" answer ")));
    const internal = diagnostics.blocked.length - answerable.length;
    if (answerable.length > 0) {
      actions.push(`Answer or reset ${answerable.length} blocked/review leaf node(s).`);
    }
    if (internal > 0) {
      actions.push(`Inspect or reset-subtree ${internal} blocked/review internal node(s).`);
    }
  }
  if (diagnostics.failed.length > 0) {
    actions.push(`Inspect reports and reset ${diagnostics.failed.length} failed node(s) that should be retried.`);
  }
  if (diagnostics.isolation.activeWorkers.length > 0) {
    actions.push(`Inspect ${diagnostics.isolation.activeWorkers.length} active isolated worker(s) by clone cwd or work ref.`);
  }
  if (diagnostics.isolation.missingOutputRefs.length > 0) {
    actions.push(`Recover or reset ${diagnostics.isolation.missingOutputRefs.length} isolated node(s) missing output refs.`);
  }
  if (diagnostics.isolation.unresolvedBufferConflicts.length > 0) {
    actions.push(`Resolve ${diagnostics.isolation.unresolvedBufferConflicts.length} unresolved composition buffer conflict(s).`);
  }
  if (diagnostics.lock?.exists) {
    actions.push(diagnostics.lock.stale
      ? "A stale graph lock is present; verify the owner process is gone, then rerun the command or remove the lock directory."
      : "A graph lock is present; wait for the owner process or inspect the lock metadata before intervening.");
  }
  if (diagnostics.nextReady.length > 0) {
    actions.push(`${diagnostics.nextReady.length} ready leaf node(s) can be claimed next.`);
  }
  if (actions.length === 0) {
    actions.push("No immediate scheduler action detected.");
  }
  return actions;
}

function diagnosticRemediation(diagnostics: GraphDiagnostics, graphPath?: string): DiagnosticRemediation[] {
  const remediation: DiagnosticRemediation[] = [];
  const releasableExpired = diagnostics.leases.expired.filter((node) => node.releasable);
  const parkedExpired = diagnostics.leases.expired.filter((node) => !node.releasable);

  if (releasableExpired.length > 0) {
    remediation.push({
      category: "expired-lease",
      severity: "warning",
      summary: `${releasableExpired.length} expired claimed/running lease(s) can be released.`,
      commands: [{
        command: schedulerCommand("release-expired", graphPath),
        description: "Release only expired claimed/running leases and return that work to pending.",
        safeToRun: true
      }]
    });
  }
  if (parkedExpired.length > 0) {
    remediation.push({
      category: "parked-expired-lease",
      severity: "warning",
      summary: `${parkedExpired.length} expired lease(s) are attached to blocked/review/failed/done or custom-status work.`,
      commands: [{
        command: schedulerCommand("events", graphPath, ["--limit", "20"]),
        description: "Inspect recent status changes before choosing answer, reset, renew, or manual recovery.",
        safeToRun: true
      }],
      prerequisites: ["Verify the node status and operator intent before changing parked work."]
    });
  }
  if (diagnostics.blocked.length > 0) {
    remediation.push({
      category: "blocked-work",
      severity: "warning",
      summary: `${diagnostics.blocked.length} blocked/review node(s) need operator or composition recovery.`,
      commands: [{
        command: schedulerCommand("events", graphPath, ["--event", "blocked", "--limit", "20"]),
        description: "Review recent blocked questions and composition context.",
        safeToRun: true
      }]
    });
  }
  if (diagnostics.failed.length > 0) {
    remediation.push({
      category: "failed-node",
      severity: "critical",
      summary: `${diagnostics.failed.length} failed node(s) need report inspection before retry.`,
      commands: [{
        command: schedulerCommand("events", graphPath, ["--event", "failed", "--limit", "20"]),
        description: "Review recent failure events before deciding whether to reset.",
        safeToRun: true
      }],
      prerequisites: ["Inspect each failed node report before running reset or reset-reachable."]
    });
  }
  if (diagnostics.lock?.exists) {
    remediation.push(lockRemediation(diagnostics.lock, graphPath));
  }
  if (diagnostics.nextReady.length === 0) {
    remediation.push({
      category: "no-ready",
      severity: diagnostics.summary.counts.done === diagnostics.summary.totalNodes ? "info" : "warning",
      summary: "No ready leaf nodes are currently claimable.",
      commands: [{
        command: schedulerCommand("diagnostics", graphPath),
        description: "Refresh diagnostics after resolving leases, blocked work, failed nodes, or locks.",
        safeToRun: true
      }, {
        command: schedulerCommand("events", graphPath, ["--limit", "20"]),
        description: "Inspect recent scheduler events before changing graph state.",
        safeToRun: true
      }]
    });
  } else {
    remediation.push({
      category: "ready-work",
      severity: "info",
      summary: `${diagnostics.nextReady.length} ready leaf node(s) can be claimed.`,
      commands: [{
        command: schedulerCommand("claim", graphPath),
        description: "Claim the next ready leaf using the scheduler's selection policy.",
        safeToRun: true
      }]
    });
  }
  return remediation;
}

function expiredLeaseRemediation(nodeId: string, graphPath?: string): DiagnosticRemediation {
  return {
    category: "expired-lease",
    severity: "warning",
    summary: `Node ${nodeId} has an expired claimed/running lease that release-expired can clear.`,
    nodeId,
    commands: [{
      command: schedulerCommand("release-expired", graphPath),
      description: "Release expired claimed/running leases only.",
      safeToRun: true
    }]
  };
}

function parkedExpiredLeaseRemediation(nodeId: string, graphPath: string | undefined, status: string): DiagnosticRemediation {
  return {
    category: "parked-expired-lease",
    severity: "warning",
    summary: `Node ${nodeId} has an expired lease on ${status} work; verify status before changing it.`,
    nodeId,
    commands: [{
      command: schedulerCommand("events", graphPath, ["--node", nodeId, "--limit", "20"]),
      description: "Inspect node history before choosing answer, reset, renew, or manual recovery.",
      safeToRun: true
    }],
    prerequisites: ["Do not clear or reset parked work until the node status and operator intent are verified."]
  };
}

function blockedWorkRemediation(nodeId: string, graphPath: string | undefined, status: string, leaf: boolean): DiagnosticRemediation {
  if (!leaf) {
    return {
      category: "blocked-work",
      severity: "warning",
      summary: `Internal node ${nodeId} is ${status} and needs composition recovery or a verified subtree reset.`,
      nodeId,
      commands: [{
        command: schedulerCommand("events", graphPath, ["--node", nodeId, "--limit", "20"]),
        description: "Inspect recent composition events before deciding how much work to retry.",
        safeToRun: true
      }, {
        command: schedulerCommand("reset-subtree", graphPath, ["--node", nodeId, "--reason", "<verified retry reason>"]),
        description: "Retry the blocked internal subtree after its composition state has been reviewed.",
        safeToRun: true,
        prerequisites: ["Confirm that resetting the full subtree is intended."]
      }],
      prerequisites: ["Internal blocked nodes cannot be answered directly; inspect the composition report first."]
    };
  }

  return {
    category: "blocked-work",
    severity: "warning",
    summary: `Node ${nodeId} is ${status} and needs an operator decision.`,
    nodeId,
    commands: [{
      command: schedulerCommand("answer", graphPath, ["--node", nodeId, "--answer", "<answer>"]),
      description: "Record the operator answer and return blocked work to pending.",
      safeToRun: true,
      prerequisites: ["An operator has decided the answer to record."]
    }, {
      command: schedulerCommand("events", graphPath, ["--node", nodeId, "--limit", "20"]),
      description: "Inspect recent node events before deciding to reset instead.",
      safeToRun: true
    }],
    prerequisites: ["Use reset instead of answer only after verifying the blocked question no longer applies."]
  };
}

function failedNodeRemediation(nodeId: string, graphPath: string | undefined, report?: string): DiagnosticRemediation {
  return {
    category: "failed-node",
    severity: "critical",
    summary: `Node ${nodeId} failed and should be inspected before retry.`,
    nodeId,
    commands: [{
      command: schedulerCommand("events", graphPath, ["--node", nodeId, "--limit", "20"]),
      description: "Inspect recent failure history.",
      safeToRun: true
    }, {
      command: schedulerCommand("reset", graphPath, ["--node", nodeId, "--reason", "<verified retry reason>"]),
      description: "Retry the failed node after the failure report has been reviewed.",
      safeToRun: true,
      prerequisites: [`Inspect ${report || "the node report or failure reason"} and confirm retry is intended.`]
    }]
  };
}

function missingOutputRefRemediation(nodeId: string, graphPath?: string): DiagnosticRemediation {
  return {
    category: "missing-output-ref",
    severity: "critical",
    summary: `Node ${nodeId} is missing an isolated output ref.`,
    nodeId,
    commands: [{
      command: schedulerCommand("events", graphPath, ["--node", nodeId, "--limit", "20"]),
      description: "Inspect isolation events before recovering or resetting output refs.",
      safeToRun: true
    }],
    prerequisites: ["Verify the expected output ref or decide to reset the affected isolated work."]
  };
}

function unresolvedBufferConflictRemediation(nodeId: string, graphPath?: string): DiagnosticRemediation {
  return {
    category: "unresolved-buffer-conflict",
    severity: "critical",
    summary: `Node ${nodeId} has an unresolved composition buffer conflict.`,
    nodeId,
    commands: [{
      command: schedulerCommand("events", graphPath, ["--node", nodeId, "--limit", "20"]),
      description: "Inspect merge conflict events before publishing or resetting the buffer.",
      safeToRun: true
    }],
    prerequisites: ["Resolve the integration workspace conflict before publishing downstream refs."]
  };
}

function lockRemediation(lock: GraphLockDiagnostics, graphPath?: string): DiagnosticRemediation {
  if (lock.stale) {
    const pid = lock.owner?.pid;
    return {
      category: "stale-lock",
      severity: "critical",
      summary: "A stale graph lock is present.",
      commands: [{
        command: pid ? `ps -p ${pid}` : schedulerCommand("diagnostics", graphPath),
        description: pid ? "Verify whether the recorded lock owner process is still running." : "Refresh lock diagnostics and inspect owner metadata.",
        safeToRun: true
      }, {
        command: schedulerCommand("diagnostics", graphPath),
        description: "Refresh lock diagnostics after verifying the owner state.",
        safeToRun: true
      }],
      prerequisites: ["Confirm the recorded owner process is gone before any manual lock cleanup."],
      notes: ["No destructive lock cleanup command is suggested by diagnostics."]
    };
  }
  return {
    category: "active-lock",
    severity: "warning",
    summary: "A graph lock is present and has not passed the stale threshold.",
    commands: [{
      command: schedulerCommand("diagnostics", graphPath),
      description: "Refresh diagnostics after waiting for the owner command to finish.",
      safeToRun: true
    }],
    prerequisites: ["Wait for the owner process or inspect lock metadata before intervening."]
  };
}

function schedulerCommand(command: string, graphPath?: string, args: string[] = []): string {
  return [
    "node",
    "scripts/plan-scheduler.mjs",
    command,
    "--graph",
    shellQuote(graphPath || "<graph>"),
    ...args.map((arg) => shellQuote(arg))
  ].join(" ");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

const isolationHistoryEvents = new Set([
  "clone-prepared",
  "branch-created",
  "output-ref-recorded",
  "merge-attempted",
  "merge-conflicted",
  "parent-ref-published"
]);

function historyString(history: GraphHistoryEntry[], key: string, event?: string): string | undefined {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (event && entry.event !== event) {
      continue;
    }
    const value = stringFromUnknown(entry[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function lastHistoryIndex(history: GraphHistoryEntry[], event: string): number {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index].event === event) {
      return index;
    }
  }
  return -1;
}

function mergeRefInputs(
  history: GraphHistoryEntry[],
  event: string,
  fallback: NodeIntegrationInputRefMetadata[] = []
): NodeIntegrationInputRefMetadata[] {
  const refs = new Map<string, NodeIntegrationInputRefMetadata>();
  for (const input of fallback) {
    refs.set(`${input.nodeId}\0${input.outputRef}`, input);
  }
  for (const entry of history) {
    if (entry.event !== event) {
      continue;
    }
    const nodeId = stringFromUnknown(entry.childId);
    const outputRef = stringFromUnknown(entry.childOutputRef);
    if (!nodeId || !outputRef) {
      continue;
    }
    refs.set(`${nodeId}\0${outputRef}`, { nodeId, outputRef });
  }
  return [...refs.values()];
}

function stringFromUnknown(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (value && typeof value === "object" && "name" in value) {
    const name = (value as { name?: unknown }).name;
    return typeof name === "string" && name.length > 0 ? name : undefined;
  }
  return undefined;
}
