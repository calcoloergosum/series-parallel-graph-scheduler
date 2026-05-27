import { dirname } from "node:path";

import type { VisualizerPayload, WorkerManager, WorkerManagerStatus } from "./contracts.js";
import { defaultGraphPath, readGraph } from "./graph-io.js";
import { listReadyLeafNodes, listWorkingNodes, summarizeGraph } from "./graph-traversal.js";
import { renderPlanarSvg } from "./sp-layout.js";

export async function buildVisualizerPayload(
  graphPath = defaultGraphPath,
  workerManager?: Pick<WorkerManager, "status">
): Promise<VisualizerPayload> {
  const graph = await readGraph(graphPath);
  return {
    graph,
    graphSvg: renderPlanarSvg(graph),
    ready: listReadyLeafNodes(graph),
    working: listWorkingNodes(graph),
    summary: summarizeGraph(graph),
    workerManager: workerManager?.status?.() || emptyWorkerManagerStatus(dirname(graphPath))
  };
}

function emptyWorkerManagerStatus(cwd: string): WorkerManagerStatus {
  return {
    defaults: {
      cwd,
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
  };
}
