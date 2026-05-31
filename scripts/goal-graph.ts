import { knownNodeStatuses, validatePlanGraphFileResult } from "./contracts.js";
import type {
  GraphNode,
  NodeGoalMetadata,
  NodeId,
  NodePlannerMetadata,
  PlanGraphFile,
  PlannerChildProposal,
  PlannerOutputKind,
  PlannerResponse,
  PlannerRuntimeResponse
} from "./contracts.js";
import { PlannerResponseValidationError, validatePlannerResponse } from "./planner-runtime.js";

export const goalGraphVersion = 1;
export const goalGraphInitialNodeId = "PLAN";

export interface BuildGoalGraphOptions {
  title?: string;
  createdAt?: string;
  includeDocument?: boolean;
  plannerResponse?: PlannerResponse;
  plannerResult?: PlannerRuntimeResponse;
  planner?: NodePlannerMetadata;
  allowedKinds?: PlannerOutputKind[];
}

export function buildGoalGraph(goal: string, options: BuildGoalGraphOptions | string = {}): PlanGraphFile {
  const normalizedGoal = goal.trim();
  const normalizedOptions = typeof options === "string" ? { title: options } : options;
  if (normalizedOptions.plannerResponse || normalizedOptions.plannerResult) {
    return buildGoalGraphFromPlannerResponse(
      normalizedGoal,
      normalizedOptions.plannerResponse || normalizedOptions.plannerResult?.response,
      normalizedOptions
    );
  }
  const normalizedTitle = normalizedOptions.title?.trim() || defaultGoalTitle(normalizedGoal);
  const createdAt = normalizedOptions.createdAt ?? new Date().toISOString();
  const graph: PlanGraphFile = {
    graphVersion: goalGraphVersion,
    title: normalizedTitle,
    description: "Generated from a CLI goal.",
    statusModel: [...knownNodeStatuses],
    scheduler: {
      stateFile: "plan.graph.json",
      htmlView: "plan.html",
      reportsDir: "reports",
      leaseSeconds: 1800
    },
    graph: {
      root: "ROOT",
      nodes: {
        ROOT: {
          title: normalizedTitle,
          kind: "series",
          status: "pending",
          children: [goalGraphInitialNodeId],
          description: normalizedGoal,
          goal: {
            text: normalizedGoal,
            source: "operator",
            createdAt
          },
          history: [
            {
              at: createdAt,
              event: "goal-planned",
              source: "cli"
            }
          ]
        },
        [goalGraphInitialNodeId]: {
          title: "Plan and execute goal",
          kind: "task",
          status: "pending",
          description: normalizedGoal,
          goal: {
            text: normalizedGoal,
            source: "parent",
            createdAt
          },
          deliverables: [
            "A validated series-parallel graph decomposition or completed implementation for the goal."
          ],
          acceptanceCriteria: [
            "The goal is either decomposed into scheduler-ready child work or completed with reportable evidence."
          ],
          history: [
            {
              at: createdAt,
              event: "created",
              source: "goal-graph-factory"
            }
          ]
        }
      }
    }
  };

  if (normalizedOptions.includeDocument !== false) {
    graph.document = buildGoalDocument(normalizedTitle, normalizedGoal);
  }

  return graph;
}

