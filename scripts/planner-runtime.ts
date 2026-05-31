import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import type {
  GraphValidationIssue,
  GraphNode,
  JsonObject,
  NodeId,
  NodePlannerMetadata,
  PlanGraphFile,
  PlannerDecomposeChildSpec,
  PlannerDecomposeMutation,
  PlannerChildProposal,
  PlannerOutputKind,
  PlannerOutputSchemaDescriptor,
  PlannerParentContext,
  PromptPlannerAdapter,
  PlannerResponse,
  PlannerRuntime,
  PlannerRuntimeRequest,
  PlannerValidationError,
  PlannerValidationResult
} from "./contracts.js";
import { isRecord } from "./contracts.js";
import { buildRelevantContext, summarizeGraph } from "./graph-traversal.js";

export interface BuildPlannerRuntimeRequestOptions {
  requestId?: string;
  mode?: PlannerRuntimeRequest["mode"];
  goal?: string;
  allowedKinds?: PlannerOutputKind[];
  planner?: NodePlannerMetadata;
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

export interface ValidatePlannerResponseOptions {
  graph?: PlanGraphFile;
  parentId?: NodeId;
  allowedKinds?: PlannerOutputKind[];
  allowNestedChildren?: boolean;
}

export class PlannerResponseValidationError extends Error {
  validation: PlannerValidationResult;

  constructor(validation: PlannerValidationResult) {
    super(`Invalid planner response: ${formatPlannerValidationIssues(validation.errors)}`);
    this.name = "PlannerResponseValidationError";
    this.validation = validation;
  }
}

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
          acceptanceCriteria: { type: "array", items: { type: "string" } },
          children: { type: "array", items: { type: "object", additionalProperties: true } }
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
  const relevantContext = buildRelevantContext(graph, nodeId);

  return {
    requestId,
    mode: options.mode || "decompose",
    goal,
    nodeId,
    node,
    parentContext: buildPlannerParentContext(graph, nodeId, node, relevantContext),
    relevantContext,
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
  node: GraphNode = graph.graph.nodes[nodeId] || {},
  relevantContext = buildRelevantContext(graph, nodeId)
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
    relevantContext,
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
    relevantContextJson: JSON.stringify(request.relevantContext || request.parentContext?.relevantContext || null, null, 2),
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
      const validation = validatePlannerResponse(response, { allowedKinds: request.allowedKinds });
      if (!validation.valid) {
        throw new PlannerResponseValidationError(validation);
      }
      return {
        requestId: request.requestId,
        response: clonePlannerResponse({
          ...response,
          requestId: response.requestId || request.requestId
        }),
        validation,
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
      const validation = validatePlannerResponse(response, { allowedKinds: request.allowedKinds });
      if (!validation.valid) {
        throw new PlannerResponseValidationError(validation);
      }
      return {
        requestId: request.requestId,
        response: {
          ...response,
          requestId: response.requestId || request.requestId
        },
        validation,
        rawText,
        prompt,
        planner: request.planner || options.planner
      };
    }
  };
}

export function parsePlannerResponse(rawText: string): PlannerResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonObject(rawText));
  } catch {
    throw new PlannerResponseValidationError({
      valid: false,
      errors: [{
        path: "$",
        code: "malformed-json",
        message: "Planner response must be valid JSON.",
        severity: "error"
      }]
    });
  }
  const validation = validatePlannerResponse(parsed);
  if (!validation.valid) {
    throw new PlannerResponseValidationError(validation);
  }
  return parsed as PlannerResponse;
}

