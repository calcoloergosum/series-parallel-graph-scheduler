#!/usr/bin/env node
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  dispatchCliCommand,
  buildGoalGraph,
  buildGoalGraphFromPlannerResponse,
  parseArgs,
  parseChildrenArgs,
  parseCodexArgs,
  renderCliHelp,
  resolvePlanGraphOutputPath,
  shouldStreamWorkerOutput
} from "./cli.js";
import type { CliCommandHandlers } from "./cli.js";
import { printCliError } from "./cli-errors.js";
import { validatePlanGraphFileResult } from "./contracts.js";
import type {
  JsonValue,
  PlanGraphFile,
  PlannerResponse,
  PlannerRuntimeRequest,
  RunWorkerOptions,
  VisualizerServerHandle,
  WorkerManager
} from "./contracts.js";
import {
  defaultReportPath,
  inspectGraphLock,
  readGraph,
  withGraphLock,
  writeGraphAtomic,
  writeReportFile
} from "./graph-io.js";
import {
  buildGraphDiagnostics,
  getNode,
  listReadyLeafNodes,
  summarizeGraph
} from "./graph-traversal.js";
import {
  answerNode,
  applyPlannerPreview,
  blockNode,
  claimNode,
  completeNode,
  decomposeNode,
  failNode,
  publishResolvedIntegration,
  reconcileGraphStatus,
  recordWorkerPlannerAttempt,
  recordWorkerRefMetadata,
  releaseExpiredLeases,
  rejectPlannerPreview,
  renewNodeLease,
  resetNode,
  resetReachable,
  resetSubtree,
  startNode
} from "./node-mutations.js";
import { sendSlackNotification } from "./notification.js";
import { createFixturePlannerRuntime, defaultPlannerOutputSchema } from "./planner-runtime.js";
import { runtimePathsFromModuleUrl } from "./runtime-paths.js";
import {
  buildWorkerPrompt as buildWorkerPromptImpl,
  runWorker as runWorkerImpl
} from "./worker.js";
import type { BuildWorkerPromptOptions } from "./worker.js";
import {
  buildVisualizerPayload as buildVisualizerPayloadImpl,
  createVisualizerServer as createVisualizerServerImpl,
  isLocalVisualizerHost,
  renderVisualizerHtml as renderVisualizerHtmlImpl,
  visualizerHostSecurityWarning
} from "./visualizer.js";
import type { CreateVisualizerServerOptions } from "./visualizer.js";

export {
  defaultReportPath,
  inspectGraphLock,
  installGraphIoFaultInjectorForTests,
  readGraph,
  resolveGraphRelativePath,
  withGraphLock,
  writeGraphAtomic,
  writeTextFileAtomic,
  writeReportFile
} from "./graph-io.js";
export {
  attachReadyPriorityFields,
  buildRelevantContext,
  buildReachableDepthMap,
  buildReachableParentMap,
  buildStableRootPathMap,
  buildReadyPrioritySelections,
  compareReadyPriorityCandidates,
  countSharedParentsWithCurrentTask,
  getNode,
  buildGraphDiagnostics,
  isLeaf,
  isSubtreeDone,
  listReadyLeafNodes,
  listWorkingNodes,
  resolveNodeBaseRef,
  summarizeGraph
} from "./graph-traversal.js";
export {
  answerNode,
  applyPlannerPreview,
  blockNode,
  claimNode,
  completeNode,
  decomposeNode,
  failNode,
  publishResolvedIntegration,
  reconcileGraphStatus,
  recordWorkerPlannerAttempt,
  recordWorkerRefMetadata,
  releaseExpiredLeases,
  rejectPlannerPreview,
  renewNodeLease,
  resetNode,
  resetReachable,
  resetSubtree,
  schedulerTransitionTable,
  startNode
} from "./node-mutations.js";
export { planNodeDecomposition } from "./node-mutations.js";
export {
  exportOperationalEvents,
  operationalEvents,
  operationalEventTaxonomy,
  redactOperationalEventDetails
} from "./operational-events.js";
export {
  GitRuntimeError,
  buildNodeWorkBranchName,
  collectGitDiffStat,
  createRunClone,
  createWorkBranch,
  defaultBareRepositoryPath,
  defaultIsolationBareRepositoryPath,
  prepareBareRepository,
  publishOutputRef,
  redactGitRemote,
  runGitCommand
} from "./git-runtime.js";
export { aggregateChildGitFootprints, buildGraphGitFootprintSummary } from "./git-footprint.js";
export {
  buildPlannerParentContext,
  buildPlannerPrompt,
  buildPlannerRuntimeRequest,
  createFixturePlannerRuntime,
  createPromptPlannerRuntime,
  defaultPlannerOutputSchema,
  parsePlannerResponse,
  plannerResponseToDecomposeMutation,
  validatePlannerResponse,
  PlannerResponseValidationError,
  renderPlannerPrompt
} from "./planner-runtime.js";
export { buildSlackNotificationText, sendSlackNotification } from "./notification.js";
export {
  finalizeWorkerRun,
  formatWorkerReport,
  prefixChunk,
  resolveWorkerIsolation,
  runCodexPrompt,
  startLeaseHeartbeat,
  waitForReadyJob
} from "./worker.js";
export {
  parseArgs,
  parseChildrenArgs,
  parseCodexArgs,
  renderCliHelp,
  buildGoalGraphFromPlannerResponse,
  buildGoalGraph,
  resolvePlanGraphOutputPath,
  shouldStreamWorkerOutput,
  isLocalVisualizerHost,
  visualizerHostSecurityWarning
};
export { goalGraphInitialNodeId, goalGraphVersion } from "./goal-graph.js";
export { formatCliError, printCliError } from "./cli-errors.js";

