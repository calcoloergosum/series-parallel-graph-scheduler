import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  knownNodeStatuses,
  type AnswerNodeResult,
  type DecomposeNodeResult,
  type GitDiffStatMetadata,
  type GraphNode,
  type LeaseClaimResult,
  type NodeBaseRefMetadata,
  type NodeId,
  type NodeIntegrationInputRefMetadata,
  type NodeKind,
  type NodePlannerMetadata,
  type NodeMutationResult,
  type NodeStatus,
  type NodeWorkspaceMetadata,
  type PendingPlannerPreviewMetadata,
  type PlanGraphFile,
  type PlannerOutputKind,
  type PlannerRuntime,
  type PlannerRuntimeResponse,
  type ReconcileGraphResult,
  type ReleaseExpiredLeasesResult,
  type RenewLeaseResult,
  type ResetNodeResult,
  type ResetSubtreeResult,
  type WorkerRunRefMetadata
} from "./contracts.js";
import { validatePlanGraphFileResult } from "./contracts.js";

import { defaultGraphPath, readGraph, withGraphLock, writeGraphAtomic, writeReportFile } from "./graph-io.js";
import { aggregateChildGitFootprints, gitFootprintFromNode } from "./git-footprint.js";
import { collectGitDiffStat } from "./git-runtime.js";
import {
  findAncestorIds,
  getNode,
  isLeaf,
  listReadyLeafNodes,
  resolveNodeBaseRef,
  selectReadyNodeByPriority,
  summarizeGraph,
  terminalStatuses
} from "./graph-traversal.js";
import {
  operationalEvents,
  redactOperationalEventDetails,
  type OperationalEventName
} from "./operational-events.js";
import { buildPlannerRuntimeRequest, plannerResponseToDecomposeMutation } from "./planner-runtime.js";
import { errorMessage, safeFilePart } from "./shared-utils.js";

export interface ClaimNodeOptions {
  session?: string;
  nodeId?: NodeId;
  currentTaskId?: NodeId;
  leaseSeconds?: number;
  resolveBaseRef?: boolean;
}

export interface OwnedNodeOptions {
  nodeId?: NodeId;
  session?: string;
  runId?: string;
}

export interface CompleteNodeOptions extends OwnedNodeOptions {
  report?: string;
  refMetadata?: WorkerRunRefMetadata;
}

export interface BlockNodeOptions extends OwnedNodeOptions {
  question?: string;
  reason?: string;
  report?: string;
  plannerPreview?: PendingPlannerPreviewMetadata;
  extraHistoryEvents?: ExtraNodeHistoryEvent[];
}

export interface AnswerNodeOptions {
  nodeId?: NodeId;
  answer?: string;
  responder?: string;
}

export interface FailNodeOptions extends OwnedNodeOptions {
  reason?: string;
  report?: string;
  refMetadata?: WorkerRunRefMetadata;
  extraHistoryEvents?: ExtraNodeHistoryEvent[];
}

export interface RenewNodeLeaseOptions extends OwnedNodeOptions {
  leaseSeconds?: number;
}

export interface RecordWorkerRefMetadataOptions extends OwnedNodeOptions {
  report?: string;
  refMetadata?: WorkerRunRefMetadata;
}

export interface PublishResolvedIntegrationOptions {
  nodeId?: NodeId;
  report?: string;
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
  [metadata: string]: unknown;
}

export interface DecomposeNodeOptions extends OwnedNodeOptions {
  kind?: NodeKind;
  children?: DecomposeChildDefinition[];
}

export interface PlanNodeDecompositionOptions extends OwnedNodeOptions {
  planner: PlannerRuntime;
  requestId?: string;
  goal?: string;
  allowedKinds?: PlannerOutputKind[];
  plannerMetadata?: NodePlannerMetadata;
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
  patch?: (node: GraphNode, graph: PlanGraphFile) => Record<string, unknown> | void | Promise<Record<string, unknown> | void>;
  extraHistoryEvents?: ExtraNodeHistoryEvent[];
}

export interface ExtraNodeHistoryEvent {
  event: OperationalEventName;
  details?: Record<string, unknown>;
}

export type SchedulerTransitionActor = "worker" | "operator" | "system";

export interface SchedulerTransitionRule {
  actor: SchedulerTransitionActor;
  implementation: string;
  scope: string;
  allowedFrom: readonly string[];
  additionalAllowedFrom?: string;
  to: NodeStatus | "same";
  lease: string;
}

const resettableKnownStatuses = knownNodeStatuses;

// This table is the source of truth for command state guards in this module.
// Keep generated transition docs and transition tests aligned with it.
export const schedulerTransitionTable = {
  claim: {
    actor: "worker",
    implementation: "claimNode",
    scope: "ready leaf; claim also releases expired claimed/running leases before selecting work",
    allowedFrom: ["pending"],
    additionalAllowedFrom: "custom non-busy, non-terminal leaf statuses",
    to: "claimed",
    lease: "creates a new lease; no prior owner required"
  },
  start: {
    actor: "worker",
    implementation: "startNode",
    scope: "leaf",
    allowedFrom: ["claimed"],
    to: "running",
    lease: "requires matching session or run id when the node is leased; unleased legacy nodes are accepted"
  },
  renew: {
    actor: "worker",
    implementation: "renewNodeLease",
    scope: "leased leaf",
    allowedFrom: ["claimed", "running", "blocked", "review"],
    to: "same",
    lease: "requires an existing lease and matching session or run id"
  },
  done: {
    actor: "worker",
    implementation: "completeNode",
    scope: "leaf",
    allowedFrom: ["claimed", "running", "blocked", "review"],
    to: "done",
    lease: "requires matching session or run id when the node is leased; clears any lease"
  },
  block: {
    actor: "worker",
    implementation: "blockNode",
    scope: "leaf",
    allowedFrom: ["claimed", "running"],
    to: "blocked",
    lease: "requires matching session or run id when the node is leased; preserves any lease"
  },
  answer: {
    actor: "operator",
    implementation: "answerNode",
    scope: "blocked leaf",
    allowedFrom: ["blocked"],
    to: "pending",
    lease: "does not require owner credentials; clears any lease"
  },
  fail: {
    actor: "worker",
    implementation: "failNode",
    scope: "leaf",
    allowedFrom: ["claimed", "running", "blocked", "review"],
    to: "failed",
    lease: "requires matching session or run id when the node is leased; clears any lease"
  },
  reset: {
    actor: "operator",
    implementation: "resetNode",
    scope: "leaf",
    allowedFrom: resettableKnownStatuses,
    additionalAllowedFrom: "custom statuses",
    to: "pending",
    lease: "does not require owner credentials; clears any lease"
  },
  "reset-subtree": {
    actor: "operator",
    implementation: "resetSubtree",
    scope: "selected node and child-reachable descendants",
    allowedFrom: resettableKnownStatuses,
    additionalAllowedFrom: "custom statuses",
    to: "pending",
    lease: "does not require owner credentials; clears any lease in the reset set"
  },
  "reset-reachable": {
    actor: "operator",
    implementation: "resetReachable",
    scope: "selected node, descendants, and later execution-reachable series work",
    allowedFrom: resettableKnownStatuses,
    additionalAllowedFrom: "custom statuses",
    to: "pending",
    lease: "does not require owner credentials; clears any lease in the reset set"
  },
  decompose: {
    actor: "worker",
    implementation: "decomposeNode",
    scope: "leaf",
    allowedFrom: ["claimed", "running", "blocked"],
    to: "pending",
    lease: "requires matching session or run id when the node is leased; clears any lease and creates child nodes"
  },
  reconcile: {
    actor: "system",
    implementation: "reconcileGraphStatus",
    scope: "non-leaf whose child subtrees are all done",
    allowedFrom: ["pending", "claimed", "running", "blocked", "review", "failed"],
    to: "done",
    lease: "does not inspect or require leases"
  },
  "release-expired": {
    actor: "system",
    implementation: "releaseExpiredLeases",
    scope: "nodes with expired leases",
    allowedFrom: ["claimed", "running"],
    to: "pending",
    lease: "requires an expired lease; clears the lease"
  }
} as const satisfies Record<string, SchedulerTransitionRule>;

const releaseExpiredAllowedStatuses = new Set<string>(schedulerTransitionTable["release-expired"].allowedFrom);
const resetClearedFields = [
  "lease",
  "startedAt",
  "completedAt",
  "failedAt",
  "failureReason",
  "blockedAt",
  "blockedReason",
  "question",
  "report",
  "expiredAt",
  "baseRef",
  "workspace",
  "workRef",
  "outputRef",
  "integrationRef",
  "gitFootprint",
  "gitFootprintWarning",
  "pendingPlannerPreview"
] as const;
const compositionResetClearedFields = ["outputRef", "integrationRef", "gitFootprint", "gitFootprintWarning"] as const;

