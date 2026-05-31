import {
  assertPlanGraphFile,
  isKnownNodeKind,
  isKnownNodeStatus,
  type CliCommand,
  type GraphDiagnostics,
  type GraphLease,
  type GraphLockDiagnostics,
  type GraphNode,
  type JsonObject,
  type JsonValue,
  type NodeOutputContract,
  type NodeStatus,
  type OperationalEventExportEntry,
  type ParsedArgs,
  type PlanGraphFile,
  type PlannerChildProposal,
  type PlannerOutputSchemaDescriptor,
  type PlannerParentContext,
  type PlannerRequest,
  type PlannerResponse,
  type PlannerRuntime,
  type PlannerRuntimeRequest,
  type PlannerRuntimeResponse,
  type PlannerValidationError,
  type PlannerValidationResult,
  type PublicWorker,
  type ReachableDepthMap,
  type ReachableParentMap,
  type ReachablePathMap,
  type ReadyNodePriorityFields,
  type RendererDocument,
  type VisualizerNodeAction,
  type VisualizerNodeDetail,
  type VisualizerPayload,
  type WorkerManagerProcess
} from "../scripts/contracts.js";
import {
  parseArgs,
  parseChildrenArgs,
  parseCodexArgs,
  renderCliHelp,
  resolveCliGraphPath,
  shouldStreamWorkerOutput,
  type CliCommandHandlers
} from "../scripts/cli.js";
import {
  attachReadyPriorityFields,
  buildReadyPrioritySelections,
  compareReadyPriorityCandidates,
  countSharedParentsWithCurrentTask,
  findAncestorIds,
  buildReachableDepthMap,
  buildReachableParentMap,
  buildStableRootPathMap,
  getNode,
  isLeaf,
  isSubtreeDone,
  listReadyLeafNodes,
  listWorkingNodes,
  type ReadyPriorityCandidate,
  summarizeGraph
} from "../scripts/graph-traversal.js";
import { type GraphLockOptions } from "../scripts/graph-io.js";
import { runtimePathsFromModuleUrl, type RuntimePaths } from "../scripts/runtime-paths.js";
import { type BuildWorkerPromptOptions, type RunCodexPromptOptions } from "../scripts/worker.js";

const rendererDocument: RendererDocument = {
  pageTitle: "Typed graph",
  nav: [{ label: "README", href: "README.md" }],
  intro: ["Optional renderer fields stay optional."],
  meta: [{ label: "Owner", value: "Migration" }],
  notation: undefined,
  sections: [{ heading: "Compatibility", paragraphs: ["Extra document metadata is allowed."], owner: "TS5" }],
  gates: undefined,
  callouts: [{ bodyHtml: "Renderer accepts HTML-like rich text.", severity: "info" }],
  customRendererFlag: true
};
declare const commandHandlers: CliCommandHandlers;

