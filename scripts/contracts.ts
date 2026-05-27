import type { ChildProcess } from "node:child_process";
import type { Server, ServerResponse } from "node:http";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue | undefined };

export const knownNodeStatuses = [
  "pending",
  "claimed",
  "running",
  "blocked",
  "review",
  "failed",
  "done"
] as const;

export const terminalNodeStatuses = ["done"] as const;
export const busyNodeStatuses = ["claimed", "running", "blocked", "review", "failed"] as const;
export const autoReleasableNodeStatuses = ["claimed", "running"] as const;

export type KnownNodeStatus = typeof knownNodeStatuses[number];
export type TerminalNodeStatus = typeof terminalNodeStatuses[number];
export type BusyNodeStatus = typeof busyNodeStatuses[number];
export type AutoReleasableNodeStatus = typeof autoReleasableNodeStatuses[number];
export type NodeStatus = KnownNodeStatus | (string & {});

export const knownNodeKinds = ["task", "series", "parallel", "gate"] as const;

export type KnownNodeKind = typeof knownNodeKinds[number];
export type NodeKind = KnownNodeKind | (string & {});

export type NodeId = string;
export type IsoDateString = string;

export interface GraphLease {
  session: string;
  runId: string;
  claimedAt: IsoDateString;
  expiresAt: IsoDateString;
  renewedAt?: IsoDateString;
  [metadata: string]: unknown;
}

export interface GraphHistoryEntry {
  at: IsoDateString;
  event: string;
  [metadata: string]: unknown;
}

export interface GraphNode {
  title?: string;
  kind?: NodeKind;
  status?: NodeStatus;
  children?: NodeId[];
  description?: string;
  deliverables?: string[];
  acceptanceCriteria?: string[];
  lease?: GraphLease;
  history?: GraphHistoryEntry[];
  startedAt?: IsoDateString;
  completedAt?: IsoDateString;
  blockedAt?: IsoDateString;
  blockedReason?: string;
  question?: string;
  answer?: string;
  answeredAt?: IsoDateString;
  answeredBy?: string;
  failedAt?: IsoDateString;
  failureReason?: string;
  expiredAt?: IsoDateString;
  report?: string;
  [metadata: string]: unknown;
}

export interface PlanGraphBody {
  root: NodeId;
  nodes: Record<NodeId, GraphNode>;
  [metadata: string]: unknown;
}

export interface SchedulerConfig {
  stateFile?: string;
  htmlView?: string;
  reportsDir?: string;
  leaseSeconds?: number;
  [metadata: string]: unknown;
}

export interface RendererNavItem {
  label: string;
  href: string;
}

export interface RendererMetaItem {
  label: string;
  value: string;
}

export interface RendererTable {
  heading: string;
  columns: string[];
  rows: string[][];
}

export interface RendererSection {
  heading: string;
  paragraphs?: string[];
  flow?: string;
  [metadata: string]: unknown;
}

export interface RendererCallout {
  type?: string;
  strong?: string;
  bodyHtml: string;
  [metadata: string]: unknown;
}

export interface RendererDocument {
  pageTitle?: string;
  nav?: RendererNavItem[];
  meta?: RendererMetaItem[];
  intro?: string[];
  notation?: RendererTable;
  sections?: RendererSection[];
  gates?: RendererTable;
  callouts?: RendererCallout[];
  [metadata: string]: unknown;
}

export interface PlanGraphFile {
  graphVersion?: number;
  title?: string;
  description?: string;
  statusModel?: string[];
  scheduler?: SchedulerConfig;
  graph: PlanGraphBody;
  document?: RendererDocument;
  [metadata: string]: unknown;
}

export interface GraphSummary {
  graphVersion?: number;
  title?: string;
  description?: string;
  totalNodes: number;
  root: NodeId;
  counts: Record<string, number>;
}

export interface ReadyNode {
  id: NodeId;
  title?: string;
  kind: NodeKind;
  status: NodeStatus;
  question?: string;
  answer?: string;
  answeredAt?: IsoDateString;
}

