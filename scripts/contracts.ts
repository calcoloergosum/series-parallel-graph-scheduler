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
  diffStat?: GitDiffStatMetadata;
  files?: GitFileFootprintMetadata[];
  collectedAt?: IsoDateString;
  [metadata: string]: unknown;
}

export interface GitRefFootprintMetadata {
  name?: string;
  commit?: string;
  [metadata: string]: unknown;
}

export interface GitDiffStatBaseMetadata {
  filesChanged: number;
  deletions: number;
  totalChanges: number;
  binaryFiles?: number;
  [metadata: string]: unknown;
}

export interface GitDiffStatInsertionsMetadata extends GitDiffStatBaseMetadata {
  insertions: number;
  additions?: number;
}

export interface GitDiffStatAdditionsMetadata extends GitDiffStatBaseMetadata {
  additions: number;
  insertions?: number;
}

export type GitDiffStatMetadata = GitDiffStatInsertionsMetadata | GitDiffStatAdditionsMetadata;

export type GitFileChangeType =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "typechange"
  | "unmerged"
  | "unknown"
  | (string & {});

export interface GitFileFootprintBaseMetadata {
  path: string;
  oldPath?: string;
  changeType?: GitFileChangeType;
  deletions: number | null;
  totalChanges: number | null;
  binary?: boolean;
  childIds?: NodeId[];
  [metadata: string]: unknown;
}

export type GitFootprintSource =
  | "git-diff"
  | "child-aggregate"
  | (string & {});

export interface GitFootprintAggregationMetadata {
  source: "child-footprints" | (string & {});
  parentId?: NodeId;
  parentKind?: NodeKind;
  childCount: number;
  includedChildIds: NodeId[];
  missingChildIds: NodeId[];
  duplicateFilePaths: string[];
  diffStatKind: "summed-child-stats" | (string & {});
  filesChangedKind: "unique-file-paths-with-stat-only-sum" | (string & {});
  fileMergeRule: "sum-line-counts-by-path" | (string & {});
  [metadata: string]: unknown;
}

export interface GitFileFootprintInsertionsMetadata extends GitFileFootprintBaseMetadata {
  insertions: number | null;
  additions?: number | null;
}

export interface GitFileFootprintAdditionsMetadata extends GitFileFootprintBaseMetadata {
  additions: number | null;
  insertions?: number | null;
}

export type GitFileFootprintMetadata = GitFileFootprintInsertionsMetadata | GitFileFootprintAdditionsMetadata;

export interface NodeGitFootprintMetadata {
  source?: GitFootprintSource;
  baseRef?: GitRefFootprintMetadata;
  headRef?: GitRefFootprintMetadata;
  branch?: string;
  commit?: string;
  diffStat?: GitDiffStatMetadata;
  files?: GitFileFootprintMetadata[];
  aggregation?: GitFootprintAggregationMetadata;
  childAggregate?: NodeGitFootprintMetadata;
  collectedAt?: IsoDateString;
  [metadata: string]: unknown;
}

export interface GitFootprintNodeSummary {
  nodeId: NodeId;
  title?: string;
  kind: NodeKind;
  status: NodeStatus;
  source?: GitFootprintSource;
  baseRef?: GitRefFootprintMetadata;
  headRef?: GitRefFootprintMetadata;
  branch?: string;
  commit?: string;
  diffStat?: GitDiffStatMetadata;
  changedFiles: GitFileFootprintMetadata[];
  collectedAt?: IsoDateString;
}

export interface GitFootprintRefSummary {
  baseRefs: GitRefFootprintMetadata[];
  headRefs: GitRefFootprintMetadata[];
  commits: string[];
}

export interface GitFootprintSummary {
  nodes: GitFootprintNodeSummary[];
  refs: GitFootprintRefSummary;
  diffStat: GitDiffStatMetadata;
  changedFiles: GitFileFootprintMetadata[];
}

export interface NodeGoalMetadata {
  text: string;
  source?: "operator" | "planner" | "parent" | (string & {});
  createdAt?: IsoDateString;
  [metadata: string]: unknown;
}

export interface NodePlannerMetadata {
  name?: string;
  model?: string;
  version?: string;
  promptRef?: string;
  requestId?: string;
  plannedAt?: IsoDateString;
  decision?: string;
  rationale?: string;
  decompositionReason?: string;
  [metadata: string]: unknown;
}