export function validatePlannerResponse(
  value: unknown,
  options: ValidatePlannerResponseOptions = {}
): PlannerValidationResult {
  const errors: PlannerValidationError[] = [];
  const warnings: PlannerValidationError[] = [];

  if (!isRecord(value)) {
    errors.push({
      path: "$",
      code: "invalid-response",
      message: "Planner response must be a JSON object.",
      severity: "error"
    });
    return { valid: false, errors, warnings };
  }

  const response = value as Record<string, unknown>;
  const allowedKinds = new Set(options.allowedKinds || ["task", "series", "parallel"]);
  if (!isPlannerOutputKind(response.kind)) {
    errors.push({
      path: "$.kind",
      code: "unknown-kind",
      message: "Planner response kind must be one of: task, series, parallel.",
      severity: "error"
    });
  } else if (!allowedKinds.has(response.kind)) {
    errors.push({
      path: "$.kind",
      code: "disallowed-kind",
      message: `Planner response kind is not allowed for this request: ${response.kind}.`,
      severity: "error"
    });
  }

  validateNonEmptyString(response.title, "$.title", "title", errors);
  validateOptionalString(response.description, "$.description", "description", errors);
  validateStringArray(response.deliverables, "$.deliverables", "deliverables", errors);
  validateStringArray(response.acceptanceCriteria, "$.acceptanceCriteria", "acceptance criteria", errors);

  if (response.children !== undefined && !Array.isArray(response.children)) {
    errors.push({
      path: "$.children",
      code: "invalid-children",
      message: "Planner response children must be an array.",
      severity: "error"
    });
  }

  if (response.kind === "series" || response.kind === "parallel") {
    if (!Array.isArray(response.children) || response.children.length === 0) {
      errors.push({
        path: "$.children",
        code: "missing-children",
        message: `${response.kind} planner responses must include at least one child.`,
        severity: "error"
      });
    }
  } else if (response.kind === "task" && Array.isArray(response.children) && response.children.length > 0) {
    errors.push({
      path: "$.children",
      code: "unexpected-children",
      message: "task planner responses must not include child proposals.",
      severity: "error"
    });
  }

  if (Array.isArray(response.children)) {
    validatePlannerChildren(response.children, errors, {
      graph: options.graph,
      parentId: options.parentId || "NODE",
      allowNestedChildren: options.allowNestedChildren ?? true
    });
  }

  return { valid: errors.length === 0, errors, warnings };
}

export function plannerResponseToDecomposeMutation(
  response: PlannerResponse,
  graph: PlanGraphFile,
  parentId: NodeId,
  options: ValidatePlannerResponseOptions = {}
): PlannerDecomposeMutation | undefined {
  const validation = validatePlannerResponse(response, {
    ...options,
    graph,
    parentId,
    allowNestedChildren: options.allowNestedChildren ?? false
  });
  if (!validation.valid) {
    throw new PlannerResponseValidationError(validation);
  }
  if (response.kind === "task") {
    return undefined;
  }
  return {
    kind: response.kind,
    children: materializePlannerChildren(response.children, graph, parentId)
  };
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
  return validatePlannerResponse(value).valid;
}

function isPlannerOutputKind(value: unknown): value is PlannerOutputKind {
  return value === "task" || value === "series" || value === "parallel";
}

interface ValidatePlannerChildrenContext {
  graph?: PlanGraphFile;
  parentId: NodeId;
  allowNestedChildren: boolean;
}

interface PlannerChildIdValidationContext {
  existingIds: Set<NodeId>;
  explicitIdPaths: Map<NodeId, string>;
}

interface PlannerChildTreeValidationContext {
  allowNestedChildren: boolean;
  usedIds: Set<NodeId>;
  materializedIdPaths: Map<NodeId, string>;
}

function validatePlannerChildren(
  children: unknown[],
  errors: PlannerValidationError[],
  context: ValidatePlannerChildrenContext
): void {
  const explicitIdContext: PlannerChildIdValidationContext = {
    existingIds: new Set(Object.keys(context.graph?.graph.nodes || {})),
    explicitIdPaths: new Map()
  };
  collectExplicitPlannerChildIds(children, "$.children", errors, explicitIdContext);

  const usedIds = new Set<NodeId>([
    ...explicitIdContext.existingIds,
    ...explicitIdContext.explicitIdPaths.keys()
  ]);
  validatePlannerChildTree(children, "$.children", context.parentId, errors, {
    allowNestedChildren: context.allowNestedChildren,
    usedIds,
    materializedIdPaths: new Map()
  });
}

