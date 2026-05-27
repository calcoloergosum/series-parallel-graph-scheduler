import type { GraphNode, GraphSummary, NodeId, PlanGraphFile, ReadyNode, WorkingNode } from "./contracts.js";

export const terminalStatuses = new Set<string>(["done"]);
export const busyStatuses = new Set<string>(["claimed", "running", "blocked", "review", "failed"]);
export const autoReleasableStatuses = new Set<string>(["claimed", "running"]);

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
  if (isLeaf(graph, nodeId)) {
    return terminalStatuses.has(node.status ?? "pending");
  }
  return node.children?.every((childId) => isSubtreeDone(graph, childId)) ?? true;
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
  return ready;
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
      report: node.report
    }))
    .sort((left, right) => {
      const leftTime = left.claimedAt || left.expiresAt || "";
      const rightTime = right.claimedAt || right.expiresAt || "";
      return leftTime.localeCompare(rightTime) || left.id.localeCompare(right.id);
    });
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