export interface NodeContextRefMetadata {
  type?: "file" | "url" | "node" | "report" | "git-ref" | (string & {});
  ref: string;
  title?: string;
  nodeId?: NodeId;
  [metadata: string]: unknown;
}

export interface NodeOutputContract {
  format?: "markdown" | "json" | "patch" | "text" | (string & {});
  requiredArtifacts?: string[];
  acceptanceCriteria?: string[];
  schemaRef?: string;
  [metadata: string]: unknown;
}

export interface NodeResultSummary {
  status?: "done" | "partial" | "blocked" | "failed" | (string & {});
  summary: string;
  artifacts?: string[];
  completedAt?: IsoDateString;
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
  gitFootprint?: NodeGitFootprintMetadata;
  gitFootprintWarning?: string;
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
  goal?: string | NodeGoalMetadata;
  planner?: NodePlannerMetadata;
  plannerDecision?: string;
  decompositionReason?: string;
  rationale?: string;
  contextRefs?: NodeContextRefMetadata[];
  resultSummary?: NodeResultSummary;
  outputContract?: NodeOutputContract;
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
  gitFootprint?: NodeGitFootprintMetadata;
  gitFootprintWarning?: string;
  workspace?: NodeWorkspaceMetadata;
  [metadata: string]: unknown;
}

export type PlannerOutputKind = "task" | "series" | "parallel";
export type PlannerRequestMode = "goal" | "decompose" | (string & {});
export type PlannerChildIdPolicy = "planner-deterministic" | "scheduler-generated";
export type PlannerValidationSeverity = "error" | "warning";

export interface PlannerRequest {
  requestId?: string;
  mode: PlannerRequestMode;
  goal: string;
  nodeId?: NodeId;
  node?: GraphNode;
  parentContext?: PlannerParentContext;
  currentGraphSummary?: GraphSummary;
  outputSchema?: PlannerOutputSchemaDescriptor;
  allowedKinds?: PlannerOutputKind[];
  contextRefs?: NodeContextRefMetadata[];
  outputContract?: NodeOutputContract;
  planner?: NodePlannerMetadata;
  [metadata: string]: unknown;
}

export interface PlannerParentContext {
  nodeId: NodeId;
  title?: string;
  kind?: NodeKind;
  status?: NodeStatus;
  description?: string;
  deliverables?: string[];
  acceptanceCriteria?: string[];
  goal?: string | NodeGoalMetadata;
  contextRefs?: NodeContextRefMetadata[];
  outputContract?: NodeOutputContract;
  parentIds?: NodeId[];
  [metadata: string]: unknown;
}

export interface PlannerOutputSchemaDescriptor {
  schemaRef?: string;
  description?: string;
  responseKinds?: PlannerOutputKind[];
  requiredFields?: string[];
  schema?: JsonObject;
  [metadata: string]: unknown;
}

export interface PlannerRuntimeRequest extends PlannerRequest {
  requestId: string;
  currentGraphSummary: GraphSummary;
  outputSchema: PlannerOutputSchemaDescriptor;
}

export interface PlannerRuntimeResponse {
  requestId: string;
  response: PlannerResponse;
  rawText?: string;
  prompt?: string;
  planner?: NodePlannerMetadata;
  validation?: PlannerValidationResult;
  decompose?: PlannerDecomposeMutation;
  [metadata: string]: unknown;
}

export interface PlannerRuntime {
  plan(request: PlannerRuntimeRequest): Promise<PlannerRuntimeResponse>;
}

export interface PromptPlannerAdapterRequest {
  prompt: string;
  request: PlannerRuntimeRequest;
}

export interface PromptPlannerAdapter {
  complete(request: PromptPlannerAdapterRequest): Promise<string>;
}

export type WorkerPlannerMode = "off" | "auto-decompose" | "ask-approval";
export type WorkerPlannerFailurePolicy = "block" | "fail";
export type WorkerPlannerAdapterMode = "none" | "injected" | "fixture" | "prompt";

export interface WorkerPlannerConfig {
  mode?: WorkerPlannerMode;
  failurePolicy?: WorkerPlannerFailurePolicy;
  adapterMode?: WorkerPlannerAdapterMode;
  fixturePath?: string;
  templatePath?: string;
  allowedKinds?: PlannerOutputKind[];
  requestIdPrefix?: string;
  planner?: NodePlannerMetadata;
  [metadata: string]: unknown;
}