function collectExplicitPlannerChildIds(
  children: unknown[],
  path: string,
  errors: PlannerValidationError[],
  context: PlannerChildIdValidationContext
): void {
  children.forEach((child, index) => {
    const childPath = `${path}[${index}]`;
    if (!isRecord(child)) {
      return;
    }
    if (child.id !== undefined && typeof child.id !== "string") {
      return;
    }
    if (typeof child.id === "string") {
      const id = child.id.trim();
      validateSafePlannerId(id, `${childPath}.id`, errors);
      if (id && isSafePlannerId(id)) {
        if (context.existingIds.has(id)) {
          errors.push({
            path: `${childPath}.id`,
            code: "duplicate-child-id",
            message: `Child id already exists in graph.nodes: ${id}.`,
            severity: "error"
          });
        } else {
          const firstPath = context.explicitIdPaths.get(id);
          if (firstPath) {
            errors.push({
              path: `${childPath}.id`,
              code: "duplicate-child-id",
              message: `Duplicate child id: ${id} (first seen at ${firstPath}).`,
              severity: "error"
            });
          } else {
            context.explicitIdPaths.set(id, `${childPath}.id`);
          }
        }
      }
    }
    if (Array.isArray(child.children)) {
      collectExplicitPlannerChildIds(child.children, `${childPath}.children`, errors, context);
    }
  });
}

function validatePlannerChildTree(
  children: unknown[],
  path: string,
  parentId: NodeId,
  errors: PlannerValidationError[],
  context: PlannerChildTreeValidationContext
): void {
  children.forEach((child, index) => {
    const childPath = `${path}[${index}]`;
    if (!isRecord(child)) {
      errors.push({
        path: childPath,
        code: "invalid-child",
        message: "Planner child proposal must be an object.",
        severity: "error"
      });
      return;
    }

    validateNonEmptyString(child.title, `${childPath}.title`, "child title", errors);
    validateOptionalString(child.description, `${childPath}.description`, "child description", errors);
    validateStringArray(child.deliverables, `${childPath}.deliverables`, "child deliverables", errors);
    validateStringArray(child.acceptanceCriteria, `${childPath}.acceptanceCriteria`, "child acceptance criteria", errors);

    if (child.kind !== undefined && !isPlannerOutputKind(child.kind)) {
      errors.push({
        path: `${childPath}.kind`,
        code: "unknown-kind",
        message: "Planner child kind must be one of: task, series, parallel.",
        severity: "error"
      });
    }
    if (child.id !== undefined && typeof child.id !== "string") {
      errors.push({
        path: `${childPath}.id`,
        code: "invalid-id",
        message: "Planner child id must be a string.",
        severity: "error"
      });
    }
    if (child.idHint !== undefined && typeof child.idHint !== "string") {
      errors.push({
        path: `${childPath}.idHint`,
        code: "invalid-id-hint",
        message: "Planner child idHint must be a string.",
        severity: "error"
      });
    }
    if (child.children !== undefined && !Array.isArray(child.children)) {
      errors.push({
        path: `${childPath}.children`,
        code: "invalid-children",
        message: "Planner child children must be an array of child proposals.",
        severity: "error"
      });
    }

    const materializedId = materializePlannerChildId(child as PlannerChildProposal, index, context.usedIds, parentId);
    if (materializedId) {
      const firstPath = context.materializedIdPaths.get(materializedId);
      if (firstPath) {
        errors.push({
          path: `${childPath}.id`,
          code: "duplicate-child-id",
          message: `Duplicate child id: ${materializedId} (first seen at ${firstPath}).`,
          severity: "error"
        });
      } else {
        context.materializedIdPaths.set(materializedId, child.id === undefined ? childPath : `${childPath}.id`);
        context.usedIds.add(materializedId);
      }
    }

    const nestedChildren = Array.isArray(child.children) ? child.children : undefined;
    if (child.kind === "series" || child.kind === "parallel") {
      if (!nestedChildren || nestedChildren.length === 0) {
        errors.push({
          path: `${childPath}.children`,
          code: "missing-children",
          message: `${child.kind} planner child proposals must include at least one child.`,
          severity: "error"
        });
      } else if (!context.allowNestedChildren) {
        errors.push({
          path: `${childPath}.children`,
          code: "unsupported-nested-children",
          message: "Nested planner child proposals are not supported for node decomposition.",
          severity: "error"
        });
      } else {
        validatePlannerChildTree(nestedChildren, `${childPath}.children`, materializedId || parentId, errors, context);
      }
    } else if (nestedChildren) {
      errors.push({
        path: `${childPath}.children`,
        code: "unsupported-nested-children",
        message: "Nested planner child proposals require kind series or parallel.",
        severity: "error"
      });
    }
  });
}

