import { knownNodeStatuses } from "./contracts.js";
import type { PlanGraphFile } from "./contracts.js";

export const goalGraphVersion = 1;
export const goalGraphInitialNodeId = "PLAN";

export interface BuildGoalGraphOptions {
  title?: string;
  createdAt?: string;
  includeDocument?: boolean;
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
    graph.document = buildGoalDocument(normalizedTitle, normalizedGoal);
  }

  return graph;
}

function buildGoalDocument(title: string, goal: string): NonNullable<PlanGraphFile["document"]> {
  return {
    pageTitle: title,
    meta: [
      { label: "Goal", value: goal },
      { label: "Initial node", value: goalGraphInitialNodeId }
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