export interface PlannerProposalBase {
  title: string;
  description?: string;
  deliverables?: string[];
  acceptanceCriteria?: string[];
  goal?: string | NodeGoalMetadata;
  planner?: NodePlannerMetadata;
  contextRefs?: NodeContextRefMetadata[];
  outputContract?: NodeOutputContract;
  [metadata: string]: unknown;
}

export interface PlannerChildProposal extends PlannerProposalBase {
  id?: NodeId;
  idHint?: string;
  kind?: PlannerOutputKind;
  children?: PlannerChildProposal[];
}

export interface PlannerResponseBase extends PlannerProposalBase {
  requestId?: string;
  kind: PlannerOutputKind;
  rationale?: string;
}

export interface PlannerTaskResponse extends PlannerResponseBase {
  kind: "task";
}

export interface PlannerCompositeResponse extends PlannerResponseBase {
  kind: "series" | "parallel";
  children: PlannerChildProposal[];
  childIdPolicy?: PlannerChildIdPolicy;
}

export type PlannerResponse = PlannerTaskResponse | PlannerCompositeResponse;

export interface PlannerDecomposeChildSpec extends PlannerProposalBase {
  id: NodeId;
  kind?: PlannerOutputKind;
  status?: NodeStatus;
  children?: NodeId[];
}

export interface PlannerDecomposeMutation {
  kind: "series" | "parallel";
  children: PlannerDecomposeChildSpec[];
}

export interface PlannerValidationError {
  path: string;
  message: string;
  code?: string;
  severity?: PlannerValidationSeverity;
  [metadata: string]: unknown;
}