const extraMetadataNode: GraphNode = {
  title: "Task",
  kind: "task",
  status: "waiting-for-review",
  goal: { text: "Keep planner-created nodes explainable", source: "planner" },
  planner: {
    name: "codex-planner",
    model: "gpt-5",
    requestId: "plan-contract",
    plannedAt: "2026-05-27T00:00:00.000Z"
  },
  contextRefs: [{ type: "file", ref: "docs/planner-output-schema.md", title: "Planner contract" }],
  outputContract: {
    format: "markdown",
    requiredArtifacts: ["summary"],
    acceptanceCriteria: ["Unknown metadata stays preserved."]
  },
  resultSummary: {
    status: "partial",
    summary: "Planner metadata fields remain optional additive node metadata.",
    artifacts: ["docs/planner-output-schema.md"]
  },
  baseRef: {
    name: "refs/remotes/origin/main",
    commit: "0123456789abcdef0123456789abcdef01234567",
    source: "graph-default",
    resolvedAt: "2026-05-27T00:00:00.000Z"
  },
  workRef: {
    name: "refs/heads/spg/node/A/run_20260527_000000_A_abc123",
    commit: "1111111111111111111111111111111111111111",
    runId: "run_20260527_000000_A_abc123",
    session: "codex-A",
    createdAt: "2026-05-27T00:00:00.000Z"
  },
  outputRef: {
    name: "refs/heads/spg/node/A/run_20260527_000000_A_abc123",
    commit: "fedcba9876543210fedcba9876543210fedcba98",
    report: "reports/A-run_20260527_000000_A_abc123.md",
    producedAt: "2026-05-27T00:05:00.000Z",
    diffStat: { filesChanged: 1, additions: 12, deletions: 3, totalChanges: 15 },
    files: [{ path: "scripts/contracts.ts", changeType: "modified", additions: 12, deletions: 3, totalChanges: 15 }],
    collectedAt: "2026-05-27T00:05:01.000Z"
  },
  integrationRef: {
    name: "refs/heads/spg/integration/P/run_20260527_000000_P_def456",
    kind: "parallel",
    status: "clean",
    inputRefs: [{ nodeId: "A", outputRef: "refs/heads/spg/node/A/run_20260527_000000_A_abc123" }],
    publishedOutputRef: "refs/heads/spg/integration/P/run_20260527_000000_P_def456"
  },
  workspace: {
    remote: "https://[REDACTED]@example.com/org/repo.git",
    bareRepo: "runs/git/cache/repo.git",
    cloneCwd: "runs/workspaces/codex-A/A/run_20260527_000000_A_abc123",
    runId: "run_20260527_000000_A_abc123",
    session: "codex-A",
    preparedAt: "2026-05-27T00:00:00.000Z"
  },
  gitFootprint: {
    baseRef: { name: "refs/remotes/origin/main", commit: "0123456789abcdef0123456789abcdef01234567" },
    headRef: {
      name: "refs/heads/spg/node/A/run_20260527_000000_A_abc123",
      commit: "fedcba9876543210fedcba9876543210fedcba98"
    },
    branch: "spg/node/A/run_20260527_000000_A_abc123",
    commit: "fedcba9876543210fedcba9876543210fedcba98",
    diffStat: { filesChanged: 1, additions: 12, deletions: 3, totalChanges: 15 },
    files: [{ path: "scripts/contracts.ts", changeType: "modified", additions: 12, deletions: 3, totalChanges: 15 }],
    collectedAt: "2026-05-27T00:05:01.000Z"
  },
  documentField: ["extra metadata"],
  ui: { color: "teal", priority: 2 },
  reviewer: undefined
};

const vendorMetadata: JsonObject = {
  retained: true,
  tags: ["contract", "metadata"],
  nested: { priority: 2, omitted: undefined }
};
const vendorJson: JsonValue = vendorMetadata;

const plannerOutputContract: NodeOutputContract = {
  format: "markdown",
  requiredArtifacts: ["report", "test evidence"],
  schemaRef: "docs/planner-output-schema.md"
};
const plannerRequest: PlannerRequest = {
  requestId: "plan-contract-request",
  mode: "decompose",
  goal: "Define planner contracts",
  nodeId: "A",
  node: extraMetadataNode,
  allowedKinds: ["task", "series", "parallel"],
  contextRefs: [{ type: "node", ref: "A", nodeId: "A" }],
  outputContract: plannerOutputContract,
  planner: { name: "codex-planner", version: "0.1" }
};
const plannerChild: PlannerChildProposal = {
  idHint: "SCHEMA",
  kind: "task",
  title: "Define schema",
  deliverables: ["Types and examples"],
  outputContract: plannerOutputContract,
  customPlannerMetadata: { keep: true }
};
const _plannerResponse: PlannerResponse = {
  requestId: plannerRequest.requestId,
  kind: "series",
  title: "Define planner schema",
  childIdPolicy: "scheduler-generated",
  children: [plannerChild],
  rationale: "A validation boundary is easier to review before graph mutation."
};
const plannerValidationError: PlannerValidationError = {
  path: "$.children[0].id",
  code: "id-collision",
  message: "Planner-provided id already exists.",
  severity: "error"
};
const _plannerValidationResult: PlannerValidationResult = {
  valid: false,
  errors: [plannerValidationError],
  warnings: []
};
const plannerParentContext: PlannerParentContext = {
  nodeId: "A",
  title: "Task",
  kind: "task",
  status: "pending",
  parentIds: ["ROOT"]
};
const plannerOutputSchema: PlannerOutputSchemaDescriptor = {
  schemaRef: "docs/planner-output-schema.md",
  description: "Planner response JSON schema",
  responseKinds: ["task", "series", "parallel"],
  requiredFields: ["kind", "title"],
  schema: { type: "object", required: ["kind", "title"] }
};
const plannerRuntimeRequest: PlannerRuntimeRequest = {
  ...plannerRequest,
  requestId: "plan-runtime-request",
  parentContext: plannerParentContext,
  currentGraphSummary: { graphVersion: 1, totalNodes: 2, root: "ROOT", counts: { pending: 2 } },
  outputSchema: plannerOutputSchema
};
const plannerRuntimeResponse: PlannerRuntimeResponse = {
  requestId: plannerRuntimeRequest.requestId,
  response: _plannerResponse,
  prompt: "Planner prompt",
  rawText: JSON.stringify(_plannerResponse)
};
const plannerRuntime: PlannerRuntime = {
  async plan(request) {
    return { ...plannerRuntimeResponse, requestId: request.requestId };
  }
};