export async function claimNode(
  graphPath: string,
  { session, nodeId, currentTaskId, leaseSeconds, resolveBaseRef }: ClaimNodeOptions = {}
): Promise<LeaseClaimResult> {
  return withGraphLock(graphPath, async () => {
    const graph = await readGraph(graphPath);
    const released = releaseExpiredLeasesInGraph(graph, new Date());
    const ready = listReadyLeafNodes(graph);
    const claimSession = session || "codex";
    const resolvedCurrentTaskId = nodeId
      ? undefined
      : resolveCurrentTaskIdForClaimPriority(graph, { session: claimSession, currentTaskId });
    const target = nodeId
      ? ready.find((node) => node.id === nodeId)
      : selectReadyNodeByPriority(graph, ready, resolvedCurrentTaskId);

    if (!target) {
      if (released.length > 0) {
        await reconcileCompletedSubtrees(graph, graphPath);
        graph.graphVersion = (graph.graphVersion || 0) + 1;
        await writeGraphAtomic(graph, graphPath);
      }
      throw new Error(nodeId
        ? `Node is not ready to claim: ${nodeId} in graph ${graphPath}`
        : `No ready nodes to claim in graph ${graphPath}`);
    }

    const resolvedBaseRef = resolveBaseRef ? resolveNodeBaseRef(graph, target.id) : undefined;
    const leaseDuration = leaseSeconds ?? graph.scheduler?.leaseSeconds ?? 1800;
    const now = new Date();
    const runId = `run_${now.toISOString().replaceAll(/[-:.]/g, "").replace("T", "_").replace("Z", "")}_${target.id}_${randomUUID().slice(0, 8)}`;
    const node = getNode(graph, target.id);
    const previousStatus = node.status || "pending";
    if (resolvedBaseRef) {
      node.baseRef = {
        ...node.baseRef,
        ...resolvedBaseRef,
        resolvedAt: now.toISOString()
      };
    }
    node.status = "claimed";
    node.lease = {
      session: claimSession,
      runId,
      claimedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + leaseDuration * 1000).toISOString()
    };
    appendHistory(node, operationalEvents.claimed, {
      previousStatus,
      status: node.status,
      session: node.lease.session,
      runId,
      leaseExpiresAt: node.lease.expiresAt,
      baseRef: resolvedBaseRef?.name,
      baseRefSource: resolvedBaseRef?.source
    });
    graph.graphVersion = (graph.graphVersion || 0) + 1;

    await writeGraphAtomic(graph, graphPath);
    return { nodeId: target.id, title: node.title, runId, lease: node.lease, baseRef: node.baseRef, releasedExpired: released, summary: summarizeGraph(graph) };
  });
}

function resolveCurrentTaskIdForClaimPriority(
  graph: PlanGraphFile,
  { session, currentTaskId }: { session: string; currentTaskId?: NodeId }
): NodeId | undefined {
  if (currentTaskId !== undefined) {
    if (typeof currentTaskId !== "string" || currentTaskId.length === 0) {
      throw new Error("Invalid explicit current task context: currentTaskId must be a non-empty string.");
    }
    return currentTaskId;
  }

  const activeSameSessionNodes = Object.entries(graph.graph.nodes)
    .filter(([, node]) => node.lease?.session === session && ["claimed", "running"].includes(node.status || "pending"))
    .map(([id]) => id);

  return activeSameSessionNodes.length === 1 ? activeSameSessionNodes[0] : undefined;
}

export async function startNode(graphPath: string, { nodeId, session, runId }: OwnedNodeOptions = {}): Promise<NodeMutationResult> {
  return updateNodeStatus(graphPath, {
    nodeId,
    status: "running",
    owner: { session, runId },
    validate: (graph, node) => {
      assertLeafNode(graph, nodeId);
      assertStatus(node, schedulerTransitionTable.start.allowedFrom, "start");
    },
    patch: (node) => {
      node.startedAt = new Date().toISOString();
      if (session && node.lease) {
        node.lease.session = session;
      }
      return { startedAt: node.startedAt };
    }
  });
}

export async function completeNode(
  graphPath: string,
  { nodeId, report, session, runId, refMetadata }: CompleteNodeOptions = {}
): Promise<NodeMutationResult> {
  return updateNodeStatus(graphPath, {
    nodeId,
    status: "done",
    owner: { session, runId },
    validate: (graph, node) => {
      assertLeafNode(graph, nodeId);
      assertStatus(node, schedulerTransitionTable.done.allowedFrom, "complete");
      assertOutputRefWhenIsolationRequired(graph, nodeId, node, refMetadata);
    },
    patch: async (node, graph) => {
      node.completedAt = new Date().toISOString();
      applyWorkerRefMetadata(node, refMetadata, { session, runId, report, now: node.completedAt });
      const footprintDetails = await attachGitFootprintMetadata(graph, graphPath, nodeId as NodeId, node, {
        now: node.completedAt,
        cloneCwd: refMetadata?.cloneCwd,
        bareRepoPath: refMetadata?.bareRepo
      });
      if (report) {
        node.report = report;
      }
      delete node.lease;
      delete node.blockedReason;
      delete node.question;
      return {
        completedAt: node.completedAt,
        report,
        clearedFields: ["lease", "blockedReason", "question"],
        ...footprintDetails
      };
    }
  });
}

