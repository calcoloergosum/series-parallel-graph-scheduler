#!/usr/bin/env node
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  dispatchCliCommand,
  buildGoalGraph,
  parseArgs,
  parseChildrenArgs,
  parseCodexArgs,
  renderCliHelp,
  resolvePlanGraphOutputPath,
  shouldStreamWorkerOutput
} from "./cli.js";
import type { CliCommandHandlers } from "./cli.js";
import { printCliError } from "./cli-errors.js";
import type {
  JsonValue,
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
  blockNode,
  claimNode,
  completeNode,
  decomposeNode,
  failNode,
  publishResolvedIntegration,
  reconcileGraphStatus,
  recordWorkerRefMetadata,
  releaseExpiredLeases,
  renewNodeLease,
  resetNode,
  resetReachable,
  resetSubtree,
  startNode
} from "./node-mutations.js";
import { sendSlackNotification } from "./notification.js";
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
  blockNode,
  claimNode,
  completeNode,
  decomposeNode,
  failNode,
  publishResolvedIntegration,
  reconcileGraphStatus,
  recordWorkerRefMetadata,
  releaseExpiredLeases,
  renewNodeLease,
  resetNode,
  resetReachable,
  resetSubtree,
  schedulerTransitionTable,
  startNode
} from "./node-mutations.js";
export {
  exportOperationalEvents,
  operationalEvents,
  operationalEventTaxonomy,
  redactOperationalEventDetails
} from "./operational-events.js";
export {
  GitRuntimeError,
  buildNodeWorkBranchName,
  createRunClone,
  createWorkBranch,
  defaultBareRepositoryPath,
  defaultIsolationBareRepositoryPath,
  prepareBareRepository,
  publishOutputRef,
  redactGitRemote,
  runGitCommand
} from "./git-runtime.js";
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
  buildGoalGraph,
  resolvePlanGraphOutputPath,
  shouldStreamWorkerOutput,
  isLocalVisualizerHost,
  visualizerHostSecurityWarning
};
export { formatCliError, printCliError } from "./cli-errors.js";

const { scriptDir, rootDir, isBuiltOutput } = runtimePathsFromModuleUrl(import.meta.url);
const schedulerScriptPath = fileURLToPath(import.meta.url);
const defaultGraphPath = resolve(rootDir, "plan.graph.json");
const defaultRendererPath = isBuiltOutput ? resolve(scriptDir, "render-plan.js") : resolve(rootDir, "scripts/render-plan.mjs");
const defaultPromptTemplatePath = resolve(rootDir, "prompts/codex-worker-task.md");

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
    publishResolvedIntegration,
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
    reconcileGraphStatus,
    releaseExpiredLeases,
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
