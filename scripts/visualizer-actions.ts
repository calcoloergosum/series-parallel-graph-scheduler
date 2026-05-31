import type {
  GraphNode,
  NodeId,
  PlanGraphFile,
  VisualizerActionDanger,
  VisualizerActionPolicy,
  VisualizerNodeAction
} from "./contracts.js";
import { getNode, isLeaf, listReadyLeafNodes } from "./graph-traversal.js";
import { schedulerTransitionTable } from "./node-mutations.js";

export interface VisualizerActionContext {
  session?: string;
  runId?: string;
}

type VisualizerActionId = VisualizerNodeAction["id"];

interface ActionDefinition {
  id: VisualizerActionId;
  label: string;
  danger: VisualizerActionDanger;
  requiredFields: string[];
  confirmation?: (nodeId: NodeId) => VisualizerNodeAction["confirmation"];
  disabledReason(graph: PlanGraphFile, nodeId: NodeId, node: GraphNode, context: VisualizerActionContext, readyIds: ReadonlySet<NodeId>): string | undefined;
}

const workerCredentialFields = ["nodeId", "session|runId"];

const actionDefinitions: ActionDefinition[] = [
  {
    id: "claim",
    label: "Claim",
    danger: "none",
    requiredFields: ["nodeId"],
    disabledReason: (graph, nodeId, _node, _context, readyIds) => {
      if (!isLeaf(graph, nodeId)) {
        return "Only leaf nodes can be claimed.";
      }
      return readyIds.has(nodeId) ? undefined : "Node is not ready under the scheduler readiness policy.";
    }
  },
  {
    id: "start",
    label: "Start",
    danger: "none",
    requiredFields: workerCredentialFields,
    disabledReason: workerActionDisabledReason("start")
  },
  {
    id: "renew",
    label: "Renew Lease",
    danger: "none",
    requiredFields: [...workerCredentialFields, "leaseSeconds?"],
    disabledReason: (graph, nodeId, node, context) => {
      if (!isLeaf(graph, nodeId)) {
        return "Only leaf nodes can be renewed.";
      }
      if (!node.lease) {
        return "Renew requires an existing lease.";
      }
      return statusOrLeaseDisabledReason(node, context, schedulerTransitionTable.renew.allowedFrom, "renew");
    }
  },
  {
    id: "done",
    label: "Mark Done",
    danger: "none",
    requiredFields: [...workerCredentialFields, "report?"],
    disabledReason: workerActionDisabledReason("done")
  },
  {
    id: "block",
    label: "Block",
    danger: "caution",
    requiredFields: [...workerCredentialFields, "question?", "reason?"],
    disabledReason: workerActionDisabledReason("block")
  },
  {
    id: "answer",
    label: "Answer",
    danger: "none",
    requiredFields: ["nodeId", "answer", "responder?"],
    disabledReason: (graph, nodeId, node) => {
      if (!isLeaf(graph, nodeId)) {
        return "Only leaf nodes can be answered.";
      }
      return (node.status || "pending") === "blocked" ? undefined : "Answer requires blocked status.";
    }
  },
  {
    id: "fail",
    label: "Fail",
    danger: "danger",
    requiredFields: [...workerCredentialFields, "reason", "report?"],
    confirmation: (nodeId) => destructiveConfirmation("Fail node", `Fail ${nodeId}`),
    disabledReason: workerActionDisabledReason("fail")
  },
  {
    id: "reset",
    label: "Reset",
    danger: "danger",
    requiredFields: ["nodeId", "reason?"],
    confirmation: (nodeId) => destructiveConfirmation("Reset node", `Reset ${nodeId}`),
    disabledReason: (graph, nodeId) => isLeaf(graph, nodeId) ? undefined : "Direct reset is only valid for leaf nodes; use reset subtree or reset reachable."
  },
  {
    id: "reset-subtree",
    label: "Reset Subtree",
    danger: "danger",
    requiredFields: ["nodeId", "reason?"],
    confirmation: (nodeId) => destructiveConfirmation("Reset subtree", `Reset ${nodeId} and all descendants`),
    disabledReason: () => undefined
  },
  {
    id: "reset-reachable",
    label: "Reset Reachable",
    danger: "danger",
    requiredFields: ["nodeId", "reason?"],
    confirmation: (nodeId) => destructiveConfirmation("Reset reachable work", `Reset work reachable from ${nodeId}`),
    disabledReason: () => undefined
  },
  {
    id: "decompose",
    label: "Decompose",
    danger: "caution",
    requiredFields: [...workerCredentialFields, "children", "kind?"],
    disabledReason: (graph, nodeId, node, context, readyIds) =>
      previewFreshnessDisabledReason(graph, nodeId, node) || workerActionDisabledReason("decompose")(graph, nodeId, node, context, readyIds)
  },
  {
    id: "apply-preview",
    label: "Apply Preview",
    danger: "caution",
    requiredFields: workerCredentialFields,
    disabledReason: (graph, nodeId, node, context) => {
      if (!node.pendingPlannerPreview) {
        return "Node has no pending planner preview.";
      }
      const staleReason = previewFreshnessDisabledReason(graph, nodeId, node);
      if (staleReason) {
        return staleReason;
      }
      return workerActionDisabledReason("apply-preview")(graph, nodeId, node, context, new Set());
    }
  },
  {
    id: "reject-preview",
    label: "Reject Preview",
    danger: "caution",
    requiredFields: ["nodeId", "reason?", "responder?"],
    confirmation: (nodeId) => destructiveConfirmation("Reject preview", `Reject the planner preview for ${nodeId}`),
    disabledReason: (graph, nodeId, node) => {
      if (!isLeaf(graph, nodeId)) {
        return "Only leaf nodes can have pending planner previews rejected.";
      }
      if (!node.pendingPlannerPreview) {
        return "Node has no pending planner preview.";
      }
      return (schedulerTransitionTable["reject-preview"].allowedFrom as readonly string[]).includes(node.status || "pending")
        ? undefined
        : "reject-preview requires blocked or pending status.";
    }
  },
  {
    id: "regenerate-preview",
    label: "Regenerate Preview",
    danger: "caution",
    requiredFields: [...workerCredentialFields, "plannerFixturePath?", "requestId?", "report?"],
    disabledReason: (graph, nodeId, node, context) => {
      if (!isLeaf(graph, nodeId)) {
        return "Only leaf nodes can have planner previews regenerated.";
      }
      return statusOrLeaseDisabledReason(node, context, schedulerTransitionTable["regenerate-preview"].allowedFrom, "regenerate-preview");
    }
  }
];

