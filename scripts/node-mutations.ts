import { randomUUID } from "node:crypto";

import type {
  AnswerNodeResult,
  DecomposeNodeResult,
  GraphNode,
  LeaseClaimResult,
  NodeId,
  NodeKind,
  NodeMutationResult,
  NodeStatus,
  PlanGraphFile,
  ReconcileGraphResult,
  ReleaseExpiredLeasesResult,
  RenewLeaseResult,
  ResetNodeResult,
  ResetSubtreeResult
} from "./contracts.js";
import { defaultGraphPath, readGraph, withGraphLock, writeGraphAtomic } from "./graph-io.js";
import {
  autoReleasableStatuses,
  findAncestorIds,
  getNode,
  isLeaf,
  listReadyLeafNodes,
  summarizeGraph,
  terminalStatuses
} from "./graph-traversal.js";

export interface ClaimNodeOptions {
  session?: string;
  nodeId?: NodeId;
  leaseSeconds?: number;
}

export interface OwnedNodeOptions {
  nodeId?: NodeId;
  session?: string;
  runId?: string;
}

export interface CompleteNodeOptions extends OwnedNodeOptions {
  report?: string;
}

export interface BlockNodeOptions extends OwnedNodeOptions {
  question?: string;
  reason?: string;
}

export interface AnswerNodeOptions {
  nodeId?: NodeId;
  answer?: string;
  responder?: string;
}

export interface FailNodeOptions extends OwnedNodeOptions {
  reason?: string;
  report?: string;
}

export interface RenewNodeLeaseOptions extends OwnedNodeOptions {
  leaseSeconds?: number;
}

export interface ResetNodeOptions {
  nodeId?: NodeId;
  reason?: string;
}

export interface DecomposeChildDefinition {
  id: NodeId;
  title: string;
  kind?: NodeKind;
  status?: NodeStatus;
  children?: NodeId[];
}

export interface DecomposeNodeOptions extends OwnedNodeOptions {
  kind?: NodeKind;
  children?: DecomposeChildDefinition[];
}

interface LeaseOwner {
  session?: string;
  runId?: string;
}

interface UpdateNodeStatusOptions {
  nodeId?: NodeId;
  status: NodeStatus;
  owner?: LeaseOwner;
  validate?: (graph: PlanGraphFile, node: GraphNode) => void;
  patch?: (node: GraphNode, graph: PlanGraphFile) => void;
}

export async function claimNode(
  graphPath: string,
  { session, nodeId, leaseSeconds }: ClaimNodeOptions = {}
): Promise<LeaseClaimResult> {
  return withGraphLock(graphPath, async () => {
    const graph = await readGraph(graphPath);
    const released = releaseExpiredLeasesInGraph(graph, new Date());
    const ready = listReadyLeafNodes(graph);
    const target = nodeId ? ready.find((node) => node.id === nodeId) : ready[0];

    if (!target) {
      if (released.length > 0) {
        reconcileCompletedSubtrees(graph);
        graph.graphVersion = (graph.graphVersion || 0) + 1;
        await writeGraphAtomic(graph, graphPath);
      }
      throw new Error(nodeId
        ? `Node is not ready to claim: ${nodeId} in graph ${graphPath}`
        : `No ready nodes to claim in graph ${graphPath}`);
    }

    const leaseDuration = leaseSeconds ?? graph.scheduler?.leaseSeconds ?? 1800;
    const now = new Date();
    const runId = `run_${now.toISOString().replaceAll(/[-:.]/g, "").replace("T", "_").replace("Z", "")}_${target.id}_${randomUUID().slice(0, 8)}`;
    const node = getNode(graph, target.id);
    node.status = "claimed";
    node.lease = {
      session: session || "codex",
      runId,
      claimedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + leaseDuration * 1000).toISOString()
    };
    appendHistory(node, "claimed", { session: node.lease.session, runId });
    graph.graphVersion = (graph.graphVersion || 0) + 1;

    await writeGraphAtomic(graph, graphPath);
    return { nodeId: target.id, title: node.title, runId, lease: node.lease, releasedExpired: released, summary: summarizeGraph(graph) };
  });
}

export async function startNode(graphPath: string, { nodeId, session, runId }: OwnedNodeOptions = {}): Promise<NodeMutationResult> {
  return updateNodeStatus(graphPath, {
    nodeId,
    status: "running",
    owner: { session, runId },
    validate: (graph, node) => {
      assertLeafNode(graph, nodeId);
      assertStatus(node, ["claimed"], "start");
    },
    patch: (node) => {
      node.startedAt = new Date().toISOString();
      if (session && node.lease) {
        node.lease.session = session;
      }
    }
  });
}