const { scriptDir, rootDir, isBuiltOutput } = runtimePathsFromModuleUrl(import.meta.url);
const schedulerScriptPath = fileURLToPath(import.meta.url);
const defaultGraphPath = resolve(rootDir, "plan.graph.json");
const defaultRendererPath = isBuiltOutput ? resolve(scriptDir, "render-plan.js") : resolve(rootDir, "scripts/render-plan.mjs");
const defaultPromptTemplatePath = resolve(rootDir, "prompts/codex-worker-task.md");
const defaultPlannerPromptTemplatePath = resolve(rootDir, "prompts/planner-decompose-task.md");

export async function buildWorkerPrompt(graphPath: string, options: BuildWorkerPromptOptions = {}): Promise<string> {
  return buildWorkerPromptImpl(graphPath, options, workerRuntime());
}

export function renderVisualizerHtml(): string {
  return renderVisualizerHtmlImpl();
}

export async function createVisualizerServer(
  options: Omit<CreateVisualizerServerOptions, "runtime"> = {}
): Promise<VisualizerServerHandle> {
  return createVisualizerServerImpl({
    ...options,
    runtime: visualizerRuntime()
  });
}

export async function buildVisualizerPayload(graphPath = defaultGraphPath, workerManager?: WorkerManager) {
  return buildVisualizerPayloadImpl(graphPath, workerManager);
}

export async function diagnoseGraph(graphPath = defaultGraphPath) {
  const graph = await readGraph(graphPath);
  const lock = await inspectGraphLock(graphPath);
  return buildGraphDiagnostics(graph, { graphPath, lock });
}

export async function runWorker(graphPath: string, options: RunWorkerOptions = {}) {
  return runWorkerImpl(graphPath, options, workerRuntime());
}

export async function renderPlanAfterUpdate(graphPath: string): Promise<void> {
  await withGraphLock(graphPath, async () => {
    const graph = await readGraph(graphPath);
    if (!graph.document) {
      return;
    }
    await new Promise<void>((resolveRender, rejectRender) => {
      const child = spawn(process.execPath, [defaultRendererPath, "--graph", graphPath], { cwd: rootDir, stdio: "ignore" });
      child.on("error", rejectRender);
      child.on("exit", (code) => {
        if (code === 0) {
          resolveRender();
        } else {
          rejectRender(new Error(`render-plan exited with ${code}`));
        }
      });
    });
  });
}

export async function planGoalGraph(
  graphPath: string,
  {
    goal,
    title,
    dryRun = false,
    plannerFixturePath
  }: {
    goal?: string;
    title?: string;
    dryRun?: boolean;
    plannerFixturePath?: string;
  }
): Promise<Record<string, unknown>> {
  const normalizedGoal = goal?.trim();
  if (!normalizedGoal) {
    throw new Error("plan requires goal");
  }
  const graph = await buildVisualizerGoalGraph(normalizedGoal, graphPath, { title, plannerFixturePath });
  const validation = validatePlanGraphFileResult(graph);
  if (validation.errors.length > 0) {
    throw new Error(`Generated graph failed validation: ${validation.errors.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`);
  }
  const summary = summarizeGraph(graph);
  const result = {
    graphPath,
    mode: "plan-only",
    dryRun,
    written: false,
    rootId: summary.root,
    nodeCount: summary.totalNodes,
    validation: { valid: true, errors: validation.errors, warnings: validation.warnings },
    summary,
    graph
  };
  if (!dryRun) {
    await withGraphLock(graphPath, async () => {
      await writeGraphAtomic(graph, graphPath);
    });
    result.written = true;
  }
  return result;
}

