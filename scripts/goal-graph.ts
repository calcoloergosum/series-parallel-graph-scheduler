import { knownNodeStatuses } from "./contracts.js";
import type {
  GraphNode,
  NodeId,
  PlanGraphFile,
  PlannerChildProposal,
  PlannerCompositeResponse,
  PlannerResponse
} from "./contracts.js";
import { validatePlanGraphFileResult } from "./contracts.js";
import {
  materializePlannerChildId,
  PlannerResponseValidationError,
  validatePlannerResponse
} from "./planner-runtime.js";

export const goalGraphVersion = 1;
export const goalGraphInitialNodeId = "PLAN";

export interface BuildGoalGraphOptions {
  title?: string;
  createdAt?: string;
  includeDocument?: boolean;
}

export interface BuildGoalGraphFromPlannerResponseOptions extends BuildGoalGraphOptions {
  plannerResponseParentId?: NodeId;
}

export function buildGoalGraph(goal: string, options: BuildGoalGraphOptions | string = {}): PlanGraphFile {
  const normalizedGoal = goal.trim();
  const normalizedOptions = typeof options === "string" ? { title: options } : options;
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
    graph.document = buildGoalDocument(
      normalizedTitle,
      normalizedGoal,
      goalGraphInitialNodeId,
      "This graph was generated from a single operator goal and starts with one claimable planning or execution task."
    );
  }

  return graph;
}

export function buildGoalGraphFromPlannerResponse(
  goal: string,
  response: PlannerResponse,
  options: BuildGoalGraphFromPlannerResponseOptions | string = {}
): PlanGraphFile {
  const normalizedGoal = goal.trim();
  const normalizedOptions = typeof options === "string" ? { title: options } : options;
  const createdAt = normalizedOptions.createdAt ?? new Date().toISOString();
  const parentId = normalizedOptions.plannerResponseParentId || "ROOT";
  const validation = validatePlannerResponse(response, {
    parentId,
    recursive: true
  });
  if (!validation.valid) {
    throw new PlannerResponseValidationError(validation);
  }

  const graph = response.kind === "task"
    ? buildGoalGraphFromTaskResponse(normalizedGoal, response, normalizedOptions, createdAt)
    : buildGoalGraphFromCompositeResponse(normalizedGoal, response, normalizedOptions, createdAt);
  const graphValidation = validatePlanGraphFileResult(graph);
  if (graphValidation.errors.length > 0) {
    throw new Error(`Generated graph failed validation: ${formatGraphValidationIssues(graphValidation.errors)}`);
  }
  return graph;
}

function buildGoalDocument(
  title: string,
  goal: string,
  initialNodeId: NodeId,
  generatedGraphDescription: string
): NonNullable<PlanGraphFile["document"]> {
  return {
    pageTitle: title,
    meta: [
      { label: "Goal", value: goal },
      { label: "Initial node", value: initialNodeId }
    ],
    intro: [
      goal
    ],
    sections: [
      {
        heading: "Generated Graph",
        paragraphs: [
          generatedGraphDescription
        ]
      }
    ]
  };
}

function defaultGoalTitle(goal: string): string {
  return goal.length <= 80 ? goal : `${goal.slice(0, 77)}...`;
}

function buildGoalGraphFromTaskResponse(
  goal: string,
  response: PlannerResponse,
  options: BuildGoalGraphOptions,
  createdAt: string
): PlanGraphFile {
  const graph = buildGoalGraph(goal, {
    ...options,
    title: options.title?.trim() || defaultGoalTitle(goal),
    createdAt
  });
  graph.graph.nodes[goalGraphInitialNodeId] = {
    ...plannerProposalNodeFields(response),
    title: response.title.trim(),
    kind: "task",
    status: "pending",
    goal: response.goal || graph.graph.nodes[goalGraphInitialNodeId].goal,
    history: [
      {
        at: createdAt,
        event: "created",
        source: "planner"
      }
    ]
  };
  return graph;
}

function buildGoalGraphFromCompositeResponse(
  goal: string,
  response: PlannerCompositeResponse,
  options: BuildGoalGraphOptions,
  createdAt: string
): PlanGraphFile {
  const title = options.title?.trim() || response.title.trim() || defaultGoalTitle(goal);
  const graph: PlanGraphFile = {
    graphVersion: goalGraphVersion,
    title,
    description: response.description || "Generated from a CLI goal.",
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
          ...plannerProposalNodeFields(response),
          title,
          kind: response.kind,
          status: "pending",
          description: response.description || goal,
          goal: response.goal || {
            text: goal,
            source: "operator",
            createdAt
          },
          children: [],
          history: [
            {
              at: createdAt,
              event: "goal-planned",
              source: "planner"
            }
          ]
        }
      }
    }
  };

  const usedIds = new Set<NodeId>(["ROOT"]);
  graph.graph.nodes.ROOT.children = materializePlannerTree(response.children, graph.graph.nodes, "ROOT", usedIds, createdAt);

  if (options.includeDocument !== false) {
    graph.document = buildGoalDocument(
      title,
      goal,
      "ROOT",
      "This graph was generated from a single operator goal and starts with a validated series-parallel decomposition."
    );
  }

  return graph;
}

function materializePlannerTree(
  children: PlannerChildProposal[],
  nodes: Record<NodeId, GraphNode>,
  parentId: NodeId,
  usedIds: Set<NodeId>,
  createdAt: string
): NodeId[] {
  return children.map((child, index) => {
    const id = materializePlannerChildId(child, index, usedIds, parentId);
    if (!id) {
      throw new Error(`Unable to materialize child id at $.children[${index}]`);
    }
    usedIds.add(id);
    const childChildren = Array.isArray(child.children) && (child.kind === "series" || child.kind === "parallel")
      ? materializePlannerTree(child.children, nodes, id, usedIds, createdAt)
      : undefined;
    nodes[id] = {
      ...plannerProposalNodeFields(child),
      title: child.title.trim(),
      kind: child.kind || "task",
      status: "pending",
      ...(childChildren ? { children: childChildren } : {}),
      history: [
        {
          at: createdAt,
          event: "created",
          source: "planner"
        }
      ]
    };
    return id;
  });
}

function plannerProposalNodeFields(proposal: PlannerResponse | PlannerChildProposal): Partial<GraphNode> {
  const {
    id: _id,
    idHint: _idHint,
    kind: _kind,
    title: _title,
    children: _children,
    childIdPolicy: _childIdPolicy,
    requestId: _requestId,
    rationale: _rationale,
    ...metadata
  } = proposal as PlannerResponse & PlannerChildProposal;
  return metadata;
}

function formatGraphValidationIssues(errors: { path: string; message: string }[]): string {
  return errors.map((issue) => `${issue.path} ${issue.message}`).join("; ");
}