export async function completeNode(
  graphPath: string,
  { nodeId, report, session, runId }: CompleteNodeOptions = {}
): Promise<NodeMutationResult> {
  return updateNodeStatus(graphPath, {
    nodeId,
    status: "done",
    owner: { session, runId },
    validate: (graph, node) => {
      assertLeafNode(graph, nodeId);
      assertStatus(node, ["claimed", "running", "blocked", "review"], "complete");
    },
    patch: (node) => {
      node.completedAt = new Date().toISOString();
      if (report) {
        node.report = report;
      }
      delete node.lease;
      delete node.blockedReason;
      delete node.question;
    }
  });
}

export async function blockNode(
  graphPath: string,
  { nodeId, question, reason, session, runId }: BlockNodeOptions = {}
): Promise<NodeMutationResult> {
  return updateNodeStatus(graphPath, {
    nodeId,
    status: "blocked",
    owner: { session, runId },
    validate: (graph, node) => {
      assertLeafNode(graph, nodeId);
      assertStatus(node, ["claimed", "running"], "block");
    },
    patch: (node) => {
      node.blockedAt = new Date().toISOString();
      node.blockedReason = reason || "needs_operator_decision";
      if (question) {
        node.question = question;
      }
    }
  });
}

export async function answerNode(
  graphPath: string,
  { nodeId, answer, responder }: AnswerNodeOptions = {}
): Promise<AnswerNodeResult> {
  if (!nodeId) {
    throw new Error("Missing node id");
  }
  if (!answer) {
    throw new Error("answer requires --answer");
  }

  return withGraphLock(graphPath, async () => {
    const graph = await readGraph(graphPath);
    const node = getNode(graph, nodeId);
    assertLeafNode(graph, nodeId);
    assertStatus(node, ["blocked"], "answer");

    node.status = "pending";
    node.answer = String(answer);
    node.answeredAt = new Date().toISOString();
    if (responder) {
      node.answeredBy = responder;
    } else {
      delete node.answeredBy;
    }
    delete node.lease;
    appendHistory(node, "answered", { answer: node.answer, responder: node.answeredBy });

    graph.graphVersion = (graph.graphVersion || 0) + 1;
    await writeGraphAtomic(graph, graphPath);
    return { nodeId, status: node.status, answer: node.answer, summary: summarizeGraph(graph) } as AnswerNodeResult;
  });
}

export async function failNode(
  graphPath: string,
  { nodeId, reason, report, session, runId }: FailNodeOptions = {}
): Promise<NodeMutationResult> {
  return updateNodeStatus(graphPath, {
    nodeId,
    status: "failed",
    owner: { session, runId },
    validate: (graph, node) => {
      assertLeafNode(graph, nodeId);
      assertStatus(node, ["claimed", "running", "blocked", "review"], "fail");
    },
    patch: (node) => {
      node.failedAt = new Date().toISOString();
      node.failureReason = reason || "unspecified";
      if (report) {
        node.report = report;
      }
      delete node.lease;
    }
  });
}

export async function releaseExpiredLeases(graphPath: string, now = new Date()): Promise<ReleaseExpiredLeasesResult> {
  return withGraphLock(graphPath, async () => {
    const graph = await readGraph(graphPath);
    const released = releaseExpiredLeasesInGraph(graph, now);

    if (released.length > 0) {
      reconcileCompletedSubtrees(graph);
      graph.graphVersion = (graph.graphVersion || 0) + 1;
      await writeGraphAtomic(graph, graphPath);
    }

    return { released, summary: summarizeGraph(graph) };
  });
}

export async function renewNodeLease(
  graphPath: string,
  { nodeId, session, runId, leaseSeconds }: RenewNodeLeaseOptions = {}
): Promise<RenewLeaseResult> {
  if (!nodeId) {
    throw new Error("Missing node id");
  }

  return withGraphLock(graphPath, async () => {
    const graph = await readGraph(graphPath);
    const node = getNode(graph, nodeId);
    assertLeafNode(graph, nodeId);
    if (!node.lease) {
      throw new Error(`Cannot renew node without a lease: ${nodeId}`);
    }
    assertStatus(node, ["claimed", "running", "blocked", "review"], "renew");
    assertLeaseOwner(node, { session, runId });

    const leaseDuration = leaseSeconds ?? graph.scheduler?.leaseSeconds ?? 1800;
    const now = new Date();
    node.lease.renewedAt = now.toISOString();
    node.lease.expiresAt = new Date(now.getTime() + leaseDuration * 1000).toISOString();
    graph.graphVersion = (graph.graphVersion || 0) + 1;
    await writeGraphAtomic(graph, graphPath);
    return { nodeId, lease: node.lease, summary: summarizeGraph(graph) };
  });
}