export async function blockNode(
  graphPath: string,
  { nodeId, question, reason, report, session, runId, plannerPreview, extraHistoryEvents }: BlockNodeOptions = {}
): Promise<NodeMutationResult> {
  return updateNodeStatus(graphPath, {
    nodeId,
    status: "blocked",
    owner: { session, runId },
    extraHistoryEvents,
    validate: (graph, node) => {
      assertLeafNode(graph, nodeId);
      assertStatus(node, schedulerTransitionTable.block.allowedFrom, "block");
    },
    patch: (node, graph) => {
      node.blockedAt = new Date().toISOString();
      node.blockedReason = reason || "needs_operator_decision";
      if (question) {
        node.question = question;
      }
      if (report) {
        node.report = report;
      }
      if (plannerPreview) {
        node.pendingPlannerPreview = {
          ...plannerPreview,
          graphVersion: plannerPreview.graphVersion ?? (graph.graphVersion || 0) + 1,
          nodeState: plannerPreview.nodeState ?? pendingPlannerPreviewNodeState(node)
        };
      }
      return { blockedAt: node.blockedAt, blockedReason: node.blockedReason, question, report };
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
    assertStatus(node, schedulerTransitionTable.answer.allowedFrom, "answer");

    const previousStatus = node.status || "pending";
    node.status = "pending";
    node.answer = String(answer);
    node.answeredAt = new Date().toISOString();
    if (responder) {
      node.answeredBy = responder;
    } else {
      delete node.answeredBy;
    }
    delete node.lease;
    appendHistory(node, operationalEvents.answered, {
      previousStatus,
      status: node.status,
      answer: node.answer,
      responder: node.answeredBy,
      answeredAt: node.answeredAt,
      clearedFields: ["lease"]
    });

    graph.graphVersion = (graph.graphVersion || 0) + 1;
    await writeGraphAtomic(graph, graphPath);
    return { nodeId, status: "pending", answer: node.answer, summary: summarizeGraph(graph) };
  });
}

export async function failNode(
  graphPath: string,
  { nodeId, reason, report, session, runId, refMetadata, extraHistoryEvents }: FailNodeOptions = {}
): Promise<NodeMutationResult> {
  return updateNodeStatus(graphPath, {
    nodeId,
    status: "failed",
    owner: { session, runId },
    extraHistoryEvents,
    validate: (graph, node) => {
      assertLeafNode(graph, nodeId);
      assertStatus(node, schedulerTransitionTable.fail.allowedFrom, "fail");
    },
    patch: (node) => {
      node.failedAt = new Date().toISOString();
      node.failureReason = reason || "unspecified";
      applyWorkerRefMetadata(node, refMetadata, { session, runId, report, now: node.failedAt });
      if (report) {
        node.report = report;
      }
      delete node.lease;
      return {
        failedAt: node.failedAt,
        failureReason: node.failureReason,
        report,
        clearedFields: ["lease"]
      };
    }
  });
}

export async function recordWorkerRefMetadata(
  graphPath: string,
  { nodeId, report, session, runId, refMetadata }: RecordWorkerRefMetadataOptions = {}
): Promise<NodeMutationResult> {
  if (!nodeId) {
    throw new Error("Missing node id");
  }
  if (!refMetadata) {
    throw new Error("recordWorkerRefMetadata requires refMetadata");
  }

  return withGraphLock(graphPath, async () => {
    const graph = await readGraph(graphPath);
    const node = getNode(graph, nodeId);
    assertLeaseOwner(node, { session, runId });
    applyWorkerRefMetadata(node, refMetadata, { session, runId, report, now: new Date().toISOString() });
    graph.graphVersion = (graph.graphVersion || 0) + 1;
    await writeGraphAtomic(graph, graphPath);
    return { nodeId, status: node.status || "pending", title: node.title, summary: summarizeGraph(graph) };
  });
}

export async function releaseExpiredLeases(graphPath: string, now = new Date()): Promise<ReleaseExpiredLeasesResult> {
  return withGraphLock(graphPath, async () => {
    const graph = await readGraph(graphPath);
    const released = releaseExpiredLeasesInGraph(graph, now);

    if (released.length > 0) {
      await reconcileCompletedSubtrees(graph, graphPath);
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
    assertStatus(node, schedulerTransitionTable.renew.allowedFrom, "renew");
    assertLeaseOwner(node, { session, runId });

    const leaseDuration = leaseSeconds ?? graph.scheduler?.leaseSeconds ?? 1800;
    const now = new Date();
    node.lease.renewedAt = now.toISOString();
    node.lease.expiresAt = new Date(now.getTime() + leaseDuration * 1000).toISOString();
    appendHistory(node, operationalEvents.renewed, {
      status: node.status || "pending",
      session,
      runId,
      renewedAt: node.lease.renewedAt,
      leaseExpiresAt: node.lease.expiresAt
    });
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

    resetNodeState(node, operationalEvents.reset, {
      resetScope: "node",
      reason: reason || "manual_reset"
    });

    const resetAncestors: NodeId[] = [];
    for (const ancestorId of findAncestorIds(graph, nodeId)) {
      const ancestor = getNode(graph, ancestorId);
      if (ancestor.status === "done") {
        const previousStatus = ancestor.status;
        ancestor.status = "pending";
        delete ancestor.completedAt;
        const clearedFields = ["completedAt", ...clearCompositionRefMetadata(ancestor)];
        appendHistory(ancestor, operationalEvents.childReset, {
          previousStatus,
          status: ancestor.status,
          childId: nodeId,
          clearedFields
        });
        resetAncestors.push(ancestorId);
      }
    }
    reopenUnresolvedCompositionAncestors(graph, nodeId, {
      resetScope: "node",
      reason: reason || "manual_reset"
    });

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
      resetNodeState(getNode(graph, resetNodeId), operationalEvents.reset, {
        resetScope: "subtree",
        reason: reason || "manual_subtree_reset",
        rootId: nodeId
      });
    }
    reopenUnresolvedCompositionAncestors(graph, nodeId, {
      resetScope: "subtree",
      reason: reason || "manual_subtree_reset",
      rootId: nodeId
    });

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
      resetNodeState(getNode(graph, resetNodeId), operationalEvents.reset, {
        resetScope: "reachable",
        reason: reason || "manual_reachable_reset",
        rootId: nodeId
      });
    }
    reopenUnresolvedCompositionAncestors(graph, nodeId, {
      resetScope: "reachable",
      reason: reason || "manual_reachable_reset",
      rootId: nodeId
    });

    graph.graphVersion = (graph.graphVersion || 0) + 1;
    await writeGraphAtomic(graph, graphPath);
    return { nodeId, resetNodes, summary: summarizeGraph(graph) };
  });
}

export async function reconcileGraphStatus(graphPath = defaultGraphPath): Promise<ReconcileGraphResult> {
  return withGraphLock(graphPath, async () => {
    const graph = await readGraph(graphPath);
    const changed = await reconcileCompletedSubtrees(graph, graphPath);
    if (changed.length > 0) {
      graph.graphVersion = (graph.graphVersion || 0) + 1;
      await writeGraphAtomic(graph, graphPath);
    }
    return { changed, summary: summarizeGraph(graph) };
  });
}

export async function publishResolvedIntegration(
  graphPath = defaultGraphPath,
  { nodeId, report }: PublishResolvedIntegrationOptions = {}
): Promise<NodeMutationResult> {
  if (!nodeId) {
    throw new Error("publish-resolved-integration requires --node");
  }

  return withGraphLock(graphPath, async () => {
    const graph = await readGraph(graphPath);
    const node = getNode(graph, nodeId);
    if (!Array.isArray(node.children) || node.kind !== "parallel") {
      throw new Error("Cannot publish resolved integration for non-parallel node: " + nodeId);
    }
    if (!node.integrationRef?.name || node.integrationRef.kind !== "parallel") {
      throw new Error("Cannot publish resolved integration for " + nodeId + ": missing parallel integrationRef.name");
    }
    if (!node.integrationRef.workspace || typeof node.integrationRef.workspace !== "string") {
      throw new Error("Cannot publish resolved integration for " + nodeId + ": missing integration workspace");
    }

    const unresolvedPaths = conflictedGitPaths(node.integrationRef.workspace);
    if (unresolvedPaths.length > 0) {
      throw new Error("Cannot publish resolved integration for " + nodeId + ": unresolved conflicts remain in " + unresolvedPaths.join(", "));
    }
    const dirty = gitText(["-C", node.integrationRef.workspace, "status", "--porcelain"]).trim();
    if (dirty) {
      throw new Error("Cannot publish resolved integration for " + nodeId + ": integration workspace has uncommitted changes");
    }

    const outputRef = node.integrationRef.name;
    const commit = gitText(["-C", node.integrationRef.workspace, "rev-parse", "HEAD"]).trim();
    const previousStatus = node.status || "pending";
    const completedAt = new Date().toISOString();
    const reportPath = report || node.report;
    const clearedFields = clearCompositionBlockState(node);

    node.integrationRef = {
      ...node.integrationRef,
      status: "clean",
      commit,
      publishedOutputRef: outputRef,
      ...(reportPath ? { report: reportPath } : {})
    };
    node.outputRef = {
      name: outputRef,
      commit,
      runId: integrationRunId(outputRef),
      ...(reportPath ? { report: reportPath } : {}),
      producedAt: completedAt,
      source: "parallel-integration"
    };
    node.status = "done";
    node.completedAt = completedAt;
    if (reportPath) {
      node.report = reportPath;
    }
    const footprintDetails = await attachGitFootprintMetadata(graph, graphPath, nodeId, node, {
      now: completedAt,
      cloneCwd: typeof node.integrationRef.workspace === "string" ? node.integrationRef.workspace : undefined
    });
    applyAggregatedChildGitFootprint(graph, nodeId, node, completedAt);
    appendHistory(node, operationalEvents.parentRefPublished, {
      parentId: nodeId,
      kind: "parallel",
      integrationRef: outputRef,
      outputRef,
      commit,
      result: "manual-resolution",
      ...(reportPath ? { report: reportPath } : {}),
      ...(clearedFields.length > 0 ? { clearedFields } : {}),
      ...footprintDetails
    });
    appendHistory(node, operationalEvents.subtreeDone, {
      previousStatus,
      status: node.status,
      completedAt,
      childIds: node.children || []
    });

    await reconcileCompletedSubtrees(graph, graphPath);
    graph.graphVersion = (graph.graphVersion || 0) + 1;
    await writeGraphAtomic(graph, graphPath);
    return { nodeId, status: node.status, title: node.title, summary: summarizeGraph(graph) };
  });
}

export async function planNodeDecomposition(
  graphPath: string,
  { nodeId, planner, requestId, goal, allowedKinds, plannerMetadata }: PlanNodeDecompositionOptions
): Promise<PlannerRuntimeResponse> {
  if (!nodeId) {
    throw new Error("Missing node id");
  }

  const graph = await readGraph(graphPath);
  const node = getNode(graph, nodeId);
  if (!isLeaf(graph, nodeId)) {
    throw new Error(`Cannot plan decomposition for non-leaf node: ${nodeId}`);
  }
  const request = buildPlannerRuntimeRequest(graph, nodeId, {
    requestId,
    goal,
    allowedKinds,
    planner: plannerMetadata || node.planner
  });
  const result = await planner.plan(request);
  const decompose = plannerResponseToDecomposeMutation(result.response, graph, nodeId, {
    allowedKinds: request.allowedKinds
  });
  return sanitizePublicPlannerResult({
    ...result,
    validation: result.validation || { valid: true, errors: [] },
    ...(decompose ? { decompose } : {})
  });
}