export interface WorkingNode extends ReadyNode {
  session?: string;
  runId?: string;
  claimedAt?: IsoDateString;
  expiresAt?: IsoDateString;
  report?: string;
}

export interface LeaseClaimResult {
  nodeId: NodeId;
  title?: string;
  runId: string;
  lease: GraphLease;
  releasedExpired: NodeId[];
  summary: GraphSummary;
}

export interface NodeMutationResult {
  nodeId: NodeId;
  status: NodeStatus;
  title?: string;
  summary: GraphSummary;
}

export interface AnswerNodeResult {
  nodeId: NodeId;
  status: "pending";
  answer: string;
  summary: GraphSummary;
}

export interface ReleaseExpiredLeasesResult {
  released: NodeId[];
  summary: GraphSummary;
}

export interface RenewLeaseResult {
  nodeId: NodeId;
  lease: GraphLease;
  summary: GraphSummary;
}

export interface ResetNodeResult {
  nodeId: NodeId;
  status: NodeStatus;
  resetAncestors: NodeId[];
  summary: GraphSummary;
}

export interface ResetSubtreeResult {
  nodeId: NodeId;
  resetNodes: NodeId[];
  summary: GraphSummary;
}

export interface ReconcileGraphResult {
  changed: NodeId[];
  summary: GraphSummary;
}

export interface DecomposeNodeResult {
  nodeId: NodeId;
  children: NodeId[];
  summary: GraphSummary;
}

export interface WorkerLogEntry {
  at: IsoDateString;
  stream: "stdout" | "stderr" | (string & {});
  text: string;
}

export type ManagedWorkerStatus = "running" | "stopping" | "exited" | "error" | (string & {});

export interface PublicWorker {
  id: string;
  session: string;
  pid?: number;
  status: ManagedWorkerStatus;
  cwd?: string;
  startedAt: IsoDateString;
  finishedAt?: IsoDateString;
  stoppingAt?: IsoDateString;
  exitCode?: number | null;
  signal?: NodeJS.Signals | string | null;
  error?: string;
  logTail: WorkerLogEntry[];
}

export interface ManagedWorker extends PublicWorker {
  command: string;
  args: string[];
  child?: ChildProcess;
}

export interface WorkerManagerDefaults {
  cwd: string;
  sessionPrefix: string;
  codexCommand: string;
}

export interface WorkerManagerStatus {
  defaults: WorkerManagerDefaults;
  workers: PublicWorker[];
}

export interface WorkerManager {
  startWorkers(options?: StartWorkerOptions): PublicWorker[];
  stopWorker(id: string): PublicWorker;
  stopAll(): PublicWorker[];
  status(): WorkerManagerStatus;
}

export interface VisualizerPayload {
  graph: PlanGraphFile;
  graphSvg: string;
  ready: ReadyNode[];
  working: WorkingNode[];
  summary: GraphSummary;
  workerManager: WorkerManagerStatus;
}

export interface VisualizerServerHandle {
  server: Server;
  url: string;
  securityWarning?: string;
  close(): Promise<void>;
}

export type VisualizerClient = ServerResponse;

export type CliCommand =
  | "ready"
  | "summary"
  | "claim"
  | "start"
  | "renew"
  | "reset"
  | "reset-subtree"
  | "reset-reachable"
  | "done"
  | "block"
  | "answer"
  | "fail"
  | "decompose"
  | "prompt"
  | "worker"
  | "reconcile"
  | "release-expired"
  | "serve"
  | "help";

export type ParsedArgValue = boolean | string | Array<boolean | string>;

export interface ParsedArgs {
  _: string[];
  [name: string]: ParsedArgValue;
}

export interface CliBaseOptions {
  graph?: string;
  session?: string;
  node?: string;
  run?: string;
  lease?: string | number;
}

export interface StartWorkerOptions {
  count?: number | string;
  sessionPrefix?: string;
  cwd?: string;
  codexCommand?: string;
  codexArgs?: string[];
  idleMs?: number | string;
  leaseSeconds?: number;
  templatePath?: string;
  nodeId?: NodeId;
  quiet?: boolean;
  once?: boolean;
}