export async function resetNode(graphPath: string, { nodeId, reason }: ResetNodeOptions = {}): Promise<ResetNodeResult> {
  if (!nodeId) {
    throw new Error("Missing node id");
  }

  return withGraphLock(graphPath, async () => {
    const graph = await readGraph(graphPath);
    const node = getNode(graph, nodeId);
    assertLeafNode(graph, nodeId);

    resetNodeState(node, "reset", { reason: reason || "manual_reset" });

    const resetAncestors: NodeId[] = [];
    for (const ancestorId of findAncestorIds(graph, nodeId)) {
      const ancestor = getNode(graph, ancestorId);
      if (ancestor.status === "done") {
        ancestor.status = "pending";
        delete ancestor.completedAt;
        appendHistory(ancestor, "child_reset", { childId: nodeId });
        resetAncestors.push(ancestorId);
      }
    }

    graph.graphVersion = (graph.graphVersion || 0) + 1;
    await writeGraphAtomic(graph, graphPath);
    return { nodeId, status: node.status || "pending", resetAncestors, summary: summarizeGraph(graph) };
  });
}

export async function resetSubtree(graphPath: string, { nodeId, reason }: ResetNodeOptions = {}): Promise<ResetSubtreeResult> {
  if (!nodeId) {
    throw new Error("Missing node id");
  }

  return withGraphLock(graphPath, async () => {
    const graph = await readGraph(graphPath);
    const resetNodes = collectChildReachableNodeIds(graph, nodeId);

    for (const resetNodeId of resetNodes) {
      resetNodeState(getNode(graph, resetNodeId), "reset_subtree", {
        reason: reason || "manual_subtree_reset",
        rootId: nodeId
      });
    }

    graph.graphVersion = (graph.graphVersion || 0) + 1;
    await writeGraphAtomic(graph, graphPath);
    return { nodeId, resetNodes, summary: summarizeGraph(graph) };
  });
}

export async function resetReachable(graphPath: string, { nodeId, reason }: ResetNodeOptions = {}): Promise<ResetSubtreeResult> {
  if (!nodeId) {
    throw new Error("Missing node id");
  }

  return withGraphLock(graphPath, async () => {
    const graph = await readGraph(graphPath);
    const resetNodes = collectExecutionReachableNodeIds(graph, nodeId);

    for (const resetNodeId of resetNodes) {
      resetNodeState(getNode(graph, resetNodeId), "reset_reachable", {
        reason: reason || "manual_reachable_reset",
        rootId: nodeId
      });
    }

    graph.graphVersion = (graph.graphVersion || 0) + 1;
    await writeGraphAtomic(graph, graphPath);
    return { nodeId, resetNodes, summary: summarizeGraph(graph) };
  });
}

export async function reconcileGraphStatus(graphPath = defaultGraphPath): Promise<ReconcileGraphResult> {
  return withGraphLock(graphPath, async () => {
    const graph = await readGraph(graphPath);
    const changed = reconcileCompletedSubtrees(graph);
    if (changed.length > 0) {
      graph.graphVersion = (graph.graphVersion || 0) + 1;
      await writeGraphAtomic(graph, graphPath);
    }
    return { changed, summary: summarizeGraph(graph) };
  });
}