function materializePlannerChildren(
  children: PlannerChildProposal[],
  graph: PlanGraphFile,
  parentId: NodeId
): PlannerDecomposeChildSpec[] {
  const usedIds = new Set(Object.keys(graph.graph.nodes));
  const materialized: PlannerDecomposeChildSpec[] = [];
  for (const [index, child] of children.entries()) {
    const id = materializePlannerChildId(child, index, usedIds, parentId);
    if (!id) {
      throw new Error(`Unable to materialize child id at $.children[${index}]`);
    }
    usedIds.add(id);
    const { id: _id, idHint: _idHint, kind, title, children: _children, ...metadata } = child;
    materialized.push({
      ...metadata,
      id,
      title: title.trim(),
      kind: kind || "task"
    });
  }
  return materialized;
}

function materializePlannerChildId(
  child: PlannerChildProposal,
  index: number,
  usedIds: ReadonlySet<NodeId>,
  parentId: NodeId = "NODE"
): NodeId | undefined {
  if (typeof child.id === "string") {
    return child.id.trim();
  }
  const parentPrefix = slugIdPart(parentId) || "NODE";
  const childBase = slugIdPart(child.idHint || child.title) || `CHILD_${index + 1}`;
  const base = `${parentPrefix}_${childBase}`.slice(0, 96).replaceAll(/_+$/g, "");
  let candidate = base || `${parentPrefix}_CHILD_${index + 1}`;
  let suffix = 2;
  while (usedIds.has(candidate)) {
    const suffixText = `_${suffix}`;
    candidate = `${base.slice(0, Math.max(1, 128 - suffixText.length))}${suffixText}`;
    suffix += 1;
  }
  return candidate;
}

function validateNonEmptyString(
  value: unknown,
  path: string,
  label: string,
  errors: PlannerValidationError[]
): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push({
      path,
      code: "invalid-string",
      message: `Planner ${label} must be a non-empty string.`,
      severity: "error"
    });
  }
}

function validateOptionalString(
  value: unknown,
  path: string,
  label: string,
  errors: PlannerValidationError[]
): void {
  if (value !== undefined && typeof value !== "string") {
    errors.push({
      path,
      code: "invalid-string",
      message: `Planner ${label} must be a string.`,
      severity: "error"
    });
  }
}

function validateStringArray(
  value: unknown,
  path: string,
  label: string,
  errors: PlannerValidationError[]
): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    errors.push({
      path,
      code: "invalid-array",
      message: `Planner ${label} must be an array of non-empty strings.`,
      severity: "error"
    });
    return;
  }
  value.forEach((item, index) => {
    if (typeof item !== "string" || item.trim().length === 0) {
      errors.push({
        path: `${path}[${index}]`,
        code: "invalid-string",
        message: `Planner ${label} entries must be non-empty strings.`,
        severity: "error"
      });
    }
  });
}

function validateSafePlannerId(id: string, path: string, errors: PlannerValidationError[]): void {
  if (!id) {
    errors.push({
      path,
      code: "unsafe-id",
      message: "Planner child id must be non-empty.",
      severity: "error"
    });
    return;
  }
  if (!isSafePlannerId(id)) {
    errors.push({
      path,
      code: "unsafe-id",
      message: `Planner child id contains unsafe characters: ${id}.`,
      severity: "error"
    });
  }
}

function isSafePlannerId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) && !id.includes("..");
}

function slugIdPart(value: unknown): string {
  return String(value || "")
    .normalize("NFKD")
    .replaceAll(/[^A-Za-z0-9]+/g, "_")
    .replaceAll(/^_+|_+$/g, "")
    .replaceAll(/_+/g, "_")
    .toUpperCase()
    .slice(0, 64);
}

function formatPlannerValidationIssues(errors: PlannerValidationError[] | GraphValidationIssue[]): string {
  return errors.map((issue) => `${issue.path} ${issue.message}`).join("; ");
}