export function buildGoalGraphFromPlannerResponse(
  goal: string,
  response: PlannerResponse | undefined,
  options: BuildGoalGraphOptions | string = {}
): PlanGraphFile {
  if (!response) {
    throw new Error("Missing planner response for goal graph");
  }

  const normalizedGoal = goal.trim();
  const normalizedOptions = typeof options === "string" ? { title: options } : options;
  const normalizedTitle = normalizedOptions.title?.trim() || response.title.trim() || defaultGoalTitle(normalizedGoal);
  const createdAt = normalizedOptions.createdAt ?? new Date().toISOString();
  const planner = plannerMetadataForResponse(response, normalizedOptions, createdAt);
  const baseGraph = baseGoalGraphShell(normalizedTitle, normalizedGoal, createdAt);
  const plannerValidation = validatePlannerResponse(response, {
    graph: baseGraph,
    parentId: "ROOT",
    allowedKinds: normalizedOptions.allowedKinds
  });
  if (!plannerValidation.valid) {
    throw new PlannerResponseValidationError(plannerValidation);
  }

  const usedIds = new Set<NodeId>(["ROOT"]);
  const materializedNodes: Record<NodeId, GraphNode> = {};
  const rootChildren = response.kind === "task"
    ? [goalGraphInitialNodeId]
    : materializePlannerChildren(response.children, {
      parentId: "ROOT",
      usedIds,
      nodes: materializedNodes,
      goal: normalizedGoal,
      createdAt,
      planner
    });
  const nodes: Record<NodeId, GraphNode> = {};
  const root: GraphNode = {
    title: normalizedTitle,
    kind: response.kind === "task" ? "series" : response.kind,
    status: "pending",
    children: rootChildren,
    description: response.description || normalizedGoal,
    goal: goalMetadata(response.goal, normalizedGoal, "operator", createdAt),
    planner,
    plannerDecision: response.title,
    ...(response.rationale ? { rationale: response.rationale, decompositionReason: response.rationale } : {}),
    history: [
      {
        at: createdAt,
        event: "goal-planned",
        source: "planner",
        requestId: response.requestId || normalizedOptions.plannerResult?.requestId
      }
    ]
  };

  if (response.kind === "task") {
    nodes[goalGraphInitialNodeId] = nodeFromPlannerProposal(response, {
      id: goalGraphInitialNodeId,
      kind: "task",
      goal: normalizedGoal,
      createdAt,
      planner,
      goalSource: "planner"
    });
  } else {
    for (const [nodeId, node] of Object.entries(materializedNodes)) {
      nodes[nodeId] = node;
    }
  }

  const graph: PlanGraphFile = {
    graphVersion: goalGraphVersion,
    title: normalizedTitle,
    description: "Generated from a CLI goal.",
    statusModel: [...knownNodeStatuses],
    scheduler: {
      stateFile: "plan.graph.json",
      htmlView: "plan.html",
      reportsDir: "reports",
      leaseSeconds: 1800
    },
    graph: {
      root: "ROOT",
      nodes: {
        ROOT: root,
        ...nodes
      }
    }
  };

  const graphValidation = validatePlanGraphFileResult(graph);
  if (graphValidation.errors.length > 0) {
    throw new Error(`Generated planner graph failed validation: ${graphValidation.errors.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`);
  }

  if (normalizedOptions.includeDocument !== false) {
    graph.document = buildGoalDocument(normalizedTitle, normalizedGoal, rootChildren);
  }

  return graph;
}

interface MaterializePlannerChildContext {
  parentId: NodeId;
  usedIds: Set<NodeId>;
  nodes: Record<NodeId, GraphNode>;
  goal: string;
  createdAt: string;
  planner: NodePlannerMetadata;
}

function materializePlannerChildren(
  children: PlannerChildProposal[],
  context: MaterializePlannerChildContext
): NodeId[] {
  return children.map((child, index) => {
    const id = materializePlannerChildId(child, index, context);
    context.usedIds.add(id);
    const kind = plannerChildNodeKind(child);
    const node = nodeFromPlannerProposal(child, {
      id,
      kind,
      goal: context.goal,
      createdAt: context.createdAt,
      planner: context.planner,
      goalSource: "planner"
    });
    if (kind === "series" || kind === "parallel") {
      node.children = materializePlannerChildren(child.children || [], {
        ...context,
        parentId: id
      });
    } else {
      delete node.children;
    }
    context.nodes[id] = node;
    return id;
  });
}

function plannerChildNodeKind(child: PlannerChildProposal): PlannerOutputKind {
  if ((child.kind === "series" || child.kind === "parallel") && Array.isArray(child.children) && child.children.length > 0) {
    return child.kind;
  }
  return "task";
}

function materializePlannerChildId(
  child: PlannerChildProposal,
  index: number,
  context: MaterializePlannerChildContext
): NodeId {
  if (typeof child.id === "string" && child.id.trim()) {
    return child.id.trim();
  }
  const parentPrefix = slugIdPart(context.parentId) || "NODE";
  const childBase = slugIdPart(child.idHint || child.title) || `CHILD_${index + 1}`;
  const base = `${parentPrefix}_${childBase}`.slice(0, 96).replaceAll(/_+$/g, "");
  let candidate = base || `${parentPrefix}_CHILD_${index + 1}`;
  let suffix = 2;
  while (context.usedIds.has(candidate)) {
    const suffixText = `_${suffix}`;
    candidate = `${base.slice(0, Math.max(1, 128 - suffixText.length))}${suffixText}`;
    suffix += 1;
  }
  return candidate;
}

