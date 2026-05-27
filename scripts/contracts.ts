import type { ChildProcess } from "node:child_process";
import type { Server, ServerResponse } from "node:http";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;

export interface JsonObject {
  [key: string]: JsonValue | undefined;
}

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

const knownNodeStatusValues: ReadonlySet<string> = new Set(knownNodeStatuses);

export const knownNodeKinds = ["task", "series", "parallel", "gate"] as const;

export type KnownNodeKind = typeof knownNodeKinds[number];
export type NodeKind = KnownNodeKind | (string & {});

const knownNodeKindValues: ReadonlySet<string> = new Set(knownNodeKinds);

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

export type NodeBaseRefSource =
  | "explicit"
  | "graph-default"
  | "parent-base"
  | "series-predecessor"
  | "parent-output"
  | (string & {});

export interface NodeBaseRefMetadata {
  name: string;
  commit?: string;
  source?: NodeBaseRefSource;
  resolvedAt?: IsoDateString;
  [metadata: string]: unknown;
}

export interface NodeWorkRefMetadata {
  name: string;
  commit?: string;
  runId?: string;
  session?: string;
  createdAt?: IsoDateString;
  [metadata: string]: unknown;
}

export interface NodeOutputRefMetadata {
  name: string;
  commit?: string;
  runId?: string;
  session?: string;
  report?: string;
  producedAt?: IsoDateString;
  [metadata: string]: unknown;
}

export interface NodeIntegrationInputRefMetadata {
  nodeId: NodeId;
  outputRef: string;
  [metadata: string]: unknown;
}

export type NodeIntegrationRefKind = "series" | "parallel" | (string & {});
export type NodeIntegrationRefStatus = "pending" | "clean" | "conflicted" | (string & {});

export interface NodeIntegrationRefMetadata {
  name: string;
  kind?: NodeIntegrationRefKind;
  status?: NodeIntegrationRefStatus;
  inputRefs?: NodeIntegrationInputRefMetadata[];
  publishedOutputRef?: string;
  [metadata: string]: unknown;
}

export interface NodeWorkspaceMetadata {
  remote?: string;
  bareRepo?: string;
  cloneCwd: string;
  runId?: string;
  session?: string;
  preparedAt?: IsoDateString;
  retained?: boolean;
  [metadata: string]: unknown;
}