export const visualizerActionPolicy: VisualizerActionPolicy = {
  leaseProtectedWorkerActions: {
    whenCredentialsAbsent: "disable-leased-node-actions",
    requiredCredential: "matching-session-or-runId"
  },
  destructiveActions: {
    danger: "danger",
    requireConfirmationMetadata: true
  },
  serverAuthority: "scheduler-mutation-guards"
};

export function buildVisualizerNodeActions(
  graph: PlanGraphFile,
  nodeId: NodeId,
  context: VisualizerActionContext = {}
): VisualizerNodeAction[] {
  const node = getNode(graph, nodeId);
  const readyIds = new Set(listReadyLeafNodes(graph).map((readyNode) => readyNode.id));
  return buildVisualizerNodeActionsWithReadySet(graph, nodeId, node, readyIds, context);
}

export function buildVisualizerNodeActionMap(
  graph: PlanGraphFile,
  context: VisualizerActionContext = {}
): Record<NodeId, VisualizerNodeAction[]> {
  const readyIds = new Set(listReadyLeafNodes(graph).map((node) => node.id));
  return Object.fromEntries(Object.entries(graph.graph.nodes).map(([nodeId, node]) => [
    nodeId,
    buildVisualizerNodeActionsWithReadySet(graph, nodeId, node, readyIds, context)
  ]));
}

function buildVisualizerNodeActionsWithReadySet(
  graph: PlanGraphFile,
  nodeId: NodeId,
  node: GraphNode,
  readyIds: ReadonlySet<NodeId>,
  context: VisualizerActionContext
): VisualizerNodeAction[] {
  return actionDefinitions.map((definition) => {
    const disabledReason = definition.disabledReason(graph, nodeId, node, context, readyIds);
    return {
      id: definition.id,
      label: definition.label,
      danger: definition.danger,
      requiredFields: [...definition.requiredFields],
      ...(disabledReason ? { disabledReason } : {}),
      ...(definition.confirmation ? { confirmation: definition.confirmation(nodeId) } : {})
    };
  });
}

function workerActionDisabledReason(actionId: keyof typeof schedulerTransitionTable): ActionDefinition["disabledReason"] {
  return (graph, nodeId, node, context) => {
    if (!isLeaf(graph, nodeId)) {
      return "Only leaf nodes can be mutated by worker actions.";
    }
    return statusOrLeaseDisabledReason(node, context, schedulerTransitionTable[actionId].allowedFrom, actionId);
  };
}

function statusOrLeaseDisabledReason(
  node: GraphNode,
  context: VisualizerActionContext,
  allowedStatuses: readonly string[],
  actionId: string
): string | undefined {
  const status = node.status || "pending";
  if (!allowedStatuses.includes(status)) {
    return `${actionId} requires status ${allowedStatuses.join(", ")}.`;
  }
  return leaseCredentialDisabledReason(node, context);
}

function leaseCredentialDisabledReason(node: GraphNode, context: VisualizerActionContext): string | undefined {
  if (!node.lease) {
    return undefined;
  }
  if (!context.session && !context.runId) {
    return "Lease-protected worker action requires a matching session or run id; this visualizer request has no worker credentials.";
  }
  if (context.runId && node.lease.runId !== context.runId) {
    return `Lease run id mismatch; expected ${node.lease.runId}.`;
  }
  if (context.session && node.lease.session !== context.session) {
    return `Lease session mismatch; expected ${node.lease.session}.`;
  }
  return undefined;
}

function previewFreshnessDisabledReason(graph: PlanGraphFile, nodeId: NodeId, node: GraphNode): string | undefined {
  const preview = node.pendingPlannerPreview;
  if (!preview) {
    return undefined;
  }
  if (preview.graphVersion !== undefined && graph.graphVersion !== preview.graphVersion) {
    return `Planner preview is stale for ${nodeId}: graph version changed from ${preview.graphVersion} to ${graph.graphVersion ?? "unknown"}.`;
  }
  if (stableJsonStringify(preview.nodeState ?? {}) !== stableJsonStringify(previewNodeState(node) ?? {})) {
    return `Planner preview is stale for ${nodeId}: node state changed.`;
  }
  return undefined;
}

function previewNodeState(node: GraphNode): NonNullable<GraphNode["pendingPlannerPreview"]>["nodeState"] {
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

function destructiveConfirmation(label: string, message: string): VisualizerNodeAction["confirmation"] {
  return {
    required: true,
    label,
    message
  };
}
