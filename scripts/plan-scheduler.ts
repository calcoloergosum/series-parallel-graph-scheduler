#!/usr/bin/env node
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  dispatchCliCommand,
  parseArgs,
  parseChildrenArgs,
  parseCodexArgs,
  shouldStreamWorkerOutput
} from "./cli.js";
import type { CliCommandHandlers } from "./cli.js";
import type {
  JsonValue,
  RunWorkerOptions,
  VisualizerServerHandle,
  WorkerManager
} from "./contracts.js";
import {
  defaultReportPath,
  readGraph,
  withGraphLock,
  writeGraphAtomic,
  writeReportFile
} from "./graph-io.js";
import {
  getNode,
  isLeaf,
  isSubtreeDone,
  listReadyLeafNodes,
  listWorkingNodes,
  summarizeGraph
} from "./graph-traversal.js";
import {
  answerNode,
  blockNode,
  claimNode,
  completeNode,
  decomposeNode,
  failNode,
  reconcileGraphStatus,
  releaseExpiredLeases,
  renewNodeLease,
  resetNode,
  resetReachable,
  resetSubtree,
  startNode
} from "./node-mutations.js";
import {
  buildSlackNotificationText,
  sendSlackNotification
} from "./notification.js";
import { runtimePathsFromModuleUrl } from "./runtime-paths.js";
import {
  buildWorkerPrompt as buildWorkerPromptImpl,
  finalizeWorkerRun,
  formatWorkerReport,
  prefixChunk,
  runCodexPrompt,
  runWorker as runWorkerImpl,
  startLeaseHeartbeat,
  waitForReadyJob
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
  readGraph,
  resolveGraphRelativePath,
  withGraphLock,
  writeGraphAtomic,
  writeReportFile
} from "./graph-io.js";
export {
  getNode,
  isLeaf,
  isSubtreeDone,
  listReadyLeafNodes,
  listWorkingNodes,
  summarizeGraph
} from "./graph-traversal.js";
export {
  answerNode,
  blockNode,
  claimNode,
  completeNode,
  decomposeNode,
  failNode,
  reconcileGraphStatus,
  releaseExpiredLeases,
  renewNodeLease,
  resetNode,
  resetReachable,
  resetSubtree,
  startNode
} from "./node-mutations.js";
export { buildSlackNotificationText, sendSlackNotification } from "./notification.js";
export {
  finalizeWorkerRun,
  formatWorkerReport,
  prefixChunk,
  runCodexPrompt,
  startLeaseHeartbeat,
  waitForReadyJob
} from "./worker.js";
export {
  parseArgs,
  parseChildrenArgs,
  parseCodexArgs,
  shouldStreamWorkerOutput,
  isLocalVisualizerHost,
  visualizerHostSecurityWarning
};

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
    listReadyLeafNodes,
    summarizeGraph,
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
    writeReportFile,
    sendSlackNotification,
    renderPlanAfterUpdate
  };
}

function visualizerRuntime() {
  return {
    defaultGraphPath,
    schedulerScriptPath,
    rootDir,
    answerNode,
    renderPlanAfterUpdate,
    sendSlackNotification: (
      graphPath: string,
      event: string,
      details?: Record<string, JsonValue | undefined>
    ) => sendSlackNotification(graphPath, event, details)
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