function sanitizePublicPlannerResult(result: PlannerRuntimeResponse): PlannerRuntimeResponse {
  const { rawText: _rawText, prompt: _prompt, ...safeResult } = result;
  return redactOperationalEventDetails(safeResult as Record<string, unknown>) as unknown as PlannerRuntimeResponse;
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
    assertStatus(node, schedulerTransitionTable.decompose.allowedFrom, "decompose");
    assertLeaseOwner(node, { session, runId });

    const normalizedChildren = normalizeChildDefinitions(children);
    assertFreshPendingPlannerPreview(graph, nodeId, node, kind || "series", normalizedChildren);
    for (const child of normalizedChildren) {
      if (graph.graph.nodes[child.id]) {
        throw new Error(`Child node already exists: ${child.id}`);
      }
    }

    const previousStatus = node.status || "pending";
    const previousKind = node.kind;
    node.kind = kind || "series";
    node.status = "pending";
    node.children = normalizedChildren.map((child) => child.id);
    delete node.lease;
    delete node.startedAt;
    delete node.blockedAt;
    delete node.blockedReason;
    delete node.question;
    delete node.pendingPlannerPreview;
    appendHistory(node, operationalEvents.decomposed, {
      previousStatus,
      status: node.status,
      previousKind,
      kind: node.kind,
      childIds: node.children,
      session,
      runId,
      clearedFields: ["lease", "startedAt", "blockedAt", "blockedReason", "question", "pendingPlannerPreview"]
    });

    for (const child of normalizedChildren) {
      const { id: _id, ...childNode } = child;
      graph.graph.nodes[child.id] = {
        ...childNode
      };
      if (!graph.graph.nodes[child.id].children) {
        delete graph.graph.nodes[child.id].children;
      }
    }

    assertValidGraphAfterMutation(graph);
    await reconcileCompletedSubtrees(graph, graphPath);
    graph.graphVersion = (graph.graphVersion || 0) + 1;
    await writeGraphAtomic(graph, graphPath);
    return { nodeId, children: node.children, summary: summarizeGraph(graph) };
  });
}

async function updateNodeStatus(
  graphPath: string,
  { nodeId, status, owner, validate, patch, extraHistoryEvents }: UpdateNodeStatusOptions
): Promise<NodeMutationResult> {
  if (!nodeId) {
    throw new Error("Missing node id");
  }

  return withGraphLock(graphPath, async () => {
    const graph = await readGraph(graphPath);
    const node = getNode(graph, nodeId);
    validate?.(graph, node);
    assertLeaseOwner(node, owner);
    const previousStatus = node.status || "pending";
    node.status = status;
    const patchDetails = await patch?.(node, graph) || {};
    appendHistory(node, mutationEventForStatus(status), {
      previousStatus,
      status,
      session: owner?.session,
      runId: owner?.runId,
      ...patchDetails
    });
    for (const extraEvent of extraHistoryEvents || []) {
      appendHistory(node, extraEvent.event, {
        previousStatus,
        status,
        session: owner?.session,
        runId: owner?.runId,
        ...extraEvent.details
      });
    }
    await reconcileCompletedSubtrees(graph, graphPath);
    graph.graphVersion = (graph.graphVersion || 0) + 1;
    await writeGraphAtomic(graph, graphPath);
    return { nodeId, status, title: node.title, summary: summarizeGraph(graph) };
  });
}

async function reconcileCompletedSubtrees(graph: PlanGraphFile, graphPath: string): Promise<NodeId[]> {
  const changed: NodeId[] = [];
  const rootId = graph.graph?.root;
  if (!rootId) {
    return changed;
  }

  async function visit(nodeId: NodeId, stack: NodeId[] = []): Promise<boolean> {
    if (stack.includes(nodeId)) {
      throw new Error(`Cycle detected in graph: ${[...stack, nodeId].join(" -> ")}`);
    }

    const node = getNode(graph, nodeId);
    if (isLeaf(graph, nodeId)) {
      return terminalStatuses.has(node.status ?? "pending");
    }

    const childResults: boolean[] = [];
    for (const childId of node.children || []) {
      childResults.push(await visit(childId, [...stack, nodeId]));
    }
    const childrenDone = childResults.every(Boolean);
    if (childrenDone && node.status !== "done") {
      if (node.kind === "parallel") {
        const publishResult = await publishParallelIntegrationIfRequired(graph, graphPath, nodeId, node);
        if (publishResult === "unresolved") {
          changed.push(nodeId);
          return false;
        }
        if (publishResult === "parked") {
          return false;
        }
      } else if (node.kind === "series") {
        const publishResult = await publishSeriesAliasIfRequired(graph, graphPath, nodeId, node);
        if (publishResult === "unresolved") {
          changed.push(nodeId);
          return false;
        }
        if (publishResult === "parked") {
          return false;
        }
      }
      const previousStatus = node.status || "pending";
      const completedAt = new Date().toISOString();
      applyAggregatedChildGitFootprint(graph, nodeId, node, completedAt);
      node.status = "done";
      node.completedAt ||= completedAt;
      appendHistory(node, operationalEvents.subtreeDone, {
        previousStatus,
        status: node.status,
        completedAt: node.completedAt,
        childIds: node.children || []
      });
      changed.push(nodeId);
    }
    return childrenDone && terminalStatuses.has(node.status ?? "pending");
  }

  await visit(rootId);
  return changed;
}

type ParallelIntegrationPublishResult = "not-required" | "published" | "unresolved" | "parked";

interface ParallelChildOutput {
  nodeId: NodeId;
  outputRef: string;
  commit?: string;
}

interface GitCommandErrorDetails {
  message: string;
  stdout?: string;
  stderr?: string;
}

type SeriesAliasPublishResult = "not-required" | "published" | "unresolved" | "parked";

async function publishSeriesAliasIfRequired(
  graph: PlanGraphFile,
  graphPath: string,
  parentId: NodeId,
  node: GraphNode
): Promise<SeriesAliasPublishResult> {
  if (isUnresolvedCompositionBuffer(node, "series")) {
    return "parked";
  }

  const finalChildId = node.children?.at(-1);
  if (!finalChildId) {
    return "not-required";
  }

  const children = node.children || [];
  const childOutputs = children.map((childId) => {
    const childOutput = getNode(graph, childId).outputRef;
    return childOutput?.name
      ? { nodeId: childId, outputRef: childOutput.name, commit: childOutput.commit }
      : undefined;
  });
  const finalOutput = getNode(graph, finalChildId).outputRef;
  const hasIsolationMetadata = Boolean(
    node.baseRef?.name
      || node.integrationRef?.name
      || node.outputRef?.name
      || finalOutput?.name
      || childOutputs.some(Boolean)
  );
  if (!hasIsolationMetadata || !finalOutput?.name) {
    if (hasIsolationMetadata) {
      await blockSeriesAlias(graphPath, parentId, node, {
        reason: `series final child is done without outputRef: ${finalChildId}`,
        childOutputs: childOutputs.filter(Boolean) as ParallelChildOutput[],
        missingChildId: finalChildId
      });
      return "unresolved";
    }
    return "not-required";
  }

  const missingChildId = children[childOutputs.findIndex((childOutput) => !childOutput)];
  if (missingChildId) {
    await blockSeriesAlias(graphPath, parentId, node, {
      reason: `series child is done without outputRef: ${missingChildId}`,
      childOutputs: childOutputs.filter(Boolean) as ParallelChildOutput[],
      missingChildId
    });
    return "unresolved";
  }

  const orderedChildOutputs = childOutputs as ParallelChildOutput[];
  const alreadyPublished = node.outputRef?.name === finalOutput.name
    && node.outputRef?.commit === finalOutput.commit
    && node.integrationRef?.kind === "series"
    && node.integrationRef?.status === "clean"
    && node.integrationRef?.publishedOutputRef === finalOutput.name;
  if (alreadyPublished) {
    return "not-required";
  }

  const publishedAt = new Date().toISOString();
  node.integrationRef = {
    ...(node.integrationRef || {}),
    name: finalOutput.name,
    kind: "series",
    status: "clean",
    inputRefs: integrationInputRefs(orderedChildOutputs),
    publishedOutputRef: finalOutput.name,
    commit: finalOutput.commit,
    finalChildId,
    source: "final-child-outputRef"
  };
  node.outputRef = {
    ...node.outputRef,
    name: finalOutput.name,
    commit: finalOutput.commit,
    runId: finalOutput.runId,
    session: finalOutput.session,
    report: finalOutput.report,
    producedAt: publishedAt,
    source: "series-alias",
    aliasOfNodeId: finalChildId
  };
  const footprintDetails = await attachGitFootprintMetadata(graph, graphPath, parentId, node, {
    now: publishedAt,
    bareRepoPath: parallelBareRepoPath(graphPath)
  });
  applyAggregatedChildGitFootprint(graph, parentId, node, publishedAt);
  appendHistory(node, operationalEvents.parentRefPublished, {
    parentId,
    kind: "series",
    integrationRef: finalOutput.name,
    outputRef: finalOutput.name,
    commit: finalOutput.commit,
    result: "clean",
    finalChildId,
    childOutputRef: finalOutput.name,
    ...footprintDetails
  });
  return "published";
}