function nodeFromPlannerProposal(
  proposal: PlannerChildProposal | PlannerResponse,
  options: {
    id: NodeId;
    kind: PlannerOutputKind;
    goal: string;
    createdAt: string;
    planner: NodePlannerMetadata;
    goalSource: NonNullable<NodeGoalMetadata["source"]>;
  }
): GraphNode {
  const {
    id: _id,
    idHint: _idHint,
    kind: _kind,
    children: _children,
    childIdPolicy: _childIdPolicy,
    requestId: _requestId,
    rationale,
    planner: proposalPlanner,
    goal,
    ...metadata
  } = proposal as PlannerResponse & PlannerChildProposal;
  return {
    ...metadata,
    title: proposal.title.trim(),
    kind: options.kind,
    status: "pending",
    description: proposal.description || options.goal,
    goal: goalMetadata(goal, options.goal, options.goalSource, options.createdAt),
    planner: {
      ...options.planner,
      ...proposalPlanner,
      plannedAt: proposalPlanner?.plannedAt || options.planner.plannedAt || options.createdAt
    },
    plannerDecision: proposal.title,
    ...(typeof rationale === "string" && rationale.trim() ? { rationale, decompositionReason: rationale } : {}),
    history: [
      {
        at: options.createdAt,
        event: "created",
        source: "planner",
        requestId: options.planner.requestId
      }
    ]
  };
}

function plannerMetadataForResponse(
  response: PlannerResponse,
  options: BuildGoalGraphOptions,
  createdAt: string
): NodePlannerMetadata {
  const planner = {
    ...options.planner,
    ...options.plannerResult?.planner,
    ...response.planner
  };
  return {
    ...planner,
    requestId: response.requestId || options.plannerResult?.requestId || planner.requestId,
    plannedAt: planner.plannedAt || createdAt,
    decision: response.title,
    ...(response.rationale ? { rationale: response.rationale, decompositionReason: response.rationale } : {})
  };
}

function goalMetadata(
  value: string | NodeGoalMetadata | undefined,
  fallbackGoal: string,
  source: NonNullable<NodeGoalMetadata["source"]>,
  createdAt: string
): NodeGoalMetadata {
  if (typeof value === "string" && value.trim()) {
    return { text: value.trim(), source, createdAt };
  }
  if (typeof value === "object" && typeof value.text === "string" && value.text.trim()) {
    return {
      ...value,
      text: value.text.trim(),
      source: value.source || source,
      createdAt: value.createdAt || createdAt
    };
  }
  return { text: fallbackGoal, source, createdAt };
}

function baseGoalGraphShell(title: string, goal: string, createdAt: string): PlanGraphFile {
  return {
    graphVersion: goalGraphVersion,
    title,
    graph: {
      root: "ROOT",
      nodes: {
        ROOT: {
          title,
          kind: "series",
          status: "pending",
          children: [goalGraphInitialNodeId],
          description: goal,
          goal: { text: goal, source: "operator", createdAt }
        }
      }
    }
  };
}

function slugIdPart(value: string | undefined): string {
  return (value || "")
    .trim()
    .toUpperCase()
    .replaceAll(/[^A-Z0-9]+/g, "_")
    .replaceAll(/^_+|_+$/g, "");
}

function buildGoalDocument(title: string, goal: string, initialNodeIds: NodeId[] = [goalGraphInitialNodeId]): NonNullable<PlanGraphFile["document"]> {
  return {
    pageTitle: title,
    meta: [
      { label: "Goal", value: goal },
      { label: initialNodeIds.length === 1 ? "Initial node" : "Initial nodes", value: initialNodeIds.join(", ") }
    ],
    intro: [
      goal
    ],
    sections: [
      {
        heading: "Generated Graph",
        paragraphs: [
          "This graph was generated from a single operator goal and starts with one claimable planning or execution task."
        ]
      }
    ]
  };
}

function defaultGoalTitle(goal: string): string {
  return goal.length <= 80 ? goal : `${goal.slice(0, 77)}...`;
}