export interface PlannerValidationResult {
  valid: boolean;
  errors: PlannerValidationError[];
  warnings?: PlannerValidationError[];
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
  workerPlanner?: WorkerPlannerConfig;
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

export type ReachableParentMap = Record<NodeId, NodeId[]>;
export type ReachableDepthMap = Record<NodeId, number>;
export type ReachablePathMap = Record<NodeId, NodeId[]>;

export interface ReadyNodePriorityFields {
  depth: number;
  child_count: number;
  shared_parent_count_with_current_task: number;
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
  depth?: number;
  child_count?: number;
  shared_parent_count_with_current_task?: number;
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
  gitFootprint?: NodeGitFootprintMetadata;
  gitDiffStat?: GitDiffStatMetadata;
  changedFiles?: GitFileFootprintMetadata[];
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
  gitFootprint?: NodeGitFootprintMetadata;
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
  gitFootprint?: GitFootprintSummary;
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

export interface VisualizerAttentionSummary {
  failed: {
    count: number;
    nodeIds: NodeId[];
  };
  blocked: {
    count: number;
    nodeIds: NodeId[];
  };
  expired: {
    count: number;
    nodeIds: NodeId[];
    releasable: number;
  };
  workerErrors: {
    count: number;
    workerIds: string[];
  };
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
  baseRef?: NodeBaseRefMetadata;
  workRef?: NodeWorkRefMetadata;
  outputRef?: NodeOutputRefMetadata;
  integrationRef?: NodeIntegrationRefMetadata;
  gitFootprint?: NodeGitFootprintMetadata;
}

export interface VisualizerGitRefDisplay {
  name?: string;
  commit?: string;
  display?: string;
}

export interface VisualizerGitChangedFileRow {
  path: string;
  oldPath?: string;
  changeType?: GitFileChangeType;
  insertions: number | null;
  deletions: number | null;
  totalChanges: number | null;
  binary: boolean;
  childIds?: NodeId[];
}

export interface VisualizerGitDiffStatDisplay {
  filesChanged: number;
  insertions: number;
  deletions: number;
  totalChanges: number;
  binaryFiles?: number;
}

export interface VisualizerWorkspaceDisplay {
  remote?: string;
  cloneCwd?: string;
  bareRepo?: string;
  retained?: boolean;
}

export interface VisualizerGitFootprintDetail {
  source?: GitFootprintSource;
  commit?: string;
  branch?: string;
  baseRef?: VisualizerGitRefDisplay;
  headRef?: VisualizerGitRefDisplay;
  workRef?: VisualizerGitRefDisplay;
  outputRef?: VisualizerGitRefDisplay;
  integrationRef?: {
    name?: string;
    status?: string;
    publishedOutputRef?: string;
  };
  diffStat?: VisualizerGitDiffStatDisplay;
  filesChanged?: number;
  insertions?: number;
  deletions?: number;
  totalChanges?: number;
  binaryFiles?: number;
  changedFiles: VisualizerGitChangedFileRow[];
  changedFilesTotal: number;
  changedFilesLimit: number;
  changedFilesTruncated: number;
  aggregation?: GitFootprintAggregationMetadata;
  collectedAt?: IsoDateString;
  remoteDisplay?: string;
  workspaceDisplay?: string;
  bareRepoDisplay?: string;
}

export interface VisualizerNodeTimestamps {
  startedAt?: IsoDateString;
  completedAt?: IsoDateString;
  blockedAt?: IsoDateString;
  answeredAt?: IsoDateString;
  failedAt?: IsoDateString;
  expiredAt?: IsoDateString;
}

export type VisualizerActionDanger = "none" | "caution" | "danger";

type VisualizerActionId =
  | "claim"
  | "start"
  | "renew"
  | "done"
  | "block"
  | "answer"
  | "fail"
  | "reset"
  | "reset-subtree"
  | "reset-reachable"
  | "decompose";

export interface VisualizerActionConfirmation {
  required: boolean;
  label: string;
  message: string;
}

export interface VisualizerNodeAction {
  id: VisualizerActionId;
  label: string;
  danger: VisualizerActionDanger;
  requiredFields: string[];
  disabledReason?: string;
  confirmation?: VisualizerActionConfirmation;
}

export interface VisualizerActionPolicy {
  leaseProtectedWorkerActions: {
    whenCredentialsAbsent: "disable-leased-node-actions";
    requiredCredential: "matching-session-or-runId";
  };
  destructiveActions: {
    danger: "danger";
    requireConfirmationMetadata: true;
  };
  serverAuthority: "scheduler-mutation-guards";
}

export interface VisualizerNodeDetail {
  id: NodeId;
  title?: string;
  kind: NodeKind;
  status: NodeStatus;
  description?: string;
  goal?: string | NodeGoalMetadata;
  goalText?: string;
  planner?: NodePlannerMetadata;
  plannerDecision?: string;
  decompositionReason?: string;
  contextRefs?: NodeContextRefMetadata[];
  outputContract?: NodeOutputContract;
  resultSummary?: NodeResultSummary;
  children: NodeId[];
  deliverables: string[];
  acceptanceCriteria: string[];
  lease?: GraphLease;
  refs: VisualizerNodeRefs;
  git?: VisualizerGitFootprintDetail;
  gitFootprint?: NodeGitFootprintMetadata;
  gitDiffStat?: GitDiffStatMetadata;
  changedFiles?: GitFileFootprintMetadata[];
  workspace?: NodeWorkspaceMetadata;
  workspaceDisplay?: VisualizerWorkspaceDisplay;
  report?: string;
  question?: string;
  answer?: string;
  answeredBy?: string;
  blockedReason?: string;
  failureReason?: string;
  timestamps: VisualizerNodeTimestamps;
  history: GraphHistoryEntry[];
  historyCount: number;
  historyLimit: number;
  actions: VisualizerNodeAction[];
}

export interface VisualizerPayload {
  graph: PlanGraphFile;
  graphSvg: string;
  nodes: VisualizerNodeDetail[];
  nodeHistoryLimit: number;
  actionPolicy: VisualizerActionPolicy;
  attention: VisualizerAttentionSummary;
  diagnostics: GraphDiagnostics;
  gitFootprint?: GitFootprintSummary;
  recentEvents: OperationalEventExportEntry[];
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
  | "plan"
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
  plannerMode?: WorkerPlannerMode | (string & {});
  plannerFailurePolicy?: WorkerPlannerFailurePolicy | (string & {});
  plannerAdapterMode?: WorkerPlannerAdapterMode | (string & {});
  plannerFixturePath?: string;
  plannerTemplatePath?: string;
  plannerAllowedKinds?: PlannerOutputKind[];
  plannerRequestIdPrefix?: string;
  planner?: PlannerRuntime;
  promptPlannerAdapter?: PromptPlannerAdapter;
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
  refLabel?: LayoutRefLabel;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutRefLabel {
  commit?: string;
  insertions?: string;
  deletions?: string;
  filesChanged?: string;
  fallback?: string;
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
    validatePlannerMetadata(node.planner, `${nodePath}.planner`, errors);
    validateContextRefs(node.contextRefs, `${nodePath}.contextRefs`, errors);
    validateOutputContract(node.outputContract, `${nodePath}.outputContract`, errors);
    validateResultSummary(node.resultSummary, `${nodePath}.resultSummary`, errors);
    validateGitFootprint(node.gitFootprint, `${nodePath}.gitFootprint`, errors);
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

function validatePlannerMetadata(planner: unknown, path: string, errors: GraphValidationIssue[]): void {
  if (planner === undefined) {
    return;
  }
  if (!isRecord(planner)) {
    errors.push({ path, message: "Expected planner metadata to be an object" });
    return;
  }
  validateOptionalString(planner.name, `${path}.name`, "Expected planner name string", errors);
  validateOptionalString(planner.model, `${path}.model`, "Expected planner model string", errors);
  validateOptionalString(planner.version, `${path}.version`, "Expected planner version string", errors);
  validateOptionalString(planner.promptRef, `${path}.promptRef`, "Expected planner promptRef string", errors);
  validateOptionalString(planner.requestId, `${path}.requestId`, "Expected planner requestId string", errors);
  validateTimestampField(planner.plannedAt, `${path}.plannedAt`, errors);
  validateOptionalString(planner.decision, `${path}.decision`, "Expected planner decision string", errors);
  validateOptionalString(planner.rationale, `${path}.rationale`, "Expected planner rationale string", errors);
  validateOptionalString(planner.decompositionReason, `${path}.decompositionReason`, "Expected planner decompositionReason string", errors);
}

function validateContextRefs(contextRefs: unknown, path: string, errors: GraphValidationIssue[]): void {
  if (contextRefs === undefined) {
    return;
  }
  if (!Array.isArray(contextRefs)) {
    errors.push({ path, message: "Expected contextRefs to be an array" });
    return;
  }
  for (const [index, contextRef] of contextRefs.entries()) {
    const entryPath = `${path}[${index}]`;
    if (!isRecord(contextRef)) {
      errors.push({ path: entryPath, message: "Expected contextRef to be an object" });
      continue;
    }
    validateOptionalString(contextRef.type, `${entryPath}.type`, "Expected contextRef type string", errors);
    validateRequiredString(contextRef.ref, `${entryPath}.ref`, "Expected contextRef ref string", errors);
    validateOptionalString(contextRef.title, `${entryPath}.title`, "Expected contextRef title string", errors);
    validateOptionalString(contextRef.nodeId, `${entryPath}.nodeId`, "Expected contextRef nodeId string", errors);
  }
}

function validateOutputContract(outputContract: unknown, path: string, errors: GraphValidationIssue[]): void {
  if (outputContract === undefined) {
    return;
  }
  if (!isRecord(outputContract)) {
    errors.push({ path, message: "Expected outputContract to be an object" });
    return;
  }
  validateOptionalString(outputContract.format, `${path}.format`, "Expected outputContract format string", errors);
  validateOptionalStringArray(outputContract.requiredArtifacts, `${path}.requiredArtifacts`, "Expected outputContract requiredArtifacts strings", errors);
  validateOptionalStringArray(outputContract.acceptanceCriteria, `${path}.acceptanceCriteria`, "Expected outputContract acceptanceCriteria strings", errors);
  validateOptionalString(outputContract.schemaRef, `${path}.schemaRef`, "Expected outputContract schemaRef string", errors);
}

function validateResultSummary(resultSummary: unknown, path: string, errors: GraphValidationIssue[]): void {
  if (resultSummary === undefined) {
    return;
  }
  if (!isRecord(resultSummary)) {
    errors.push({ path, message: "Expected resultSummary to be an object" });
    return;
  }
  validateOptionalString(resultSummary.status, `${path}.status`, "Expected resultSummary status string", errors);
  validateRequiredString(resultSummary.summary, `${path}.summary`, "Expected resultSummary summary string", errors);
  validateOptionalStringArray(resultSummary.artifacts, `${path}.artifacts`, "Expected resultSummary artifact strings", errors);
  validateTimestampField(resultSummary.completedAt, `${path}.completedAt`, errors);
}

function validateGitFootprint(gitFootprint: unknown, path: string, errors: GraphValidationIssue[]): void {
  if (gitFootprint === undefined) {
    return;
  }
  if (!isRecord(gitFootprint)) {
    errors.push({ path, message: "Expected gitFootprint to be an object" });
    return;
  }
  validateOptionalString(gitFootprint.source, `${path}.source`, "Expected gitFootprint source string", errors);
  validateGitFootprintRef(gitFootprint.baseRef, `${path}.baseRef`, errors);
  validateGitFootprintRef(gitFootprint.headRef, `${path}.headRef`, errors);
  validateOptionalString(gitFootprint.branch, `${path}.branch`, "Expected gitFootprint branch string", errors);
  validateOptionalString(gitFootprint.commit, `${path}.commit`, "Expected gitFootprint commit string", errors);
  validateGitDiffStat(gitFootprint.diffStat, `${path}.diffStat`, errors);
  validateGitFiles(gitFootprint.files, `${path}.files`, errors);
  validateGitFootprintAggregation(gitFootprint.aggregation, `${path}.aggregation`, errors);
  validateGitFootprint(gitFootprint.childAggregate, `${path}.childAggregate`, errors);
  validateTimestampField(gitFootprint.collectedAt, `${path}.collectedAt`, errors);
}

function validateGitFootprintRef(ref: unknown, path: string, errors: GraphValidationIssue[]): void {
  if (ref === undefined) {
    return;
  }
  if (!isRecord(ref)) {
    errors.push({ path, message: "Expected git ref footprint to be an object" });
    return;
  }
  validateOptionalString(ref.name, `${path}.name`, "Expected git ref name string", errors);
  validateOptionalString(ref.commit, `${path}.commit`, "Expected git ref commit string", errors);
}

function validateGitDiffStat(diffStat: unknown, path: string, errors: GraphValidationIssue[]): void {
  if (diffStat === undefined) {
    return;
  }
  if (!isRecord(diffStat)) {
    errors.push({ path, message: "Expected git diffStat to be an object" });
    return;
  }
  validateRequiredNumber(diffStat.filesChanged, `${path}.filesChanged`, "Expected git diffStat filesChanged number", errors);
  if (diffStat.insertions === undefined && diffStat.additions === undefined) {
    errors.push({ path, message: "Expected git diffStat insertions or additions number" });
  }
  validateOptionalNumber(diffStat.insertions, `${path}.insertions`, "Expected git diffStat insertions number", errors);
  validateOptionalNumber(diffStat.additions, `${path}.additions`, "Expected git diffStat additions number", errors);
  validateRequiredNumber(diffStat.deletions, `${path}.deletions`, "Expected git diffStat deletions number", errors);
  validateRequiredNumber(diffStat.totalChanges, `${path}.totalChanges`, "Expected git diffStat totalChanges number", errors);
  validateOptionalNumber(diffStat.binaryFiles, `${path}.binaryFiles`, "Expected git diffStat binaryFiles number", errors);
}

function validateGitFiles(files: unknown, path: string, errors: GraphValidationIssue[]): void {
  if (files === undefined) {
    return;
  }
  if (!Array.isArray(files)) {
    errors.push({ path, message: "Expected git files to be an array" });
    return;
  }
  for (const [index, file] of files.entries()) {
    const filePath = `${path}[${index}]`;
    if (!isRecord(file)) {
      errors.push({ path: filePath, message: "Expected git file footprint to be an object" });
      continue;
    }
    validateRequiredString(file.path, `${filePath}.path`, "Expected git file path string", errors);
    validateOptionalString(file.oldPath, `${filePath}.oldPath`, "Expected git file oldPath string", errors);
    validateOptionalString(file.changeType, `${filePath}.changeType`, "Expected git file changeType string", errors);
    if (file.insertions === undefined && file.additions === undefined) {
      errors.push({ path: filePath, message: "Expected git file insertions or additions number" });
    }
    validateOptionalNullableNumber(file.insertions, `${filePath}.insertions`, "Expected git file insertions number or null", errors);
    validateOptionalNullableNumber(file.additions, `${filePath}.additions`, "Expected git file additions number or null", errors);
    validateRequiredNullableNumber(file.deletions, `${filePath}.deletions`, "Expected git file deletions number or null", errors);
    validateRequiredNullableNumber(file.totalChanges, `${filePath}.totalChanges`, "Expected git file totalChanges number or null", errors);
    if (file.binary !== undefined && typeof file.binary !== "boolean") {
      errors.push({ path: `${filePath}.binary`, message: "Expected git file binary boolean" });
    }
    validateOptionalStringArray(file.childIds, `${filePath}.childIds`, "Expected git file childIds strings", errors);
  }
}

function validateGitFootprintAggregation(aggregation: unknown, path: string, errors: GraphValidationIssue[]): void {
  if (aggregation === undefined) {
    return;
  }
  if (!isRecord(aggregation)) {
    errors.push({ path, message: "Expected gitFootprint aggregation to be an object" });
    return;
  }
  validateRequiredString(aggregation.source, `${path}.source`, "Expected gitFootprint aggregation source string", errors);
  validateOptionalString(aggregation.parentId, `${path}.parentId`, "Expected gitFootprint aggregation parentId string", errors);
  validateOptionalString(aggregation.parentKind, `${path}.parentKind`, "Expected gitFootprint aggregation parentKind string", errors);
  validateRequiredNumber(aggregation.childCount, `${path}.childCount`, "Expected gitFootprint aggregation childCount number", errors);
  validateRequiredStringArray(aggregation.includedChildIds, `${path}.includedChildIds`, "Expected gitFootprint aggregation includedChildIds strings", errors);
  validateRequiredStringArray(aggregation.missingChildIds, `${path}.missingChildIds`, "Expected gitFootprint aggregation missingChildIds strings", errors);
  validateRequiredStringArray(aggregation.duplicateFilePaths, `${path}.duplicateFilePaths`, "Expected gitFootprint aggregation duplicateFilePaths strings", errors);
  validateRequiredString(aggregation.diffStatKind, `${path}.diffStatKind`, "Expected gitFootprint aggregation diffStatKind string", errors);
  validateRequiredString(aggregation.filesChangedKind, `${path}.filesChangedKind`, "Expected gitFootprint aggregation filesChangedKind string", errors);
  validateRequiredString(aggregation.fileMergeRule, `${path}.fileMergeRule`, "Expected gitFootprint aggregation fileMergeRule string", errors);
}

function validateRequiredString(value: unknown, path: string, message: string, errors: GraphValidationIssue[]): void {
  if (typeof value !== "string" || value.length === 0) {
    errors.push({ path, message });
  }
}

function validateOptionalString(value: unknown, path: string, message: string, errors: GraphValidationIssue[]): void {
  if (value !== undefined && typeof value !== "string") {
    errors.push({ path, message });
  }
}

function validateRequiredNumber(value: unknown, path: string, message: string, errors: GraphValidationIssue[]): void {
  if (typeof value !== "number") {
    errors.push({ path, message });
  }
}

function validateOptionalNumber(value: unknown, path: string, message: string, errors: GraphValidationIssue[]): void {
  if (value !== undefined && typeof value !== "number") {
    errors.push({ path, message });
  }
}

function validateRequiredNullableNumber(value: unknown, path: string, message: string, errors: GraphValidationIssue[]): void {
  if (typeof value !== "number" && value !== null) {
    errors.push({ path, message });
  }
}

function validateOptionalNullableNumber(value: unknown, path: string, message: string, errors: GraphValidationIssue[]): void {
  if (value !== undefined && typeof value !== "number" && value !== null) {
    errors.push({ path, message });
  }
}

function validateRequiredStringArray(value: unknown, path: string, message: string, errors: GraphValidationIssue[]): void {
  if (!Array.isArray(value)) {
    errors.push({ path, message });
    return;
  }
  validateStringArrayItems(value, path, message, errors);
}

function validateOptionalStringArray(value: unknown, path: string, message: string, errors: GraphValidationIssue[]): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    errors.push({ path, message });
    return;
  }
  validateStringArrayItems(value, path, message, errors);
}

function validateStringArrayItems(value: unknown[], path: string, message: string, errors: GraphValidationIssue[]): void {
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string") {
      errors.push({ path: `${path}[${index}]`, message });
    }
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
