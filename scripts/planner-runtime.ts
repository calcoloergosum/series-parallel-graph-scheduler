import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import type {
  GraphNode,
  JsonObject,
  NodeId,
  NodePlannerMetadata,
  PlanGraphFile,
  PlannerOutputKind,
  PlannerOutputSchemaDescriptor,
  PlannerParentContext,
  PlannerResponse,
  PlannerRuntime,
  PlannerRuntimeRequest
} from "./contracts.js";
import { summarizeGraph } from "./graph-traversal.js";

export interface BuildPlannerRuntimeRequestOptions {
  requestId?: string;
  mode?: PlannerRuntimeRequest["mode"];
  goal?: string;
  allowedKinds?: PlannerOutputKind[];
  planner?: NodePlannerMetadata;
}

export interface PromptPlannerAdapterRequest {
  prompt: string;
  request: PlannerRuntimeRequest;
}

export interface PromptPlannerAdapter {
  complete(request: PromptPlannerAdapterRequest): Promise<string>;
}

export interface PromptPlannerRuntimeOptions {
  adapter: PromptPlannerAdapter;
  templatePath: string;
  planner?: NodePlannerMetadata;
}

export interface BuildPlannerPromptOptions {
  template?: string;
  templatePath?: string;
}

export type FixturePlannerResponseSource =
  | PlannerResponse
  | Record<string, PlannerResponse>
  | ((request: PlannerRuntimeRequest) => PlannerResponse | Promise<PlannerResponse>);

const plannerResponseSchema = {
  type: "object",
  required: ["kind", "title"],
  additionalProperties: true,
  properties: {
    requestId: { type: "string" },
    kind: { enum: ["task", "series", "parallel"] },
    title: { type: "string", minLength: 1 },
    description: { type: "string" },
    rationale: { type: "string" },
    deliverables: { type: "array", items: { type: "string" } },
    acceptanceCriteria: { type: "array", items: { type: "string" } },
    childIdPolicy: { enum: ["planner-deterministic", "scheduler-generated"] },
    children: {
      type: "array",
      items: {
        type: "object",
        required: ["title"],
        additionalProperties: true,
        properties: {
          id: { type: "string" },
          idHint: { type: "string" },
          kind: { enum: ["task", "series", "parallel"] },
          title: { type: "string", minLength: 1 },
          description: { type: "string" },
          deliverables: { type: "array", items: { type: "string" } },
          acceptanceCriteria: { type: "array", items: { type: "string" } }
        }
      }
    }
  }
} satisfies JsonObject;

export const defaultPlannerOutputSchema: PlannerOutputSchemaDescriptor = {
  schemaRef: "docs/planner-output-schema.md",
  description: "Return one PlannerResponse JSON object. Do not return graph patches or execution commands.",
  responseKinds: ["task", "series", "parallel"],
  requiredFields: ["kind", "title"],
  schema: plannerResponseSchema
};

export function buildPlannerRuntimeRequest(
  graph: PlanGraphFile,
  nodeId: NodeId,
  options: BuildPlannerRuntimeRequestOptions = {}
): PlannerRuntimeRequest {
  const node = graph.graph.nodes[nodeId];
  if (!node) {
    throw new Error(`Unknown node: ${nodeId}`);
  }

  const goal = options.goal || goalTextForNode(node, nodeId);
  const allowedKinds = options.allowedKinds || ["task", "series", "parallel"];
  const requestId = options.requestId || `plan-${nodeId}-${graph.graphVersion || 0}`;

  return {
    requestId,
    mode: options.mode || "decompose",
    goal,
    nodeId,
    node,
    parentContext: buildPlannerParentContext(graph, nodeId, node),
    currentGraphSummary: summarizeGraph(graph),
    outputSchema: defaultPlannerOutputSchema,
    allowedKinds,
    contextRefs: node.contextRefs,
    outputContract: node.outputContract,
    planner: options.planner || node.planner
  };
}

export function buildPlannerParentContext(
  graph: PlanGraphFile,
  nodeId: NodeId,
  node: GraphNode = graph.graph.nodes[nodeId] || {}
): PlannerParentContext {
  return {
    nodeId,
    title: node.title,
    kind: node.kind,
    status: node.status,
    description: node.description,
    deliverables: node.deliverables,
    acceptanceCriteria: node.acceptanceCriteria,
    goal: node.goal,
    contextRefs: node.contextRefs,
    outputContract: node.outputContract,
    parentIds: parentIdsForNode(graph, nodeId)
  };
}