export interface RunWorkerOptions extends StartWorkerOptions {
  session?: string;
  reportPath?: string;
  templatePath?: string;
  stream?: boolean;
}

export interface CodexRunResult {
  code: number;
  signal?: NodeJS.Signals | string | null;
  stdout: string;
  stderr: string;
  error?: string;
  command: string;
  args: string[];
  startedAt: IsoDateString;
  finishedAt: IsoDateString;
}

export interface WorkerOutcome extends Partial<NodeMutationResult> {
  nodeId: NodeId;
  runId: string;
  status: NodeStatus;
  code: number;
  note?: string;
  slack?: SlackNotificationResult;
}

export interface RunWorkerResult {
  session: string;
  idle: boolean;
  results: WorkerOutcome[];
}

export type SlackNotificationResult = { skipped: true; reason: string } | { sent: true };

export interface LayoutPoint {
  x: number;
  y: number;
}

export interface LayoutEdge {
  kind: "series" | "parallel" | "frame" | (string & {});
  points: LayoutPoint[];
}

export interface LayoutBox {
  id: NodeId;
  title: string;
  kind: NodeKind;
  status: NodeStatus;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutFrame extends LayoutBox {
  depth: number;
}

export interface PlanarLayout {
  width: number;
  height: number;
  input: LayoutPoint;
  output: LayoutPoint;
  boxes: LayoutBox[];
  frames: LayoutFrame[];
  edges: LayoutEdge[];
}

export interface LayoutOptions {
  nodeWidth?: number;
  nodeHeight?: number;
  portGap?: number;
  seriesGap?: number;
  parallelGap?: number;
  branchPad?: number;
  framePadX?: number;
  framePadTop?: number;
  framePadBottom?: number;
  margin?: number;
  layout?: PlanarLayout;
}

export interface GraphValidationIssue {
  path: string;
  message: string;
}

export function isKnownNodeStatus(value: unknown): value is KnownNodeStatus {
  return typeof value === "string" && (knownNodeStatuses as readonly string[]).includes(value);
}

export function isKnownNodeKind(value: unknown): value is KnownNodeKind {
  return typeof value === "string" && (knownNodeKinds as readonly string[]).includes(value);
}

export function validatePlanGraphFile(value: unknown): GraphValidationIssue[] {
  const issues: GraphValidationIssue[] = [];

  if (!isRecord(value)) {
    return [{ path: "$", message: "Expected graph file to be an object" }];
  }

  if (!isRecord(value.graph)) {
    return [{ path: "$.graph", message: "Expected graph body to be an object" }];
  }

  const root = value.graph.root;
  const nodes = value.graph.nodes;
  if (typeof root !== "string" || root.length === 0) {
    issues.push({ path: "$.graph.root", message: "Expected root node id string" });
  }
  if (!isRecord(nodes)) {
    issues.push({ path: "$.graph.nodes", message: "Expected node map object" });
    return issues;
  }
  if (typeof root === "string" && root.length > 0 && !isRecord(nodes[root])) {
    issues.push({ path: "$.graph.root", message: `Root node is not present in nodes: ${root}` });
  }

  for (const [nodeId, node] of Object.entries(nodes)) {
    if (!isRecord(node)) {
      issues.push({ path: `$.graph.nodes.${nodeId}`, message: "Expected node to be an object" });
      continue;
    }
    if (node.children !== undefined && !isStringArray(node.children)) {
      issues.push({ path: `$.graph.nodes.${nodeId}.children`, message: "Expected children to be an array of node id strings" });
      continue;
    }
    for (const childId of node.children ?? []) {
      if (!isRecord(nodes[childId])) {
        issues.push({ path: `$.graph.nodes.${nodeId}.children`, message: `Unknown child node id: ${childId}` });
      }
    }
  }

  return issues;
}

export function isPlanGraphFile(value: unknown): value is PlanGraphFile {
  return validatePlanGraphFile(value).length === 0;
}

export function assertPlanGraphFile(value: unknown): asserts value is PlanGraphFile {
  const issues = validatePlanGraphFile(value);
  if (issues.length > 0) {
    throw new Error(`Invalid graph file: ${issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