async function publishParallelIntegrationIfRequired(
  graph: PlanGraphFile,
  graphPath: string,
  parentId: NodeId,
  node: GraphNode
): Promise<ParallelIntegrationPublishResult> {
  if (isUnresolvedCompositionBuffer(node, "parallel")) {
    return "parked";
  }

  const children = node.children || [];
  const childOutputs = children.map((childId) => {
    const childNode = getNode(graph, childId);
    return childNode.outputRef?.name
      ? { nodeId: childId, outputRef: childNode.outputRef.name, commit: childNode.outputRef.commit }
      : undefined;
  });
  const hasIsolationMetadata = Boolean(node.baseRef?.name || node.integrationRef?.name || childOutputs.some(Boolean));
  if (!hasIsolationMetadata || node.outputRef?.name) {
    return "not-required";
  }

  const missingChildId = children[childOutputs.findIndex((childOutput) => !childOutput)];
  if (missingChildId) {
    await blockParallelIntegration(graphPath, parentId, node, {
      reason: `parallel child is done without outputRef: ${missingChildId}`,
      childOutputs: childOutputs.filter(Boolean) as ParallelChildOutput[],
      missingChildId
    });
    return "unresolved";
  }

  const reportAttemptId = createIntegrationAttemptId(parentId);
  const integrationBranch = `spg/integration/${safeGitRefPart(parentId)}/${reportAttemptId}`;
  const integrationRef = `refs/heads/${integrationBranch}`;
  const bareRepo = parallelBareRepoPath(graphPath);
  const workspace = join(dirname(graphPath), "runs", "workspaces", "integration", safeFilePart(parentId), reportAttemptId);
  const orderedChildOutputs = childOutputs as ParallelChildOutput[];

  let baseRefMetadata: NodeBaseRefMetadata;
  try {
    baseRefMetadata = parallelBaseRefMetadata(graph, parentId);
  } catch (error) {
    await blockParallelIntegration(graphPath, parentId, node, {
      reason: `parallel parent base ref resolution failed: ${errorMessage(error)}`,
      childOutputs: orderedChildOutputs,
      integrationRef
    });
    return "unresolved";
  }
  const baseRef = baseRefMetadata.name;

  let baseCommit = "";
  try {
    assertBareRepository(bareRepo);
    baseCommit = gitText(["--git-dir", bareRepo, "rev-parse", "--verify", `${baseRef}^{commit}`]).trim();
    for (const childOutput of orderedChildOutputs) {
      gitText(["--git-dir", bareRepo, "rev-parse", "--verify", `${childOutput.outputRef}^{commit}`]);
    }
    await mkdir(dirname(workspace), { recursive: true });
    gitText(["--git-dir", bareRepo, "worktree", "add", "-b", integrationBranch, workspace, baseRef]);
    gitText(["-C", workspace, "config", "user.name", "Series Parallel Graph Scheduler"]);
    gitText(["-C", workspace, "config", "user.email", "spg-scheduler@example.invalid"]);
  } catch (error) {
    await blockParallelIntegration(graphPath, parentId, node, {
      reason: `parallel integration setup failed: ${errorMessage(error)}`,
      childOutputs: orderedChildOutputs,
      integrationRef,
      bareRepo,
      baseRef,
      workspace,
      gitError: gitCommandErrorDetails(error)
    });
    return "unresolved";
  }

  node.baseRef = {
    ...baseRefMetadata,
    name: baseRef,
    commit: baseCommit,
    resolvedAt: new Date().toISOString()
  };
  node.integrationRef = {
    name: integrationRef,
    kind: "parallel",
    status: "pending",
    baseRef,
    workspace,
    inputRefs: integrationInputRefs(orderedChildOutputs)
  };

  for (const [childOrderIndex, childOutput] of orderedChildOutputs.entries()) {
    appendHistory(node, operationalEvents.mergeAttempted, {
      parentId,
      integrationRef,
      baseRef,
      childId: childOutput.nodeId,
      childOutputRef: childOutput.outputRef,
      childOrderIndex
    });

    try {
      gitText(["-C", workspace, "merge", "--no-ff", "--no-edit", childOutput.outputRef]);
    } catch (error) {
      const conflictedPaths = conflictedGitPaths(workspace);
      const reportPath = parallelIntegrationReportPath(parentId, reportAttemptId);
      await writeReportFile(graphPath, reportPath, formatParallelIntegrationReport({
        parentId,
        result: "review",
        bareRepo,
        workspace,
        baseRef,
        integrationRef,
        childOutputs: orderedChildOutputs,
        failedChild: childOutput,
        childOrderIndex,
        conflictedPaths,
        gitError: gitCommandErrorDetails(error)
      }));

      const previousStatus = node.status || "pending";
      node.status = "review";
      node.report = reportPath;
      node.blockedAt = new Date().toISOString();
      node.blockedReason = "parallel merge conflict";
      node.integrationRef = {
        ...node.integrationRef,
        status: "conflicted",
        conflictedChildId: childOutput.nodeId,
        conflictedChildOutputRef: childOutput.outputRef,
        conflictedChildOrderIndex: childOrderIndex,
        conflictedPaths,
        report: reportPath
      };
      appendHistory(node, operationalEvents.mergeConflicted, {
        previousStatus,
        status: node.status,
        parentId,
        integrationRef,
        baseRef,
        childId: childOutput.nodeId,
        childOutputRef: childOutput.outputRef,
        childOrderIndex,
        conflictedPaths,
        result: "review",
        report: reportPath,
        workspace
      });
      return "unresolved";
    }
  }

  const commit = gitText(["-C", workspace, "rev-parse", "HEAD"]).trim();
  const reportPath = parallelIntegrationReportPath(parentId, reportAttemptId);
  const producedAt = new Date().toISOString();
  node.integrationRef = {
    ...node.integrationRef,
    status: "clean",
    commit,
    publishedOutputRef: integrationRef,
    report: reportPath
  };
  node.outputRef = {
    name: integrationRef,
    commit,
    runId: reportAttemptId,
    report: reportPath,
    producedAt,
    source: "parallel-integration"
  };
  const footprintDetails = await attachGitFootprintMetadata(graph, graphPath, parentId, node, {
    now: producedAt,
    cloneCwd: workspace,
    bareRepoPath: bareRepo
  });
  const clearedFields = clearCompositionBlockState(node);
  applyAggregatedChildGitFootprint(graph, parentId, node, producedAt);
  await writeReportFile(graphPath, reportPath, formatParallelIntegrationReport({
    parentId,
    result: "clean",
    bareRepo,
    workspace,
    baseRef,
    integrationRef,
    outputRef: integrationRef,
    commit,
    childOutputs: orderedChildOutputs
  }));
  node.report = reportPath;
  appendHistory(node, operationalEvents.parentRefPublished, {
    parentId,
    kind: "parallel",
    integrationRef,
    outputRef: integrationRef,
    commit,
    result: "clean",
    report: reportPath,
    ...(clearedFields.length > 0 ? { clearedFields } : {}),
    ...footprintDetails
  });
  return "published";
}

async function blockSeriesAlias(
  graphPath: string,
  parentId: NodeId,
  node: GraphNode,
  {
    reason,
    childOutputs,
    missingChildId
  }: {
    reason: string;
    childOutputs: ParallelChildOutput[];
    missingChildId: NodeId;
  }
): Promise<void> {
  const previousStatus = node.status || "pending";
  const attemptId = createIntegrationAttemptId(parentId);
  const reportPath = parallelIntegrationReportPath(parentId, attemptId);
  await writeReportFile(graphPath, reportPath, formatSeriesAliasReport({
    parentId,
    result: "blocked",
    childOutputs,
    missingChildId
  }));
  node.status = "blocked";
  node.blockedAt = new Date().toISOString();
  node.blockedReason = reason;
  node.question = `Resolve series integration for ${parentId}; see ${reportPath}.`;
  node.report = reportPath;
  node.integrationRef = {
    ...(node.integrationRef || {}),
    name: childOutputs.at(-1)?.outputRef || `refs/heads/spg/integration/${safeGitRefPart(parentId)}/${attemptId}`,
    kind: "series",
    status: "pending",
    inputRefs: integrationInputRefs(childOutputs),
    report: reportPath,
    missingChildId
  };
  appendHistory(node, operationalEvents.blocked, {
    previousStatus,
    status: node.status,
    parentId,
    blockedReason: reason,
    report: reportPath,
    integrationRef: node.integrationRef.name,
    missingChildId,
    childOutputRefs: childOutputs.map((childOutput) => ({
      nodeId: childOutput.nodeId,
      outputRef: childOutput.outputRef
    }))
  });
}