export async function buildPlannerPrompt(
  request: PlannerRuntimeRequest,
  options: BuildPlannerPromptOptions = {}
): Promise<string> {
  const template = options.template ?? await readFile(requiredTemplatePath(options.templatePath), "utf8");
  return renderPlannerPrompt(template, request);
}

export function renderPlannerPrompt(template: string, request: PlannerRuntimeRequest): string {
  const context = {
    goal: request.goal,
    requestJson: JSON.stringify(request, null, 2),
    parentContextJson: JSON.stringify(request.parentContext || null, null, 2),
    graphSummaryJson: JSON.stringify(request.currentGraphSummary, null, 2),
    outputSchemaJson: JSON.stringify(request.outputSchema, null, 2)
  };

  return template.replaceAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key) => {
    if (Object.hasOwn(context, key)) {
      return String(context[key as keyof typeof context]);
    }
    return match;
  });
}

export function createFixturePlannerRuntime(source: FixturePlannerResponseSource): PlannerRuntime {
  return {
    async plan(request) {
      const response = await fixtureResponseForRequest(source, request);
      return {
        requestId: request.requestId,
        response: clonePlannerResponse({
          ...response,
          requestId: response.requestId || request.requestId
        }),
        planner: request.planner || { name: "fixture-planner" }
      };
    }
  };
}

export function createPromptPlannerRuntime(options: PromptPlannerRuntimeOptions): PlannerRuntime {
  return {
    async plan(request) {
      const prompt = await buildPlannerPrompt(request, { templatePath: options.templatePath });
      const rawText = await options.adapter.complete({ prompt, request });
      const response = parsePlannerResponse(rawText);
      return {
        requestId: request.requestId,
        response: {
          ...response,
          requestId: response.requestId || request.requestId
        },
        rawText,
        prompt,
        planner: request.planner || options.planner
      };
    }
  };
}

export function parsePlannerResponse(rawText: string): PlannerResponse {
  const parsed: unknown = JSON.parse(extractJsonObject(rawText));
  if (!isPlannerResponse(parsed)) {
    throw new Error("Planner response must be a JSON object with kind and title");
  }
  return parsed;
}

function requiredTemplatePath(templatePath: string | undefined): string {
  if (!templatePath) {
    throw new Error("Missing planner prompt template path");
  }
  return isAbsolute(templatePath) ? templatePath : resolve(templatePath);
}

function goalTextForNode(node: GraphNode, nodeId: NodeId): string {
  if (typeof node.goal === "string" && node.goal.trim()) {
    return node.goal;
  }
  if (typeof node.goal === "object" && typeof node.goal.text === "string" && node.goal.text.trim()) {
    return node.goal.text;
  }
  return node.description || node.title || nodeId;
}

function parentIdsForNode(graph: PlanGraphFile, nodeId: NodeId): NodeId[] {
  const parentIds: NodeId[] = [];
  for (const [candidateId, candidate] of Object.entries(graph.graph.nodes)) {
    if (candidate.children?.includes(nodeId)) {
      parentIds.push(candidateId);
    }
  }
  return parentIds;
}

async function fixtureResponseForRequest(
  source: FixturePlannerResponseSource,
  request: PlannerRuntimeRequest
): Promise<PlannerResponse> {
  if (typeof source === "function") {
    return source(request);
  }
  if (isPlannerResponse(source)) {
    return source;
  }
  const response = source[request.requestId];
  if (!response) {
    throw new Error(`No fixture planner response for request id: ${request.requestId}`);
  }
  return response;
}

function clonePlannerResponse(response: PlannerResponse): PlannerResponse {
  return JSON.parse(JSON.stringify(response)) as PlannerResponse;
}

function extractJsonObject(rawText: string): string {
  const fenced = rawText.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fenced?.[1] || rawText).trim();
}

function isPlannerResponse(value: unknown): value is PlannerResponse {
  if (!value || typeof value !== "object") {
    return false;
  }
  const response = value as Partial<PlannerResponse>;
  return (
    (response.kind === "task" || response.kind === "series" || response.kind === "parallel") &&
    typeof response.title === "string" &&
    response.title.trim().length > 0
  );
}