const graph = {
  graphVersion: 1,
  title: "Typed Graph Contract",
  description: undefined,
  statusModel: ["pending", "waiting-for-review", "done"],
  scheduler: { leaseSeconds: 1800, htmlView: "plan.html", operator: "local" },
  graph: {
    root: "ROOT",
    nodes: {
      ROOT: { title: "Root", kind: "series", status: "pending", children: ["A"], customMetadata: { keep: true } },
      A: extraMetadataNode,
      OPTIONALS: { extraOnly: "missing kind and status is allowed by legacy plans" }
    },
    visualizerHints: { collapsed: ["OPTIONALS"] }
  },
  document: rendererDocument,
  importedFrom: "legacy-plan"
} satisfies PlanGraphFile;

// @ts-expect-error Graph children must be node id strings.
const invalidChildrenNode: GraphNode = { children: [1] };
// @ts-expect-error Lease contracts require the owner and timestamp fields used by lock/renew flows.
const invalidLease: GraphLease = { session: "codex" };

const parsed: unknown = graph;
assertPlanGraphFile(parsed);
assertPlanGraphFile({
  graph: {
    root: "ROOT",
    nodes: {
      ROOT: { children: [] }
    }
  },
  document: {
    sections: [{ heading: "Only heading is required" }]
  }
});

const command: CliCommand = "worker";
const args: ParsedArgs = { _: [command], graph: "plan.graph.json", once: true, "codex-arg": ["exec", "--model=gpt-5"] };
const permissiveStatus: NodeStatus = parsed.graph.nodes.A.status ?? "pending";
const runtimePaths: RuntimePaths = runtimePathsFromModuleUrl(import.meta.url);
const lockOptions: GraphLockOptions = { timeoutMs: 1000, retryMs: 10 };
const lockDiagnostics: GraphLockDiagnostics = {
  path: "/repo/plan.graph.json.lock",
  exists: true,
  staleMs: 600_000,
  stale: false,
  owner: {
    pid: 123,
    createdAt: "2026-05-27T00:00:00.000Z",
    graphPath: "/repo/plan.graph.json"
  },
  nextSteps: ["wait"]
};
const parsedCliArgs = parseArgs(["worker", "--graph", "custom.graph.json", "--codex-arg=--model=gpt-5"]);
const childArgs = parseChildrenArgs({ _: ["decompose"], child: ["TS20a=First", "TS20b:Second"] });
const typedChildArgs = parseChildrenArgs({
  _: ["decompose"],
  "child-json": JSON.stringify([
    { id: "TS20c", title: "Typed child", kind: "task", status: "waiting-for-review", children: ["TS20d"] }
  ])
});
const codexArgs = parseCodexArgs({ _: ["worker"], "codex-arg": "--dangerously-bypass-approvals-and-sandbox" });
const graphPath = resolveCliGraphPath("/repo", { _: ["ready"], graph: "plan.graph.json" }, {});
const streamWorkerOutput = shouldStreamWorkerOutput({ _: ["worker"] });
const helpText: string = renderCliHelp();
const rootNode = getNode(graph, "ROOT");
const graphSummary = summarizeGraph(graph);
const readyNodes = listReadyLeafNodes(graph);
const workingNodes = listWorkingNodes(graph);
const ancestorIds = findAncestorIds(graph, "A");
const reachableParents: ReachableParentMap = buildReachableParentMap(graph);
const reachableDepths: ReachableDepthMap = buildReachableDepthMap(graph);
const reachablePaths: ReachablePathMap = buildStableRootPathMap(graph);
const readyNodePriorityFields: ReadyNodePriorityFields = {
  depth: 1,
  child_count: 0,
  shared_parent_count_with_current_task: 0
};
const readyPriorityCandidate: ReadyPriorityCandidate = {
  id: "A",
  depth: 1,
  child_count: 0,
  shared_parent_count_with_current_task: 0
};
const readyPriorityComparison: number = compareReadyPriorityCandidates(readyPriorityCandidate, {
  id: "B",
  depth: 2,
  child_count: 0,
  shared_parent_count_with_current_task: 0
});
const readyPrioritySelections = buildReadyPrioritySelections(graph, readyNodes, "A");
const enrichedReadyNodes = attachReadyPriorityFields(graph, readyNodes);
const sharedParentCount: number = countSharedParentsWithCurrentTask(new Set(["ROOT"]), reachablePaths, "A");
const rootIsLeaf: boolean = isLeaf(graph, "ROOT");
const rootIsDone: boolean = isSubtreeDone(graph, "ROOT");
const promptOptions: BuildWorkerPromptOptions = { nodeId: "A", reportPath: "reports/A.md" };
const codexPromptOptions: RunCodexPromptOptions = {
  cwd: "/tmp/work",
  codexCommand: "codex",
  codexArgs: ["exec"],
  graphPath: "/repo/plan.graph.json"
};
const publicWorker: PublicWorker = {
  id: "worker-1",
  session: "codex-01",
  status: "running",
  startedAt: "2026-05-27T00:00:00.000Z",
  durationMs: 0,
  logTail: []
};
const workerProcess: WorkerManagerProcess = {
  ...publicWorker,
  status: "running",
  cwd: "/tmp/work",
  command: "node",
  args: ["dist/scripts/plan-scheduler.js"],
  logTail: []
};
// @ts-expect-error Managed worker internals only use concrete lifecycle statuses.
const invalidWorkerProcess: WorkerManagerProcess = { ...workerProcess, status: "paused" };