function isUnresolvedCompositionBuffer(node: GraphNode, kind: "series" | "parallel"): boolean {
  const status = node.status || "pending";
  const parked = status === "review" || status === "failed" || (status === "blocked" && !isRetryableCompositionBlock(node, kind));
  return parked && node.integrationRef?.kind === kind && !node.outputRef?.name;
}

function isRetryableCompositionBlock(node: GraphNode, kind: "series" | "parallel"): boolean {
  return kind === "parallel" && node.blockedReason === "parallel parent is missing baseRef.name";
}

function clearCompositionBlockState(node: GraphNode): string[] {
  const clearedFields: string[] = [];
  for (const field of ["blockedAt", "blockedReason", "question"] as const) {
    if (node[field] !== undefined) {
      delete node[field];
      clearedFields.push(field);
    }
  }
  return clearedFields;
}

async function blockParallelIntegration(
  graphPath: string,
  parentId: NodeId,
  node: GraphNode,
  {
    reason,
    childOutputs,
    missingChildId,
    integrationRef,
    bareRepo,
    baseRef,
    workspace,
    gitError
  }: {
    reason: string;
    childOutputs: ParallelChildOutput[];
    missingChildId?: NodeId;
    integrationRef?: string;
    bareRepo?: string;
    baseRef?: string;
    workspace?: string;
    gitError?: GitCommandErrorDetails;
  }
): Promise<void> {
  const previousStatus = node.status || "pending";
  const attemptId = createIntegrationAttemptId(parentId);
  const effectiveIntegrationRef = integrationRef || node.integrationRef?.name || `refs/heads/spg/integration/${safeGitRefPart(parentId)}/${attemptId}`;
  const reportPath = parallelIntegrationReportPath(parentId, attemptId);
  await writeReportFile(graphPath, reportPath, formatParallelIntegrationReport({
    parentId,
    result: "blocked",
    bareRepo,
    workspace,
    baseRef,
    integrationRef: effectiveIntegrationRef,
    childOutputs,
    missingChildId,
    gitError
  }));
  node.status = "blocked";
  node.blockedAt = new Date().toISOString();
  node.blockedReason = reason;
  node.question = `Resolve parallel integration for ${parentId}; see ${reportPath}.`;
  node.report = reportPath;
  node.integrationRef = {
    ...(node.integrationRef || {}),
    name: effectiveIntegrationRef,
    kind: "parallel",
    status: "pending",
    inputRefs: integrationInputRefs(childOutputs),
    report: reportPath,
    baseRef,
    workspace,
    missingChildId
  };
  appendHistory(node, operationalEvents.blocked, {
    previousStatus,
    status: node.status,
    parentId,
    blockedReason: reason,
    report: reportPath,
    integrationRef: effectiveIntegrationRef,
    baseRef,
    workspace,
    missingChildId,
    childOutputRefs: childOutputs.map((childOutput) => ({
      nodeId: childOutput.nodeId,
      outputRef: childOutput.outputRef
    }))
  });
}

function parallelBaseRefMetadata(graph: PlanGraphFile, parentId: NodeId): NodeBaseRefMetadata {
  return resolveNodeBaseRef(graph, parentId);
}

function parallelBareRepoPath(graphPath: string): string {
  return join(dirname(graphPath), "runs", "git", "cache", "repo.git");
}

function createIntegrationAttemptId(parentId: NodeId): string {
  const timestamp = new Date().toISOString().replaceAll(/[-:.]/g, "").replace("T", "_").replace("Z", "");
  return `run_${timestamp}_${safeGitRefPart(parentId)}_${randomUUID().slice(0, 8)}`;
}

function safeGitRefPart(value: unknown): string {
  return safeFilePart(value).replaceAll(/\.+/g, ".").replaceAll(/^\.|\.$/g, "") || "ref";
}

function integrationRunId(refName: string): string | undefined {
  return refName.split("/").filter(Boolean).at(-1);
}

function parallelIntegrationReportPath(parentId: NodeId, attemptId: string): string {
  return `reports/${safeFilePart(parentId)}-${safeFilePart(attemptId)}-integration.md`;
}

function integrationInputRefs(childOutputs: ParallelChildOutput[]): NodeIntegrationInputRefMetadata[] {
  return childOutputs.map((childOutput, childOrderIndex) => ({
    nodeId: childOutput.nodeId,
    outputRef: childOutput.outputRef,
    childOrderIndex,
    commit: childOutput.commit
  }));
}

function assertBareRepository(bareRepo: string): void {
  const result = gitText(["--git-dir", bareRepo, "rev-parse", "--is-bare-repository"]).trim();
  if (result !== "true") {
    throw new Error(`Git cache is not a bare repository: ${bareRepo}`);
  }
}