export async function decomposeNode(
  graphPath: string,
  { nodeId, kind, children, session, runId }: DecomposeNodeOptions = {}
): Promise<DecomposeNodeResult> {
  if (!nodeId || !Array.isArray(children) || children.length === 0) {
    throw new Error("decompose requires --node and at least one child definition");
  }

  return withGraphLock(graphPath, async () => {
    const graph = await readGraph(graphPath);
    const node = getNode(graph, nodeId);
    if (!isLeaf(graph, nodeId)) {
      throw new Error(`Cannot decompose non-leaf node: ${nodeId}`);
    }
    assertStatus(node, ["claimed", "running"], "decompose");
    assertLeaseOwner(node, { session, runId });

    const normalizedChildren = normalizeChildDefinitions(children);

    node.kind = kind || "series";
    node.status = "pending";
    node.children = normalizedChildren.map((child) => child.id);
    delete node.lease;
    delete node.startedAt;
    delete node.blockedAt;
    delete node.blockedReason;
    delete node.question;
    appendHistory(node, "decomposed", { childIds: node.children, session, runId });

    for (const child of normalizedChildren) {
      if (graph.graph.nodes[child.id]) {
        throw new Error(`Child node already exists: ${child.id}`);
      }
      graph.graph.nodes[child.id] = {
        title: child.title,
        kind: child.kind || "task",
        status: child.status || "pending",
        children: child.children
      };
      if (!graph.graph.nodes[child.id].children) {
        delete graph.graph.nodes[child.id].children;
      }
    }

    reconcileCompletedSubtrees(graph);
    graph.graphVersion = (graph.graphVersion || 0) + 1;
    await writeGraphAtomic(graph, graphPath);
    return { nodeId, children: node.children, summary: summarizeGraph(graph) };
  });
}

async function updateNodeStatus(graphPath: string, { nodeId, status, owner, validate, patch }: UpdateNodeStatusOptions): Promise<NodeMutationResult> {
  if (!nodeId) {
    throw new Error("Missing node id");
  }

  return withGraphLock(graphPath, async () => {
    const graph = await readGraph(graphPath);
    const node = getNode(graph, nodeId);
    validate?.(graph, node);
    assertLeaseOwner(node, owner);
    node.status = status;
    patch?.(node, graph);
    appendHistory(node, status);
    reconcileCompletedSubtrees(graph);
    graph.graphVersion = (graph.graphVersion || 0) + 1;
    await writeGraphAtomic(graph, graphPath);
    return { nodeId, status, title: node.title, summary: summarizeGraph(graph) };
  });
}

function reconcileCompletedSubtrees(graph: PlanGraphFile): NodeId[] {
  const changed: NodeId[] = [];
  const rootId = graph.graph?.root;
  if (!rootId) {
    return changed;
  }

  function visit(nodeId: NodeId, stack: NodeId[] = []): boolean {
    if (stack.includes(nodeId)) {
      throw new Error(`Cycle detected in graph: ${[...stack, nodeId].join(" -> ")}`);
    }

    const node = getNode(graph, nodeId);
    if (isLeaf(graph, nodeId)) {
      return terminalStatuses.has(node.status ?? "pending");
    }

    const childrenDone = node.children?.every((childId) => visit(childId, [...stack, nodeId])) ?? true;
    if (childrenDone && node.status !== "done") {
      node.status = "done";
      node.completedAt ||= new Date().toISOString();
      appendHistory(node, "subtree_done");
      changed.push(nodeId);
    }
    return childrenDone && terminalStatuses.has(node.status ?? "pending");
  }

  visit(rootId);
  return changed;
}

function releaseExpiredLeasesInGraph(graph: PlanGraphFile, now = new Date()): NodeId[] {
  const released: NodeId[] = [];
  const nowMs = now.getTime();

  for (const [nodeId, node] of Object.entries(graph.graph?.nodes || {})) {
    if (!node.lease?.expiresAt || !autoReleasableStatuses.has(node.status || "pending")) {
      continue;
    }

    const expiresAtMs = new Date(node.lease.expiresAt).getTime();
    if (!Number.isFinite(expiresAtMs) || expiresAtMs > nowMs) {
      continue;
    }

    released.push(nodeId);
    appendHistory(node, "lease_expired", { previousStatus: node.status, runId: node.lease.runId });
    node.status = "pending";
    node.expiredAt = now.toISOString();
    delete node.lease;
    delete node.startedAt;
  }

  return released;
}

function collectChildReachableNodeIds(graph: PlanGraphFile, nodeId: NodeId): NodeId[] {
  const nodeIds: NodeId[] = [];

  function visit(currentId: NodeId, stack: NodeId[] = []): void {
    if (stack.includes(currentId)) {
      throw new Error(`Cycle detected in graph: ${[...stack, currentId].join(" -> ")}`);
    }

    const node = getNode(graph, currentId);
    nodeIds.push(currentId);

    for (const childId of Array.isArray(node.children) ? node.children : []) {
      visit(childId, [...stack, currentId]);
    }
  }

  visit(nodeId);
  return nodeIds;
}