const visualizerClaimAction: VisualizerNodeAction = {
  id: "claim",
  label: "Claim",
  danger: "none",
  requiredFields: ["nodeId"]
};
const visualizerFailAction: VisualizerNodeAction = {
  id: "fail",
  label: "Fail",
  danger: "danger",
  requiredFields: ["nodeId", "session|runId", "reason", "report?"],
  disabledReason: "fail requires status running, blocked, review.",
  confirmation: {
    required: true,
    label: "Fail node",
    message: "Fail A"
  }
};
// @ts-expect-error Visualizer action ids are the scheduler-supported action set, not arbitrary client strings.
const invalidVisualizerAction: VisualizerNodeAction = { ...visualizerClaimAction, id: "archive" };

const visualizerNodeDetail: VisualizerNodeDetail = {
  id: "A",
  title: "Task",
  kind: "task",
  status: permissiveStatus,
  description: "Typed detail payload",
  children: [],
  deliverables: ["Workspace ready"],
  acceptanceCriteria: ["Tests can run"],
  lease: {
    session: "codex-A",
    runId: "run_20260527_000000_A_abc123",
    claimedAt: "2026-05-27T00:00:00.000Z",
    expiresAt: "2026-05-27T00:30:00.000Z"
  },
  refs: {
    baseRef: extraMetadataNode.baseRef,
    workRef: extraMetadataNode.workRef,
    outputRef: extraMetadataNode.outputRef,
    integrationRef: extraMetadataNode.integrationRef,
    gitFootprint: extraMetadataNode.gitFootprint
  },
  workspace: extraMetadataNode.workspace,
  report: "reports/A-run_20260527_000000_A_abc123.md",
  question: "Proceed?",
  answer: "Yes",
  answeredBy: "operator",
  blockedReason: "needs_scope",
  failureReason: "tests failed",
  timestamps: {
    startedAt: "2026-05-27T00:00:00.000Z",
    completedAt: "2026-05-27T00:05:00.000Z",
    blockedAt: "2026-05-27T00:01:00.000Z",
    answeredAt: "2026-05-27T00:02:00.000Z",
    failedAt: "2026-05-27T00:03:00.000Z",
    expiredAt: "2026-05-27T00:30:00.000Z"
  },
  history: [{
    at: "2026-05-27T00:00:00.000Z",
    event: "claimed",
    status: "claimed",
    session: "codex-A",
    runId: "run_20260527_000000_A_abc123"
  }],
  historyCount: 1,
  historyLimit: 10,
  actions: [visualizerClaimAction, visualizerFailAction]
};
// @ts-expect-error Visualizer node details must keep essential normalized fields for client renderers.
const invalidVisualizerNodeDetail: VisualizerNodeDetail = {
  id: "A",
  kind: "task",
  status: "pending",
  children: [],
  deliverables: [],
  refs: {},
  timestamps: {},
  history: [],
  historyCount: 0,
  historyLimit: 10,
  actions: []
};