function gitText(args: string[]): string {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function conflictedGitPaths(workspace: string): string[] {
  try {
    return gitText(["-C", workspace, "diff", "--name-only", "--diff-filter=U"])
      .split(/\r?\n/)
      .map((path) => path.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function gitCommandErrorDetails(error: unknown): GitCommandErrorDetails {
  const processError = error as { stdout?: Buffer | string; stderr?: Buffer | string };
  return {
    message: errorMessage(error),
    stdout: processError.stdout ? String(processError.stdout).trim() : undefined,
    stderr: processError.stderr ? String(processError.stderr).trim() : undefined
  };
}

function formatParallelIntegrationReport({
  parentId,
  result,
  bareRepo,
  workspace,
  baseRef,
  integrationRef,
  outputRef,
  commit,
  childOutputs,
  failedChild,
  missingChildId,
  childOrderIndex,
  conflictedPaths,
  gitError
}: {
  parentId: NodeId;
  result: "clean" | "blocked" | "review";
  bareRepo?: string;
  workspace?: string;
  baseRef?: string;
  integrationRef?: string;
  outputRef?: string;
  commit?: string;
  childOutputs: ParallelChildOutput[];
  failedChild?: ParallelChildOutput;
  missingChildId?: NodeId;
  childOrderIndex?: number;
  conflictedPaths?: string[];
  gitError?: GitCommandErrorDetails;
}): string {
  const lines = [
    `# Parallel integration: ${parentId}`,
    "",
    `- Parent: ${parentId}`,
    `- Result: ${result}`,
    `- Bare repository: ${bareRepo || "unknown"}`,
    `- Workspace: ${workspace || "none"}`,
    `- Base ref: ${baseRef || "unknown"}`,
    `- Integration ref: ${integrationRef || "none"}`,
    `- Output ref: ${outputRef || "none"}`,
    `- Commit: ${commit || "unknown"}`,
    "",
    "## Child refs",
    ""
  ];

  if (childOutputs.length === 0) {
    lines.push("- none");
  } else {
    for (const [index, childOutput] of childOutputs.entries()) {
      lines.push(`- ${index}: ${childOutput.nodeId} -> ${childOutput.outputRef}${childOutput.commit ? ` (${childOutput.commit})` : ""}`);
    }
  }

  if (missingChildId) {
    lines.push("", "## Missing output ref", "", `- Child: ${missingChildId}`);
  }
  if (failedChild) {
    lines.push(
      "",
      "## Failed merge",
      "",
      `- Child order index: ${childOrderIndex ?? "unknown"}`,
      `- Child: ${failedChild.nodeId}`,
      `- Child output ref: ${failedChild.outputRef}`
    );
  }
  if (conflictedPaths) {
    lines.push("", "## Conflicted paths", "");
    lines.push(...(conflictedPaths.length > 0 ? conflictedPaths.map((path) => `- ${path}`) : ["- none reported by Git"]));
  }
  if (gitError) {
    lines.push("", "## Git error", "", "```", gitError.message);
    if (gitError.stderr) {
      lines.push("", gitError.stderr);
    }
    if (gitError.stdout) {
      lines.push("", gitError.stdout);
    }
    lines.push("```");
  }

  return lines.join("\n");
}

function formatSeriesAliasReport({
  parentId,
  result,
  childOutputs,
  missingChildId
}: {
  parentId: NodeId;
  result: "blocked";
  childOutputs: ParallelChildOutput[];
  missingChildId: NodeId;
}): string {
  const lines = [
    `# Series integration: ${parentId}`,
    "",
    `- Parent: ${parentId}`,
    `- Result: ${result}`,
    `- Missing child output ref: ${missingChildId}`,
    "",
    "## Child refs",
    ""
  ];

  if (childOutputs.length === 0) {
    lines.push("- none");
  } else {
    for (const [index, childOutput] of childOutputs.entries()) {
      lines.push(`- ${index}: ${childOutput.nodeId} -> ${childOutput.outputRef}${childOutput.commit ? ` (${childOutput.commit})` : ""}`);
    }
  }

  return lines.join("\n");
}

function releaseExpiredLeasesInGraph(graph: PlanGraphFile, now = new Date()): NodeId[] {
  const released: NodeId[] = [];
  const nowMs = now.getTime();

  for (const [nodeId, node] of Object.entries(graph.graph?.nodes || {})) {
    if (!node.lease?.expiresAt || !releaseExpiredAllowedStatuses.has(node.status || "pending")) {
      continue;
    }

    const expiresAtMs = new Date(node.lease.expiresAt).getTime();
    if (!Number.isFinite(expiresAtMs) || expiresAtMs > nowMs) {
      continue;
    }

    released.push(nodeId);
    appendHistory(node, operationalEvents.expired, {
      previousStatus: node.status,
      status: "pending",
      session: node.lease.session,
      runId: node.lease.runId,
      leaseExpiresAt: node.lease.expiresAt,
      expiredAt: now.toISOString(),
      clearedFields: ["lease", "startedAt"]
    });
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

function resetNodeState(node: GraphNode, event: OperationalEventName, metadata: Record<string, unknown> = {}): void {
  const previousStatus = node.status || "pending";
  node.status = "pending";
  for (const field of resetClearedFields) {
    delete node[field];
  }
  const clearedFields = [...resetClearedFields, ...clearCompositionRefMetadata(node)];
  appendHistory(node, event, {
    previousStatus,
    status: node.status,
    clearedFields,
    ...metadata
  });
}

function clearCompositionRefMetadata(node: GraphNode): string[] {
  if (!Array.isArray(node.children) || node.children.length === 0) {
    return [];
  }

  const clearedFields: string[] = [];
  for (const field of compositionResetClearedFields) {
    if (node[field]) {
      delete node[field];
      clearedFields.push(field);
    }
  }
  return clearedFields;
}

function reopenUnresolvedCompositionAncestors(
  graph: PlanGraphFile,
  nodeId: NodeId,
  metadata: { resetScope: string; reason: string; rootId?: NodeId }
): NodeId[] {
  const reopened: NodeId[] = [];
  for (const ancestorId of findAncestorIds(graph, nodeId)) {
    const ancestor = getNode(graph, ancestorId);
    if (!isUnresolvedCompositionBuffer(ancestor, ancestor.kind === "parallel" ? "parallel" : "series")) {
      continue;
    }

    const previousStatus = ancestor.status || "pending";
    ancestor.status = "pending";
    for (const field of resetClearedFields) {
      delete ancestor[field];
    }
    const clearedFields = [...resetClearedFields, ...clearCompositionRefMetadata(ancestor)];
    appendHistory(ancestor, operationalEvents.childReset, {
      previousStatus,
      status: ancestor.status,
      childId: nodeId,
      clearedFields,
      ...metadata
    });
    reopened.push(ancestorId);
  }
  return reopened;
}

interface GitFootprintHistoryDetails {
  diffStatCollected?: boolean;
  diffStat?: GitDiffStatMetadata;
  gitFootprintCollectedAt?: string;
  gitFootprintWarning?: string;
}

async function attachGitFootprintMetadata(
  graph: PlanGraphFile,
  graphPath: string,
  nodeId: NodeId,
  node: GraphNode,
  {
    now,
    cloneCwd,
    bareRepoPath
  }: {
    now: string;
    cloneCwd?: string;
    bareRepoPath?: string;
  }
): Promise<GitFootprintHistoryDetails> {
  if (!node.outputRef?.name) {
    return {};
  }

  if (node.outputRef.diffStat && node.gitFootprint?.diffStat) {
    return {
      diffStatCollected: true,
      diffStat: node.outputRef.diffStat,
      gitFootprintCollectedAt: node.outputRef.collectedAt || node.gitFootprint.collectedAt
    };
  }

  const baseRef = ensureNodeBaseRef(graph, nodeId, node, now);
  if (!baseRef?.name) {
    return recordGitFootprintWarning(node, `Git diffstat omitted: missing baseRef.name for ${nodeId}`);
  }

  const effectiveCloneCwd = cloneCwd || node.workspace?.cloneCwd;
  const effectiveBareRepoPath = bareRepoPath || node.workspace?.bareRepo;
  if (!effectiveCloneCwd && !effectiveBareRepoPath) {
    return recordGitFootprintWarning(node, `Git diffstat omitted: missing cloneCwd or bareRepo for ${nodeId}`);
  }

  try {
    const collected = await collectGitDiffStat({
      cloneCwd: effectiveCloneCwd,
      bareRepoPath: effectiveCloneCwd ? undefined : effectiveBareRepoPath,
      baseRef: baseRef.commit || baseRef.name,
      baseRefName: baseRef.name,
      headRef: node.outputRef.commit || node.outputRef.name,
      headRefName: node.outputRef.name,
      collectedAt: now
    });
    if (!collected.ok) {
      return recordGitFootprintWarning(node, collected.warning);
    }

    node.gitFootprint = mergeDefined(node.gitFootprint, collected.footprint);
    node.outputRef = mergeDefined(node.outputRef, {
      commit: node.outputRef.commit || collected.footprint.headRef?.commit,
      diffStat: collected.diffStat,
      files: collected.files,
      collectedAt: collected.footprint.collectedAt
    });
    delete node.gitFootprintWarning;
    return {
      diffStatCollected: true,
      diffStat: collected.diffStat,
      gitFootprintCollectedAt: collected.footprint.collectedAt
    };
  } catch (error) {
    return recordGitFootprintWarning(node, `Git diffstat collection failed: ${errorMessage(error)}`);
  }
}

function ensureNodeBaseRef(
  graph: PlanGraphFile,
  nodeId: NodeId,
  node: GraphNode,
  now: string
): NodeBaseRefMetadata | undefined {
  if (node.baseRef?.name) {
    return node.baseRef;
  }

  try {
    const resolved = resolveNodeBaseRef(graph, nodeId);
    node.baseRef = {
      ...node.baseRef,
      ...resolved,
      resolvedAt: now
    };
    return node.baseRef;
  } catch {
    return undefined;
  }
}

function recordGitFootprintWarning(node: GraphNode, warning: string): GitFootprintHistoryDetails {
  node.gitFootprintWarning = warning;
  return {
    diffStatCollected: false,
    gitFootprintWarning: warning
  };
}

function applyWorkerRefMetadata(
  node: GraphNode,
  refMetadata: WorkerRunRefMetadata | undefined,
  { session, runId, report, now }: { session?: string; runId?: string; report?: string; now: string }
): void {
  if (!refMetadata) {
    return;
  }

  const remote = redactedRemote(refMetadata.remote);
  const workspace = buildWorkspaceMetadata(refMetadata, { remote, session, runId, now });
  if (workspace) {
    node.workspace = mergeDefined(node.workspace, workspace) as NodeWorkspaceMetadata;
  }
  if (refMetadata.baseRef) {
    node.baseRef = mergeDefined(node.baseRef, refMetadata.baseRef);
  }
  if (refMetadata.workRef) {
    node.workRef = mergeDefined(node.workRef, {
      runId,
      session,
      createdAt: now,
      ...refMetadata.workRef
    });
  }
  if (refMetadata.outputRef) {
    node.outputRef = mergeDefined(node.outputRef, {
      runId,
      session,
      report,
      producedAt: now,
      ...refMetadata.outputRef
    });
  }
  if (refMetadata.gitFootprint) {
    node.gitFootprint = mergeDefined(node.gitFootprint, refMetadata.gitFootprint);
  }
  if (refMetadata.gitFootprintWarning) {
    node.gitFootprintWarning = refMetadata.gitFootprintWarning;
  }

  if (workspace) {
    appendHistory(node, operationalEvents.clonePrepared, {
      session,
      runId,
      remote,
      bareRepo: workspace.bareRepo,
      cloneCwd: workspace.cloneCwd,
      baseRef: node.baseRef?.name
    });
  }
  if (refMetadata.workRef) {
    appendHistory(node, operationalEvents.branchCreated, {
      session,
      runId,
      cloneCwd: node.workspace?.cloneCwd,
      baseRef: node.baseRef?.name,
      workRef: node.workRef?.name
    });
  }
  if (refMetadata.outputRef) {
    const gitFootprint = gitFootprintFromNode(node);
    appendHistory(node, operationalEvents.outputRefRecorded, {
      session,
      runId,
      workRef: node.workRef?.name,
      outputRef: node.outputRef?.name,
      commit: node.outputRef?.commit,
      report,
      diffStat: gitFootprint?.diffStat,
      files: gitFootprint?.files,
      gitFootprint,
      ...outputRefFootprintHistoryDetails(node)
    });
  }
}

function outputRefFootprintHistoryDetails(node: GraphNode): GitFootprintHistoryDetails {
  if (node.outputRef?.diffStat) {
    return {
      diffStatCollected: true,
      diffStat: node.outputRef.diffStat,
      gitFootprintCollectedAt: node.outputRef.collectedAt || node.gitFootprint?.collectedAt
    };
  }
  if (node.gitFootprintWarning) {
    return {
      diffStatCollected: false,
      gitFootprintWarning: node.gitFootprintWarning
    };
  }
  return {};
}

function buildWorkspaceMetadata(
  refMetadata: WorkerRunRefMetadata,
  { remote, session, runId, now }: { remote?: string; session?: string; runId?: string; now: string }
): Partial<NodeWorkspaceMetadata> | undefined {
  if (!refMetadata.cloneCwd) {
    return undefined;
  }
  return {
    remote,
    bareRepo: refMetadata.bareRepo,
    cloneCwd: refMetadata.cloneCwd,
    runId,
    session,
    preparedAt: now,
    retained: refMetadata.retained
  };
}

function mergeDefined<T extends Record<string, unknown>>(previous: T | undefined, next: Partial<T>): T {
  return {
    ...(previous || {}),
    ...omitUndefined(next as Record<string, unknown>)
  } as T;
}

function redactedRemote(remote: unknown): string | undefined {
  if (typeof remote !== "string") {
    return undefined;
  }
  const redacted = redactOperationalEventDetails({ remote }).remote;
  return typeof redacted === "string" ? redacted : remote;
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

function assertOutputRefWhenIsolationRequired(
  graph: PlanGraphFile,
  nodeId: NodeId,
  node: GraphNode,
  refMetadata: WorkerRunRefMetadata | undefined
): void {
  if (refMetadata?.outputRef?.name || node.outputRef?.name) {
    return;
  }
  if (!completionRequiresOutputRef(graph, nodeId, node)) {
    return;
  }
  throw new Error(`Cannot complete isolated/composed node without outputRef.name: ${nodeId}`);
}

function completionRequiresOutputRef(graph: PlanGraphFile, nodeId: NodeId, node: GraphNode): boolean {
  if (
    node.baseRef?.name
      || node.workRef?.name
      || node.workspace?.cloneCwd
      || node.workspace?.bareRepo
      || node.integrationRef?.name
  ) {
    return true;
  }

  for (const ancestorId of findAncestorIds(graph, nodeId)) {
    const ancestor = getNode(graph, ancestorId);
    if (
      ancestor.baseRef?.name
        || ancestor.outputRef?.name
        || ancestor.integrationRef?.name
        || ancestor.children?.some((childId) => getNode(graph, childId).outputRef?.name)
    ) {
      return true;
    }
  }
  return false;
}

function applyAggregatedChildGitFootprint(
  graph: PlanGraphFile,
  parentId: NodeId,
  node: GraphNode,
  collectedAt: string
): void {
  const aggregate = aggregateChildGitFootprints({
    parentId,
    parentKind: node.kind,
    children: (node.children || []).map((childId) => {
      const child = getNode(graph, childId);
      return {
        nodeId: childId,
        gitFootprint: child.gitFootprint,
        outputRef: child.outputRef
      };
    }),
    baseRef: node.baseRef,
    headRef: node.outputRef ? { name: node.outputRef.name, commit: node.outputRef.commit } : undefined,
    collectedAt
  });
  if (!aggregate) {
    return;
  }

  if (node.gitFootprint?.diffStat && node.gitFootprint.source !== "child-aggregate") {
    node.gitFootprint = {
      ...node.gitFootprint,
      childAggregate: aggregate
    };
    return;
  }
  node.gitFootprint = aggregate;
}

function mutationEventForStatus(status: NodeStatus): OperationalEventName {
  switch (status) {
    case "running":
      return operationalEvents.running;
    case "done":
      return operationalEvents.done;
    case "blocked":
      return operationalEvents.blocked;
    case "failed":
      return operationalEvents.failed;
    default:
      throw new Error(`No operational event is defined for mutation status: ${status}`);
  }
}

function pendingPlannerPreviewNodeState(node: GraphNode): PendingPlannerPreviewMetadata["nodeState"] {
  return {
    status: node.status,
    kind: node.kind,
    children: Array.isArray(node.children) ? [...node.children] : undefined,
    lease: node.lease ? { session: node.lease.session, runId: node.lease.runId } : undefined,
    blockedReason: node.blockedReason,
    question: node.question,
    report: node.report
  };
}

function assertFreshPendingPlannerPreview(
  graph: PlanGraphFile,
  nodeId: NodeId,
  node: GraphNode,
  requestedKind: string,
  requestedChildren: DecomposeChildDefinition[]
): void {
  const preview = node.pendingPlannerPreview;
  if (!preview) {
    return;
  }

  if (preview.graphVersion !== undefined && graph.graphVersion !== preview.graphVersion) {
    throw new Error(
      `Stale planner preview for ${nodeId}: graphVersion changed from ${preview.graphVersion} to ${graph.graphVersion ?? "unknown"}; regenerate or reset before applying`
    );
  }

  const expectedState = stableJsonStringify(preview.nodeState ?? {});
  const actualState = stableJsonStringify(pendingPlannerPreviewNodeState(node) ?? {});
  if (expectedState !== actualState) {
    throw new Error(`Stale planner preview for ${nodeId}: node state changed; regenerate or reset before applying`);
  }

  if (requestedKind !== preview.decompose.kind) {
    throw new Error(`Planner preview for ${nodeId} proposed ${preview.decompose.kind}, not ${requestedKind}`);
  }

  const expectedChildren = stableJsonStringify(preview.decompose.children.map(canonicalPlannerPreviewChild));
  const actualChildren = stableJsonStringify(requestedChildren.map(canonicalPlannerPreviewChild));
  if (actualChildren !== expectedChildren) {
    throw new Error(`Planner preview for ${nodeId} does not match requested decomposition children; apply the stored preview or regenerate it`);
  }
}

function canonicalPlannerPreviewChild(child: DecomposeChildDefinition): Record<string, unknown> {
  return {
    ...child,
    kind: child.kind || "task",
    status: child.status || "pending"
  };
}

function stableJsonStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortJsonValue(entry)])
    );
  }
  return value;
}

function normalizeChildDefinitions(children: DecomposeChildDefinition[]): DecomposeChildDefinition[] {
  const normalized: DecomposeChildDefinition[] = [];
  const seen = new Set<NodeId>();

  for (const [index, child] of children.entries()) {
    if (!child || typeof child !== "object") {
      throw new Error("Each child must be an object");
    }
    assertNonEmptyChildId(child.id, `children[${index}].id`);
    if (typeof child.title !== "string" || child.title.length === 0) {
      throw new Error("Each child requires id and title");
    }
    if (seen.has(child.id)) {
      throw new Error(`Duplicate child id in decomposition: ${child.id}`);
    }
    seen.add(child.id);
    const { id, title, kind, status, children: childIds, ...metadata } = child;
    if (childIds !== undefined) {
      if (!Array.isArray(childIds)) {
        throw new Error(`Child children must be an array: ${child.id}`);
      }
      childIds.forEach((childId, childIndex) => {
        if (typeof childId !== "string" || childId.length === 0) {
          throw new Error(`Child child id must be a non-empty string: ${child.id}.children[${childIndex}]`);
        }
      });
    }
    normalized.push({
      ...metadata,
      id: child.id,
      title: child.title,
      kind: child.kind || "task",
      status: child.status || "pending",
      children: childIds
    });
  }

  return normalized;
}

function assertNonEmptyChildId(id: unknown, path: string): asserts id is string {
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`Child id must be a non-empty string at ${path}`);
  }
}

function assertValidGraphAfterMutation(graph: PlanGraphFile): void {
  const validation = validatePlanGraphFileResult(graph);
  if (validation.errors.length > 0) {
    throw new Error(`Invalid graph after mutation: ${validation.errors.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`);
  }
}

function appendHistory(node: GraphNode, event: OperationalEventName, details: Record<string, unknown> = {}): void {
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