async function buildVisualizerGoalGraph(
  goal: string,
  graphPath: string,
  {
    title,
    plannerFixturePath
  }: {
    title?: string;
    plannerFixturePath?: string;
  } = {}
): Promise<PlanGraphFile> {
  const fallbackGraph = buildGoalGraph(goal, { title });
  const fixturePath = plannerFixturePath?.trim();
  if (!fixturePath) {
    return fallbackGraph;
  }
  const source = await readFixturePlannerResponses(resolveGraphRelativeFixturePath(graphPath, fixturePath));
  const requestId = "goal-plan-ROOT-1";
  const root = fallbackGraph.graph.nodes.ROOT;
  const request: PlannerRuntimeRequest = {
    requestId,
    mode: "goal",
    goal,
    nodeId: "ROOT",
    node: root,
    parentContext: {
      nodeId: "ROOT",
      title: root.title,
      kind: root.kind,
      status: root.status,
      description: root.description,
      goal: root.goal,
      parentIds: []
    },
    currentGraphSummary: summarizeGraph(fallbackGraph),
    outputSchema: defaultPlannerOutputSchema,
    allowedKinds: ["task", "series", "parallel"],
    planner: { name: "fixture-planner", requestId }
  };
  const result = await createFixturePlannerRuntime(source).plan(request);
  return buildGoalGraph(goal, {
    title,
    plannerResult: result,
    allowedKinds: request.allowedKinds,
    planner: result.planner
  });
}

async function readFixturePlannerResponses(path: string): Promise<PlannerResponse | Record<string, PlannerResponse>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Invalid fixture planner file ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (!isPlannerFixtureSource(parsed)) {
    throw new Error(`Invalid fixture planner file ${path}: expected a planner response object or request-id response map`);
  }
  return parsed;
}

function isPlannerFixtureSource(value: unknown): value is PlannerResponse | Record<string, PlannerResponse> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  if (typeof (value as { kind?: unknown }).kind === "string") {
    return true;
  }
  return Object.values(value).every((entry) => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry) && typeof (entry as { kind?: unknown }).kind === "string");
}

function resolveGraphRelativeFixturePath(graphPath: string, path: string): string {
  return isAbsolute(path) ? path : resolve(dirname(graphPath), path);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  await dispatchCliCommand({
    argv,
    env: process.env,
    rootDir,
    output: console,
    handlers: cliHandlers()
  });
}

function cliHandlers(): CliCommandHandlers {
  return {
    readGraph,
    writeGraphFile: async (graphPath, graph) => {
      await withGraphLock(graphPath, async () => {
        await writeGraphAtomic(graph, graphPath);
      });
    },
    listReadyLeafNodes,
    summarizeGraph,
    diagnoseGraph,
    claimNode,
    startNode,
    renewNodeLease,
    resetNode,
    resetSubtree,
    resetReachable,
    writeReportFile: async (graphPath, reportPath, body) => {
      await writeReportFile(graphPath, reportPath, body);
    },
    completeNode,
    blockNode,
    answerNode,
    failNode,
    decomposeNode,
    applyPlannerPreview,
    rejectPlannerPreview,
    buildWorkerPrompt,
    runWorker,
    reconcileGraphStatus,
    releaseExpiredLeases,
    createVisualizerServer,
    renderPlanAfterUpdate,
    sendSlackNotification
  };
}

function workerRuntime() {
  return {
    defaultGraphPath,
    defaultPromptTemplatePath,
    defaultPlannerPromptTemplatePath,
    schedulerCommand: `node ${schedulerScriptPath}`,
    readGraph,
    getNode,
    listReadyLeafNodes,
    summarizeGraph,
    defaultReportPath,
    claimNode,
    startNode,
    renewNodeLease,
    completeNode,
    failNode,
    blockNode,
    decomposeNode,
    applyPlannerPreview,
    publishResolvedIntegration,
    recordWorkerPlannerAttempt,
    recordWorkerRefMetadata,
    writeReportFile,
    sendSlackNotification,
    renderPlanAfterUpdate
  };
}

function visualizerRuntime() {
  return {
    defaultGraphPath,
    defaultPromptTemplatePath,
    schedulerCommand: `node ${schedulerScriptPath}`,
    schedulerScriptPath,
    rootDir,
    readGraph,
    getNode,
    listReadyLeafNodes,
    summarizeGraph,
    defaultReportPath,
    diagnoseGraph,
    claimNode,
    startNode,
    renewNodeLease,
    writeReportFile,
    completeNode,
    blockNode,
    answerNode,
    failNode,
    resetNode,
    resetSubtree,
    resetReachable,
    decomposeNode,
    applyPlannerPreview,
    rejectPlannerPreview,
    reconcileGraphStatus,
    releaseExpiredLeases,
    planGoalGraph,
    renderPlanAfterUpdate,
    sendSlackNotification: (
      graphPath: string,
      event: string,
      details?: Record<string, JsonValue | undefined>
    ) => sendSlackNotification(graphPath, event, details)
  };
}

function isDirectEntrypoint(): boolean {
  if (!process.argv[1]) {
    return false;
  }
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}

if (isDirectEntrypoint()) {
  main().catch((error: unknown) => {
    printCliError(error, process.env);
    process.exitCode = 1;
  });
}