export interface WorkerRunRefMetadata {
  remote?: string;
  bareRepo?: string;
  cloneCwd?: string;
  baseRef?: NodeBaseRefMetadata;
  workRef?: NodeWorkRefMetadata;
  outputRef?: NodeOutputRefMetadata;
  integrationResult?: string;
  retained?: boolean;
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
  baseRef?: NodeBaseRefMetadata;
  workRef?: NodeWorkRefMetadata;
  outputRef?: NodeOutputRefMetadata;
  integrationRef?: NodeIntegrationRefMetadata;
  workspace?: NodeWorkspaceMetadata;
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
  remote?: string;
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

export interface GraphLockOwnerMetadata {
  lockVersion?: number;
  ownerId?: string;
  pid: number;
  host?: string;
  createdAt: IsoDateString;
  updatedAt?: IsoDateString;
  graphPath: string;
}

export interface GraphLockDiagnostics {
  path: string;
  exists: boolean;
  staleMs: number;
  ageMs?: number;
  stale: boolean;
  owner?: GraphLockOwnerMetadata;
  nextSteps: string[];
}

export type DiagnosticRemediationCategory =
  | "expired-lease"
  | "parked-expired-lease"
  | "blocked-work"
  | "failed-node"
  | "stale-lock"
  | "active-lock"
  | "no-ready"
  | "ready-work"
  | "isolation-active-worker"
  | "missing-output-ref"
  | "unresolved-buffer-conflict";

export type DiagnosticRemediationSeverity = "info" | "warning" | "critical";

export interface DiagnosticRemediationCommand {
  command: string;
  description: string;
  safeToRun: boolean;
  prerequisites?: string[];
}

export interface DiagnosticRemediation {
  category: DiagnosticRemediationCategory;
  severity: DiagnosticRemediationSeverity;
  summary: string;
  nodeId?: NodeId;
  commands: DiagnosticRemediationCommand[];
  prerequisites?: string[];
  notes?: string[];
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
  isolation?: NodeIsolationDetails;
}

export interface DiagnosticNode extends WorkingNode {
  expired?: boolean;
  releasable?: boolean;
  blockedReason?: string;
  failureReason?: string;
  nextStep?: string;
  remediation?: DiagnosticRemediation;
}

export interface NodeIsolationDetails {
  remote?: string;
  bareRepo?: string;
  cloneCwd?: string;
  baseRef?: string;
  baseCommit?: string;
  workRef?: string;
  outputRef?: string;
  outputCommit?: string;
  integrationRef?: string;
  integrationStatus?: string;
  publishedOutputRef?: string;
  mergeRefs?: NodeIntegrationInputRefMetadata[];
  conflictedMergeRefs?: NodeIntegrationInputRefMetadata[];
  missingOutputRef?: boolean;
  unresolvedBufferConflict?: boolean;
}

export interface GraphDiagnostics {
  generatedAt: IsoDateString;
  graphPath?: string;
  summary: GraphSummary;
  nextReady: ReadyNode[];
  leases: {
    active: DiagnosticNode[];
    expired: DiagnosticNode[];
  };
  blocked: DiagnosticNode[];
  failed: DiagnosticNode[];
  isolation: {
    activeWorkers: DiagnosticNode[];
    missingOutputRefs: DiagnosticNode[];
    unresolvedBufferConflicts: DiagnosticNode[];
  };
  lock?: GraphLockDiagnostics;
  actions: string[];
  remediation: DiagnosticRemediation[];
}

export interface OperationalEventExportEntry {
  at: IsoDateString;
  event: string;
  nodeId: NodeId;
  status?: NodeStatus;
  session?: string;
  runId?: string;
  timestamps: JsonObject;
  details: JsonObject;
}

export interface LeaseClaimResult {
  nodeId: NodeId;
  title?: string;
  runId: string;
  lease: GraphLease;
  baseRef?: NodeBaseRefMetadata;
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
  truncated?: boolean;
  originalLength?: number;
  originalBytes?: number;
}

export type ManagedWorkerStatus = "running" | "stopping" | "exited" | "error" | (string & {});

export interface PublicWorker {
  id: string;
  session: string;
  pid?: number;
  status: ManagedWorkerStatus;
  cwd?: string;
  isolation?: "off" | "git";
  remote?: string;
  workspaceRoot?: string;
  workspaceRetention?: "on-failure" | "always" | "never";
  startedAt: IsoDateString;
  finishedAt?: IsoDateString;
  stoppingAt?: IsoDateString;
  durationMs: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | string | null;
  error?: string;
  recentFailureReason?: string;
  logTail: WorkerLogEntry[];
}

export interface ManagedWorker extends PublicWorker {
  command: string;
  args: string[];
  child?: ChildProcess;
}

export interface WorkerManagerProcess {
  id: string;
  session: string;
  pid?: number;
  status: "running" | "stopping" | "exited" | "error";
  cwd: string;
  isolation?: "off" | "git";
  remote?: string;
  workspaceRoot?: string;
  workspaceRetention?: "on-failure" | "always" | "never";
  startedAt: IsoDateString;
  finishedAt?: IsoDateString;
  stoppingAt?: IsoDateString;
  durationMs?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | string | null;
  error?: string;
  recentFailureReason?: string;
  command: string;
  args: string[];
  child?: ChildProcess;
  logTail: WorkerLogEntry[];
}

export interface WorkerManagerDefaults {
  cwd: string;
  sessionPrefix: string;
  codexCommand: string;
  isolation: "off" | "git";
  workspaceRoot: string;
  workspaceRetention: "on-failure" | "always" | "never";
}

export interface WorkerManagerStatus {
  defaults: WorkerManagerDefaults;
  running: number;
  stopping: number;
  exited: number;
  error: number;
  retainedWorkers: number;
  totalStarted: number;
  recentFailureReason?: string;
  workers: PublicWorker[];
}

export interface WorkerManager {
  startWorkers(options?: StartWorkerOptions): PublicWorker[];
  stopWorker(id: string): PublicWorker;
  stopAll(): PublicWorker[];
  status(): WorkerManagerStatus;
}

export interface VisualizerNodeRefs {
  baseRef?: Record<string, unknown>;
  workRef?: Record<string, unknown>;
  outputRef?: Record<string, unknown>;
  integrationRef?: Record<string, unknown>;
}

export interface VisualizerNodeTimestamps {
  startedAt?: IsoDateString;
  completedAt?: IsoDateString;
  blockedAt?: IsoDateString;
  answeredAt?: IsoDateString;
  failedAt?: IsoDateString;
  expiredAt?: IsoDateString;
}

export interface VisualizerNodeDetail {
  id: NodeId;
  title?: string;
  kind: NodeKind;
  status: NodeStatus;
  description?: string;
  children: NodeId[];
  deliverables: string[];
  acceptanceCriteria: string[];
  lease?: Record<string, unknown>;
  refs: VisualizerNodeRefs;
  workspace?: Record<string, unknown>;
  report?: string;
  question?: string;
  answer?: string;
  answeredBy?: string;
  blockedReason?: string;
  failureReason?: string;
  timestamps: VisualizerNodeTimestamps;
  history: Record<string, unknown>[];
  historyCount: number;
  historyLimit: number;
}

export interface VisualizerPayload {
  graph: PlanGraphFile;
  graphSvg: string;
  nodes: VisualizerNodeDetail[];
  nodeHistoryLimit: number;
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
  | "diagnostics"
  | "events"
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
  timeoutMs?: number | string;
  leaseSeconds?: number;
  templatePath?: string;
  nodeId?: NodeId;
  quiet?: boolean;
  once?: boolean;
  isolation?: "off" | "git" | (string & {});
  remote?: string;
  workspaceRoot?: string;
  workspaceRetention?: "on-failure" | "always" | "never" | (string & {});
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
  cwd?: string;
  startedAt: IsoDateString;
  finishedAt: IsoDateString;
  durationMs?: number;
  timedOut?: boolean;
  timeoutMs?: number;
  aborted?: boolean;
  abortReason?: string;
}

export interface WorkerOutcome extends Partial<NodeMutationResult> {
  nodeId: NodeId;
  runId: string;
  status: NodeStatus;
  code: number;
  signal?: NodeJS.Signals | string | null;
  report?: string;
  note?: string;
  slack?: SlackNotificationResult;
}

export interface RunWorkerResult {
  session: string;
  idle: boolean;
  results: WorkerOutcome[];
}

export type SlackNotificationResult =
  | { skipped: true; reason: string }
  | { sent: true }
  | { failed: true; reason: string };

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

export interface GraphValidationResult {
  errors: GraphValidationIssue[];
  warnings: GraphValidationIssue[];
}

export function isKnownNodeStatus(value: unknown): value is KnownNodeStatus {
  return typeof value === "string" && knownNodeStatusValues.has(value);
}

export function isKnownNodeKind(value: unknown): value is KnownNodeKind {
  return typeof value === "string" && knownNodeKindValues.has(value);
}

export function validatePlanGraphFileResult(value: unknown): GraphValidationResult {
  const errors: GraphValidationIssue[] = [];
  const warnings: GraphValidationIssue[] = [];

  if (!isRecord(value)) {
    return { errors: [{ path: "$", message: "Expected graph file to be an object" }], warnings };
  }

  if (!isRecord(value.graph)) {
    return { errors: [{ path: "$.graph", message: "Expected graph body to be an object" }], warnings };
  }

  const root = value.graph.root;
  const nodes = value.graph.nodes;
  if (typeof root !== "string" || root.length === 0) {
    errors.push({ path: "$.graph.root", message: "Expected root node id string" });
  }
  if (!isRecord(nodes)) {
    errors.push({ path: "$.graph.nodes", message: "Expected node map object" });
    return { errors, warnings };
  }
  if (typeof root === "string" && root.length > 0 && !isRecord(nodes[root])) {
    errors.push({ path: "$.graph.root", message: `Root node is not present in nodes: ${root}` });
  }

  for (const [nodeId, node] of Object.entries(nodes)) {
    const nodePath = graphNodePath(nodeId);
    if (!isRecord(node)) {
      errors.push({ path: nodePath, message: "Expected node to be an object" });
      continue;
    }

    if (node.kind !== undefined) {
      if (typeof node.kind !== "string") {
        warnings.push({ path: `${nodePath}.kind`, message: "Node kind should be a string" });
      } else if (!isKnownNodeKind(node.kind)) {
        warnings.push({ path: `${nodePath}.kind`, message: `Unknown node kind: ${node.kind}` });
      }
    }

    if (node.status !== undefined) {
      if (typeof node.status !== "string") {
        warnings.push({ path: `${nodePath}.status`, message: "Node status should be a string" });
      } else if (!isKnownNodeStatus(node.status)) {
        warnings.push({ path: `${nodePath}.status`, message: `Unknown node status: ${node.status}` });
      }
    }

    if (node.children !== undefined && !Array.isArray(node.children)) {
      errors.push({ path: `${nodePath}.children`, message: "Expected children to be an array of node id strings" });
    } else if (Array.isArray(node.children)) {
      const seenChildren = new Map<string, number>();
      for (const [childIndex, childId] of node.children.entries()) {
        const childPath = `${nodePath}.children[${childIndex}]`;
        if (typeof childId !== "string") {
          errors.push({ path: childPath, message: "Expected children to be an array of node id strings" });
          continue;
        }
        const firstIndex = seenChildren.get(childId);
        if (firstIndex !== undefined) {
          errors.push({
            path: childPath,
            message: `Duplicate child node id: ${childId} (first seen at ${nodePath}.children[${firstIndex}])`
          });
        } else {
          seenChildren.set(childId, childIndex);
        }
        if (!isRecord(nodes[childId])) {
          errors.push({ path: childPath, message: `Unknown child node id: ${childId}` });
        }
      }

      if (node.children.length > 0 && node.kind === "task") {
        warnings.push({
          path: `${nodePath}.kind`,
          message: "Task node has children; scheduler will traverse it as an ordered internal node"
        });
      }
      if (node.children.length > 0 && node.kind === "gate") {
        warnings.push({
          path: `${nodePath}.kind`,
          message: "Gate node has children; scheduler will traverse it as an ordered internal node"
        });
      }
    }

    if ((node.kind === "series" || node.kind === "parallel") && (!Array.isArray(node.children) || node.children.length === 0)) {
      errors.push({ path: `${nodePath}.children`, message: `${node.kind} node must define at least one child` });
    }

    validateLease(node.lease, `${nodePath}.lease`, errors, warnings, typeof node.status === "string" ? node.status : undefined);
    validateTimestampField(node.startedAt, `${nodePath}.startedAt`, errors);
    validateTimestampField(node.completedAt, `${nodePath}.completedAt`, errors);
    validateTimestampField(node.blockedAt, `${nodePath}.blockedAt`, errors);
    validateTimestampField(node.answeredAt, `${nodePath}.answeredAt`, errors);
    validateTimestampField(node.failedAt, `${nodePath}.failedAt`, errors);
    validateTimestampField(node.expiredAt, `${nodePath}.expiredAt`, errors);
    validateHistory(node.history, `${nodePath}.history`, errors);
  }

  if (errors.length === 0 && typeof root === "string" && root.length > 0 && isRecord(nodes[root])) {
    validateTopology(nodes, root, errors, warnings);
  }

  return { errors, warnings };
}

export function validatePlanGraphFile(value: unknown): GraphValidationIssue[] {
  return validatePlanGraphFileResult(value).errors;
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateTopology(
  nodes: Record<string, unknown>,
  root: string,
  errors: GraphValidationIssue[],
  warnings: GraphValidationIssue[]
): void {
  const reachable = new Set<string>();
  const visited = new Set<string>();
  const visiting = new Set<string>();

  function visit(nodeId: string, stack: string[], path: string, markReachable: boolean): void {
    if (markReachable) {
      reachable.add(nodeId);
    }
    if (visiting.has(nodeId)) {
      const cycleStart = stack.indexOf(nodeId);
      const cycle = [...stack.slice(Math.max(0, cycleStart)), nodeId].join(" -> ");
      errors.push({ path, message: `Cycle detected: ${cycle}` });
      return;
    }
    if (visited.has(nodeId)) {
      return;
    }

    const node = nodes[nodeId];
    if (!isRecord(node) || !Array.isArray(node.children)) {
      return;
    }

    visiting.add(nodeId);
    const nextStack = [...stack, nodeId];
    for (const [childIndex, childId] of node.children.entries()) {
      if (typeof childId !== "string" || !isRecord(nodes[childId])) {
        continue;
      }
      visit(childId, nextStack, `${graphNodePath(nodeId)}.children[${childIndex}]`, markReachable);
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
  }

  visit(root, [], "$.graph.root", true);

  for (const nodeId of Object.keys(nodes)) {
    if (!reachable.has(nodeId)) {
      warnings.push({ path: graphNodePath(nodeId), message: `Node is not reachable from root: ${root}` });
    }
    if (!visited.has(nodeId)) {
      visit(nodeId, [], graphNodePath(nodeId), false);
    }
  }
}

function validateLease(
  lease: unknown,
  path: string,
  errors: GraphValidationIssue[],
  warnings: GraphValidationIssue[],
  status: string | undefined
): void {
  if (lease === undefined) {
    return;
  }
  if (!isRecord(lease)) {
    errors.push({ path, message: "Expected lease to be an object" });
    return;
  }

  validateRequiredString(lease.session, `${path}.session`, "Expected lease session string", errors);
  validateRequiredString(lease.runId, `${path}.runId`, "Expected lease runId string", errors);
  validateTimestampField(lease.claimedAt, `${path}.claimedAt`, errors, true);
  validateTimestampField(lease.expiresAt, `${path}.expiresAt`, errors, true);
  validateTimestampField(lease.renewedAt, `${path}.renewedAt`, errors);

  const leaseCompatibleStatuses = new Set(["claimed", "running", "blocked", "review"]);
  if (status && !leaseCompatibleStatuses.has(status)) {
    warnings.push({ path, message: `Lease is attached to status ${status}; expected claimed, running, blocked, or review` });
  }
}

function validateHistory(history: unknown, path: string, errors: GraphValidationIssue[]): void {
  if (history === undefined) {
    return;
  }
  if (!Array.isArray(history)) {
    errors.push({ path, message: "Expected history to be an array" });
    return;
  }
  for (const [index, entry] of history.entries()) {
    const entryPath = `${path}[${index}]`;
    if (!isRecord(entry)) {
      errors.push({ path: entryPath, message: "Expected history entry to be an object" });
      continue;
    }
    validateTimestampField(entry.at, `${entryPath}.at`, errors, true);
    if (entry.event !== undefined && typeof entry.event !== "string") {
      errors.push({ path: `${entryPath}.event`, message: "Expected history event string" });
    }
  }
}

function validateRequiredString(value: unknown, path: string, message: string, errors: GraphValidationIssue[]): void {
  if (typeof value !== "string" || value.length === 0) {
    errors.push({ path, message });
  }
}

function validateTimestampField(
  value: unknown,
  path: string,
  errors: GraphValidationIssue[],
  required = false
): void {
  if (value === undefined) {
    if (required) {
      errors.push({ path, message: "Expected timestamp string" });
    }
    return;
  }
  if (typeof value !== "string" || !isTimestampString(value)) {
    errors.push({ path, message: "Expected timestamp string" });
  }
}

function isTimestampString(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function graphNodePath(nodeId: string): string {
  return `$.graph.nodes.${pathKey(nodeId)}`;
}

function pathKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(key) ? key : `[${JSON.stringify(key)}]`;
}