function collectExecutionReachableNodeIds(graph: PlanGraphFile, nodeId: NodeId): NodeId[] {
  const rootId = graph.graph?.root;
  if (!rootId) {
    return collectChildReachableNodeIds(graph, nodeId);
  }

  const path = findPathFromRoot(graph, nodeId);
  if (path.length === 0) {
    getNode(graph, nodeId);
    return collectChildReachableNodeIds(graph, nodeId);
  }

  const nodeIds: NodeId[] = [];
  const seen = new Set<NodeId>();
  const addSubtree = (subtreeRootId: NodeId): void => {
    for (const reachableId of collectChildReachableNodeIds(graph, subtreeRootId)) {
      if (!seen.has(reachableId)) {
        seen.add(reachableId);
        nodeIds.push(reachableId);
      }
    }
  };

  addSubtree(nodeId);

  for (let index = path.length - 2; index >= 0; index -= 1) {
    const parentId = path[index];
    const childOnPathId = path[index + 1];
    const parent = getNode(graph, parentId);
    if (parent.kind !== "series" || !Array.isArray(parent.children)) {
      continue;
    }

    const childIndex = parent.children.indexOf(childOnPathId);
    for (const siblingId of parent.children.slice(childIndex + 1)) {
      addSubtree(siblingId);
    }
  }

  return nodeIds;
}

function findPathFromRoot(graph: PlanGraphFile, targetId: NodeId): NodeId[] {
  const rootId = graph.graph?.root;
  if (!rootId) {
    return [];
  }

  function visit(currentId: NodeId, path: NodeId[] = []): NodeId[] {
    const nextPath = [...path, currentId];
    if (currentId === targetId) {
      return nextPath;
    }

    const node = getNode(graph, currentId);
    for (const childId of Array.isArray(node.children) ? node.children : []) {
      const childPath = visit(childId, nextPath);
      if (childPath.length > 0) {
        return childPath;
      }
    }

    return [];
  }

  return visit(rootId);
}

function resetNodeState(node: GraphNode, event: string, metadata: Record<string, unknown> = {}): void {
  const previousStatus = node.status || "pending";
  node.status = "pending";
  delete node.lease;
  delete node.startedAt;
  delete node.completedAt;
  delete node.failedAt;
  delete node.failureReason;
  delete node.blockedAt;
  delete node.blockedReason;
  delete node.question;
  delete node.report;
  delete node.expiredAt;
  appendHistory(node, event, { previousStatus, ...metadata });
}

function assertLeafNode(graph: PlanGraphFile, nodeId: NodeId | undefined): asserts nodeId is NodeId {
  if (!nodeId || !isLeaf(graph, nodeId)) {
    throw new Error(`Only leaf nodes can be mutated directly: ${nodeId}`);
  }
}

function assertStatus(node: GraphNode, allowedStatuses: readonly string[], action: string): void {
  const current = node.status || "pending";
  if (!allowedStatuses.includes(current)) {
    throw new Error(`Cannot ${action} node from status ${current}; expected one of ${allowedStatuses.join(", ")}`);
  }
}

function assertLeaseOwner(node: GraphNode, owner: LeaseOwner = {}): void {
  if (!node.lease) {
    return;
  }

  const { session, runId } = owner;
  if (!session && !runId) {
    throw new Error("A session or runId is required to update a leased node");
  }
  if (runId && node.lease.runId !== runId) {
    throw new Error(`Lease runId mismatch for node; expected ${node.lease.runId}`);
  }
  if (session && node.lease.session !== session) {
    throw new Error(`Lease session mismatch for node; expected ${node.lease.session}`);
  }
}

function normalizeChildDefinitions(children: DecomposeChildDefinition[]): DecomposeChildDefinition[] {
  const normalized: DecomposeChildDefinition[] = [];
  const seen = new Set<NodeId>();

  for (const child of children) {
    if (!child || typeof child !== "object") {
      throw new Error("Each child must be an object");
    }
    if (!child.id || !child.title) {
      throw new Error("Each child requires id and title");
    }
    if (seen.has(child.id)) {
      throw new Error(`Duplicate child id in decomposition: ${child.id}`);
    }
    seen.add(child.id);
    normalized.push({
      id: child.id,
      title: child.title,
      kind: child.kind || "task",
      status: child.status || "pending",
      children: child.children
    });
  }

  return normalized;
}

function appendHistory(node: GraphNode, event: string, details: Record<string, unknown> = {}): void {
  node.history ||= [];
  node.history.push({
    at: new Date().toISOString(),
    event,
    ...details
  });
}