const visualizerDiagnostics: GraphDiagnostics = {
  generatedAt: "2026-05-27T00:00:00.000Z",
  summary: { totalNodes: 2, root: "ROOT", counts: { pending: 1, "waiting-for-review": 1 } },
  nextReady: [],
  leases: { active: [], expired: [] },
  blocked: [],
  failed: [],
  isolation: { activeWorkers: [], missingOutputRefs: [], unresolvedBufferConflicts: [] },
  lock: lockDiagnostics,
  actions: [],
  remediation: []
};
// @ts-expect-error Diagnostics payloads must include the typed remediation summary.
const invalidVisualizerDiagnostics: GraphDiagnostics = {
  generatedAt: "2026-05-27T00:00:00.000Z",
  summary: { totalNodes: 2, root: "ROOT", counts: { pending: 1, "waiting-for-review": 1 } },
  nextReady: [],
  leases: { active: [], expired: [] },
  blocked: [],
  failed: [],
  isolation: { activeWorkers: [], missingOutputRefs: [], unresolvedBufferConflicts: [] },
  actions: []
};

const visualizerEvent: OperationalEventExportEntry = {
  at: "2026-05-27T00:00:00.000Z",
  event: "claimed",
  nodeId: "A",
  status: "claimed",
  session: "codex-A",
  runId: "run_20260527_000000_A_abc123",
  timestamps: { at: "2026-05-27T00:00:00.000Z" },
  details: { status: "claimed", leaseSeconds: 1800, nested: { retained: true } }
};
// @ts-expect-error Exported visualizer events must identify the graph node they came from.
const invalidVisualizerEvent: OperationalEventExportEntry = {
  at: "2026-05-27T00:00:00.000Z",
  event: "claimed",
  timestamps: {},
  details: {}
};

const payload: VisualizerPayload = {
  graph: parsed,
  graphSvg: "<svg></svg>",
  nodes: [visualizerNodeDetail],
  nodeHistoryLimit: 10,
  actionPolicy: {
    leaseProtectedWorkerActions: {
      whenCredentialsAbsent: "disable-leased-node-actions",
      requiredCredential: "matching-session-or-runId"
    },
    destructiveActions: {
      danger: "danger",
      requireConfirmationMetadata: true
    },
    serverAuthority: "scheduler-mutation-guards"
  },
  attention: {
    failed: { count: 0, nodeIds: [] },
    blocked: { count: 0, nodeIds: [] },
    expired: { count: 0, nodeIds: [], releasable: 0 },
    workerErrors: { count: 0, workerIds: [] }
  },
  diagnostics: visualizerDiagnostics,
  recentEvents: [visualizerEvent],
  ready: [{ id: "A", title: "Task", kind: "task", status: permissiveStatus }],
  working: [],
  summary: { totalNodes: 2, root: "ROOT", counts: { pending: 1, "waiting-for-review": 1 } },
  workerManager: {
    defaults: {
      cwd: "/tmp/work",
      sessionPrefix: "codex",
      codexCommand: "codex",
      isolation: "off",
      workspaceRoot: "runs/workspaces",
      workspaceRetention: "on-failure"
    },
    running: 0,
    stopping: 0,
    exited: 0,
    error: 0,
    retainedWorkers: 0,
    totalStarted: 0,
    workers: []
  }
};

void args;
void vendorJson;
void plannerParentContext;
void plannerOutputSchema;
void plannerRuntimeRequest;
void plannerRuntimeResponse;
void plannerRuntime;
void payload;
void invalidChildrenNode;
void invalidLease;
void runtimePaths;
void lockOptions;
void lockDiagnostics;
void parsedCliArgs;
void childArgs;
void typedChildArgs;
void codexArgs;
void graphPath;
void streamWorkerOutput;
void helpText;
void rootNode;
void promptOptions;
void codexPromptOptions;
void publicWorker;
void workerProcess;
void invalidWorkerProcess;
void visualizerClaimAction;
void visualizerFailAction;
void invalidVisualizerAction;
void visualizerNodeDetail;
void invalidVisualizerNodeDetail;
void visualizerDiagnostics;
void invalidVisualizerDiagnostics;
void visualizerEvent;
void invalidVisualizerEvent;
void graphSummary;
void readyNodes;
void workingNodes;
void ancestorIds;
void reachableParents;
void reachableDepths;
void reachablePaths;
void readyNodePriorityFields;
void readyPriorityComparison;
void readyPrioritySelections;
void enrichedReadyNodes;
void sharedParentCount;
void rootIsLeaf;
void rootIsDone;
void commandHandlers;
void isKnownNodeKind("parallel");
void isKnownNodeStatus("done");
