import {
  assertPlanGraphFile,
  isKnownNodeKind,
  isKnownNodeStatus,
  type CliCommand,
  type GraphNode,
  type NodeStatus,
  type ParsedArgs,
  type PlanGraphFile,
  type RendererDocument,
  type VisualizerPayload
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
  findAncestorIds,
  getNode,
  isLeaf,
  isSubtreeDone,
  listReadyLeafNodes,
  listWorkingNodes,
  summarizeGraph
} from "../scripts/graph-traversal.js";

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

const extraMetadataNode: GraphNode = {
  title: "Task",
  kind: "task",
  status: "waiting-for-review",
  documentField: ["extra metadata"],
  ui: { color: "teal", priority: 2 },
  reviewer: undefined
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
const rootIsLeaf: boolean = isLeaf(graph, "ROOT");
const rootIsDone: boolean = isSubtreeDone(graph, "ROOT");

const payload: VisualizerPayload = {
  graph: parsed,
  graphSvg: "<svg></svg>",
  ready: [{ id: "A", title: "Task", kind: "task", status: permissiveStatus }],
  working: [],
  summary: { totalNodes: 2, root: "ROOT", counts: { pending: 1, "waiting-for-review": 1 } },
  workerManager: {
    defaults: { cwd: "/tmp/work", sessionPrefix: "codex", codexCommand: "codex" },
    workers: []
  }
};

void args;
void payload;
void parsedCliArgs;
void childArgs;
void typedChildArgs;
void codexArgs;
void graphPath;
void streamWorkerOutput;
void helpText;
void rootNode;
void graphSummary;
void readyNodes;
void workingNodes;
void ancestorIds;
void rootIsLeaf;
void rootIsDone;
void ({} as CliCommandHandlers);
void isKnownNodeKind("parallel");
void isKnownNodeStatus("done");
