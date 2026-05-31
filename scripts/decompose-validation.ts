import {
  type GraphNode,
  type NodeId,
  type NodeKind,
  type NodeStatus,
  type PendingPlannerPreviewMetadata,
  type PlanGraphFile
} from "./contracts.js";

export interface DecomposeChildDefinitionLike {
  id: NodeId;
  title: string;
  kind?: NodeKind;
  status?: NodeStatus;
  children?: NodeId[];
  [metadata: string]: unknown;
}

export function pendingPlannerPreviewNodeState(node: GraphNode): PendingPlannerPreviewMetadata["nodeState"] {
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

export function assertFreshPendingPlannerPreview(
  graph: PlanGraphFile,
  nodeId: NodeId,
  node: GraphNode,
  requestedKind: string,
  requestedChildren: DecomposeChildDefinitionLike[]
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

export function normalizeChildDefinitions(children: DecomposeChildDefinitionLike[]): DecomposeChildDefinitionLike[] {
  const normalized: DecomposeChildDefinitionLike[] = [];
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
      id,
      title,
      kind: kind || "task",
      status: status || "pending",
      children: childIds
    });
  }

  return normalized;
}

function canonicalPlannerPreviewChild(child: DecomposeChildDefinitionLike): Record<string, unknown> {
  return {
    ...child,
    kind: child.kind || "task",
    status: child.status || "pending"
  };
}

function assertNonEmptyChildId(id: unknown, path: string): asserts id is string {
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`Child id must be a non-empty string at ${path}`);
  }
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
