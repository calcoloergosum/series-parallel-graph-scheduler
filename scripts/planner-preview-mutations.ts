import type {
  GraphNode,
  NodeId,
  NodePlannerMetadata,
  PlanGraphFile,
  PlannerOutputKind,
  PlannerPreviewMutationResult,
  PlannerRuntime
} from "./contracts.js";
import { readGraph, withGraphLock, writeGraphAtomic } from "./graph-io.js";
import { getNode, isLeaf, summarizeGraph } from "./graph-traversal.js";
import {
  planNodeDecomposition,
  schedulerTransitionTable
} from "./node-mutations.js";
import { operationalEvents, redactOperationalEventDetails } from "./operational-events.js";
import { pendingPlannerPreviewNodeState } from "./decompose-validation.js";

export interface RegeneratePlannerPreviewOptions {
  nodeId?: NodeId;
  planner: PlannerRuntime;
  requestId?: string;
  goal?: string;
  allowedKinds?: PlannerOutputKind[];
  plannerMetadata?: NodePlannerMetadata;
  session?: string;
  runId?: string;
  report?: string;
}

export async function regeneratePlannerPreview(
  graphPath: string,
  {
    nodeId,
    planner,
    requestId,
    goal,
    allowedKinds,
    plannerMetadata,
    session,
    runId,
    report
  }: RegeneratePlannerPreviewOptions
): Promise<PlannerPreviewMutationResult> {
  if (!nodeId) {
    throw new Error("regenerate-preview requires --node");
  }

  const sourceGraph = await readGraph(graphPath);
  const sourceNode = getNode(sourceGraph, nodeId);
  assertLeafNode(sourceGraph, nodeId);
  assertStatus(sourceNode, schedulerTransitionTable["regenerate-preview"].allowedFrom, "regenerate-preview");
  assertLeaseOwner(sourceNode, { session, runId });
  const sourceGraphVersion = sourceGraph.graphVersion || 0;

  const plan = await planNodeDecomposition(graphPath, {
    nodeId,
    planner,
    requestId,
    goal,
    allowedKinds,
    plannerMetadata
  });
  if (!plan.decompose || (plan.response.kind !== "series" && plan.response.kind !== "parallel")) {
    throw new Error(`Planner did not propose a decomposition for ${nodeId}`);
  }
  const decompose = plan.decompose;
  const childIds = decompose.children.map((child) => child.id);

  return withGraphLock(graphPath, async () => {
    const graph = await readGraph(graphPath);
    if ((graph.graphVersion || 0) !== sourceGraphVersion) {
      throw new Error(
        `Graph changed while regenerating planner preview for ${nodeId}: expected graphVersion ${sourceGraphVersion}, found ${graph.graphVersion ?? "unknown"}; retry regeneration`
      );
    }

    const node = getNode(graph, nodeId);
    assertLeafNode(graph, nodeId);
    assertStatus(node, schedulerTransitionTable["regenerate-preview"].allowedFrom, "regenerate-preview");
    assertLeaseOwner(node, { session, runId });

    const previousStatus = node.status || "pending";
    const previousPreview = node.pendingPlannerPreview;
    const blockedAt = new Date().toISOString();
    node.status = "blocked";
    node.blockedAt = blockedAt;
    node.blockedReason = `planner proposed ${plan.response.kind} decomposition`;
    node.question = plannerPreviewQuestion(nodeId, plan.response.kind, childIds, report);
    if (report) {
      node.report = report;
    }
    node.pendingPlannerPreview = {
      requestId: plan.requestId,
      sourceGraphVersion,
      graphVersion: sourceGraphVersion + 1,
      nodeState: pendingPlannerPreviewNodeState(node),
      proposedKind: plan.response.kind,
      childIds,
      report,
      planner: plan.planner,
      response: plan.response,
      decompose,
      validation: plan.validation,
      createdAt: blockedAt
    };

    appendHistory(node, operationalEvents.blocked, {
      previousStatus,
      status: node.status,
      session,
      runId,
      blockedAt,
      blockedReason: node.blockedReason,
      question: node.question,
      report
    });
    appendHistory(node, operationalEvents.plannerPreviewRegenerated, {
      previousStatus,
      status: node.status,
      session,
      runId,
      previousRequestId: previousPreview?.requestId,
      requestId: plan.requestId,
      proposedKind: plan.response.kind,
      childIds,
      reason: previousPreview ? "planner preview regenerated" : "planner preview generated",
      report
    });

    graph.graphVersion = sourceGraphVersion + 1;
    await writeGraphAtomic(graph, graphPath);
    return {
      nodeId,
      status: node.status,
      title: node.title,
      requestId: plan.requestId,
      childIds,
      summary: summarizeGraph(graph)
    };
  });
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

function assertLeaseOwner(node: GraphNode, owner: { session?: string; runId?: string } = {}): void {
  if (!node.lease) {
    return;
  }
  if (!owner.session && !owner.runId) {
    throw new Error("A session or runId is required to update a leased node");
  }
  if (owner.runId && node.lease.runId !== owner.runId) {
    throw new Error(`Lease runId mismatch for node; expected ${node.lease.runId}`);
  }
  if (owner.session && node.lease.session !== owner.session) {
    throw new Error(`Lease session mismatch for node; expected ${node.lease.session}`);
  }
}

function plannerPreviewQuestion(nodeId: NodeId, kind: string, childIds: NodeId[], report?: string): string {
  return [
    `Planner proposed ${kind} decomposition for ${nodeId}.`,
    `Children: ${childIds.join(", ") || "none"}.`,
    report ? `Report: ${report}.` : undefined,
    "Apply, reject, or regenerate the preview before continuing."
  ].filter(Boolean).join(" ");
}

function appendHistory(node: GraphNode, event: string, details: Record<string, unknown> = {}): void {
  node.history ||= [];
  node.history.push({
    at: new Date().toISOString(),
    event,
    ...omitUndefined(redactOperationalEventDetails(details))
  });
}

function omitUndefined(details: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(details).filter(([, value]) => value !== undefined));
}
