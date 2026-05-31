import { after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
export { assert, execFile, existsSync, createServer, cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, utimes, writeFile, tmpdir, dirname, join, fileURLToPath, pathToFileURL, promisify, runInNewContext };


export const stableDistIsTemporary = process.env.SPG_TEST_USE_ORIGINAL_DIST !== "1";
export const stableDistDir = await copyBuiltDist();
export const schedulerScriptUrl = builtScriptUrl("plan-scheduler");
export const contractsScriptUrl = builtScriptUrl("contracts");
export const graphSchemaScriptUrl = builtScriptUrl("generate-graph-schema");
export const layoutScriptUrl = builtScriptUrl("sp-layout");
export const stressScriptPath = fileURLToPath(builtScriptUrl("stress-concurrency"));
export const transitionReferenceScriptUrl = builtScriptUrl("transition-reference");
export const visualizerScriptUrl = builtScriptUrl("visualizer");
export const packageGraphIoScriptUrl = originalBuiltScriptUrl("graph-io");
export const rendererScriptPath = fileURLToPath(builtScriptUrl("render-plan"));
export const schedulerScriptPath = fileURLToPath(schedulerScriptUrl);
export const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
export const originalSlackWebhookUrl = process.env.SLACK_WEBHOOK_URL;
export const graphFixturesDir = fileURLToPath(new URL("../fixtures/graphs/", import.meta.url));
export const mutationOwnershipDocsPath = fileURLToPath(new URL("../../docs/mutation-ownership.md", import.meta.url));
export const graphValidatorOutcomesPath = fileURLToPath(new URL("../fixtures/graph-validator-outcomes.json", import.meta.url));
export const cliGoldensPath = fileURLToPath(new URL("../fixtures/cli-goldens.json", import.meta.url));
export const graphSchemaPath = fileURLToPath(new URL("../../schemas/plan-graph.schema.json", import.meta.url));
export const graphValidatorOutcomes = JSON.parse(await readFile(graphValidatorOutcomesPath, "utf8"));

// Tests must never inherit a developer's live Slack webhook. Individual Slack
// send coverage opts in with a local fake webhook server.
delete process.env.SLACK_WEBHOOK_URL;

after(async () => {
  if (originalSlackWebhookUrl === undefined) {
    delete process.env.SLACK_WEBHOOK_URL;
  } else {
    process.env.SLACK_WEBHOOK_URL = originalSlackWebhookUrl;
  }
  if (stableDistIsTemporary) {
    await rm(dirname(stableDistDir), { recursive: true, force: true });
  }
});

export const {
  answerNode,
  attachReadyPriorityFields,
  blockNode,
  buildPlannerPrompt,
  buildPlannerRuntimeRequest,
  buildSlackNotificationText,
  buildNodeWorkBranchName,
  buildReachableDepthMap,
  buildReachableParentMap,
  buildStableRootPathMap,
  buildReadyPrioritySelections,
  buildWorkerPrompt,
  buildVisualizerPayload,
  claimNode,
  compareReadyPriorityCandidates,
  completeNode,
  countSharedParentsWithCurrentTask,
  createRunClone,
  createFixturePlannerRuntime,
  createWorkBranch,
  createVisualizerServer,
  defaultReportPath,
  decomposeNode,
  diagnoseGraph,
  failNode,
  exportOperationalEvents,
  formatWorkerReport,
  installGraphIoFaultInjectorForTests,
  isLocalVisualizerHost,
  listWorkingNodes,
  listReadyLeafNodes,
  operationalEvents,
  operationalEventTaxonomy,
  parseArgs,
  parseCodexArgs,
  parseChildrenArgs,
  planNodeDecomposition,
  prepareBareRepository,
  publishOutputRef,
  readGraph,
  reconcileGraphStatus,
  recordWorkerRefMetadata,
  releaseExpiredLeases,
  renewNodeLease,
  resetReachable,
  resetNode,
  resetSubtree,
  renderCliHelp,
  renderPlanAfterUpdate,
  renderVisualizerHtml,
  resolveNodeBaseRef,
  runGitCommand,
  runCodexPrompt,
  resolveWorkerIsolation,
  runWorker,
  schedulerTransitionTable,
  sendSlackNotification,
  startNode,
  startLeaseHeartbeat,
  redactOperationalEventDetails,
  summarizeGraph,
  visualizerHostSecurityWarning,
  withGraphLock,
  writeGraphAtomic,
  writeReportFile
} = await import(schedulerScriptUrl.href);
export const { buildPlanarLayout, renderPlanarSvg } = await import(layoutScriptUrl.href);
export const { checkSchedulerTransitionReference } = await import(transitionReferenceScriptUrl.href);
export const { defaultGraphPath: packageDefaultGraphPath } = await import(packageGraphIoScriptUrl.href);
export const { validatePlanGraphFileResult } = await import(contractsScriptUrl.href);
export const { buildPlanGraphJsonSchema } = await import(graphSchemaScriptUrl.href);
export const { createWorkerManager: createRawWorkerManager } = await import(visualizerScriptUrl.href);

export const execFileAsync = promisify(execFile);

export function graphFixturePath(fixtureName) {
  return join(graphFixturesDir, fixtureName);
}

export function invalidGraphValidatorOutcomes() {
  return graphValidatorOutcomes.filter((outcome) => !outcome.valid);
}

export function validGraphValidatorOutcomes() {
  return graphValidatorOutcomes.filter((outcome) => outcome.valid);
}

export async function copyGraphFixtureToTemp(fixtureName) {
  const dir = await mkdtemp(join(tmpdir(), "graph-fixture-"));
  const graphPath = join(dir, fixtureName);
  await cp(graphFixturePath(fixtureName), graphPath);
  return { dir, graphPath };
}

export async function copyBuiltDist() {
  const sourceRootDir = fileURLToPath(new URL("../..", import.meta.url));
  const sourceDistDir = fileURLToPath(new URL("../../dist", import.meta.url));
  if (!existsSync(join(sourceDistDir, "scripts", "plan-scheduler.js"))) {
    throw new Error("Missing built plan-scheduler module in dist/scripts. Run npm run build before tests.");
  }
  if (!stableDistIsTemporary) {
    return realpath(sourceDistDir);
  }
  const targetParent = await mkdtemp(join(tmpdir(), "plan-scheduler-dist-"));
  const targetDistDir = join(targetParent, "dist");
  await cp(sourceDistDir, targetDistDir, { recursive: true });
  await cp(join(sourceRootDir, "prompts"), join(targetParent, "prompts"), { recursive: true });
  return realpath(targetDistDir);
}

export function builtScriptUrl(scriptName) {
  const targetPath = join(stableDistDir, "scripts", `${scriptName}.js`);
  if (!existsSync(targetPath)) {
    throw new Error(`Missing built ${scriptName} module in dist/scripts. Run npm run build before tests.`);
  }
  return pathToFileURL(targetPath);
}

export function originalBuiltScriptUrl(scriptName) {
  const target = new URL(`../../dist/scripts/${scriptName}.js`, import.meta.url);
  if (!existsSync(target)) {
    throw new Error(`Missing built ${scriptName} module in dist/scripts. Run npm run build before tests.`);
  }
  return target;
}

export function builtBinPath(binName) {
  const binEntry = packageJson.bin?.[binName];
  assert.equal(typeof binEntry, "string", `Missing package bin entry: ${binName}`);
  const normalizedEntry = binEntry.replace(/^\.\//, "");
  const builtEntry = normalizedEntry.startsWith("dist/") ? normalizedEntry : `dist/${normalizedEntry}`;
  return builtEntry.startsWith("dist/")
    ? join(stableDistDir, builtEntry.slice("dist/".length))
    : fileURLToPath(new URL(`../../${builtEntry}`, import.meta.url));
}
export function fixtureGraph() {
  return {
    graphVersion: 1,
    title: "Fixture Implementation Plan",
    description: "Coordinate fixture work across a series root, parallel branches, and a final gate.",
    scheduler: { leaseSeconds: 1 },
    graph: {
      root: "ROOT",
      nodes: {
        ROOT: { title: "Root", kind: "series", status: "pending", children: ["A", "P", "G"] },
        A: { title: "Bootstrap", kind: "task", status: "pending" },
        P: { title: "Parallel work", kind: "parallel", status: "pending", children: ["B", "C"] },
        B: { title: "Branch B", kind: "task", status: "pending" },
        C: { title: "Branch C", kind: "task", status: "pending" },
        G: { title: "Gate", kind: "gate", status: "pending" }
      }
    }
  };
}

export function nestedResetReachabilityGraph() {
  const doneTask = (title) => ({ title, kind: "task", status: "done", report: `reports/${title}.md` });

  return {
    graphVersion: 1,
    title: "Nested Reset Reachability",
    graph: {
      root: "ROOT",
      nodes: {
        ROOT: { title: "Root", kind: "series", status: "done", children: ["PREP", "FANOUT", "TAIL", "CLEANUP"] },
        PREP: { title: "Prep", kind: "series", status: "done", children: ["P1", "P2"] },
        P1: doneTask("P1"),
        P2: doneTask("P2"),
        FANOUT: { title: "Fanout", kind: "parallel", status: "done", children: ["LEFT", "RIGHT"] },
        LEFT: { title: "Left", kind: "series", status: "done", children: ["L1", "L2"] },
        L1: doneTask("L1"),
        L2: doneTask("L2"),
        RIGHT: { title: "Right", kind: "parallel", status: "done", children: ["R1", "RN"] },
        R1: doneTask("R1"),
        RN: { title: "Right nested", kind: "series", status: "done", children: ["RN1", "RN2"] },
        RN1: doneTask("RN1"),
        RN2: doneTask("RN2"),
        TAIL: { title: "Tail", kind: "series", status: "done", children: ["T1", "T2"] },
        T1: doneTask("T1"),
        T2: doneTask("T2"),
        CLEANUP: doneTask("CLEANUP"),
        ORPHAN: { title: "Orphan", kind: "series", status: "done", children: ["O1", "O2"] },
        O1: doneTask("O1"),
        O2: doneTask("O2")
      }
    }
  };
}

export function deepReadinessGraph(statuses = {}) {
  const node = (title, kind, status = "pending", children) => ({
    title,
    kind,
    status: statuses[title] || status,
    ...(children ? { children } : {})
  });

  return {
    graphVersion: 1,
    title: "Deep Readiness Plan",
    graph: {
      root: "ROOT",
      nodes: {
        ROOT: { title: "ROOT", kind: "series", status: statuses.ROOT || "pending", children: ["SETUP", "FANOUT", "FINAL_GATE", "AFTER"] },
        SETUP: { title: "SETUP", kind: "series", status: statuses.SETUP || "pending", children: ["S1", "S2"] },
        S1: node("S1", "task"),
        S2: node("S2", "task"),
        FANOUT: { title: "FANOUT", kind: "parallel", status: statuses.FANOUT || "pending", children: ["LEFT", "RIGHT", "UNKNOWN_GROUP", "GATE_BRANCH", "BLOCKED_LEAF", "FAILED_LEAF", "CUSTOM_STATUS"] },
        LEFT: { title: "LEFT", kind: "series", status: statuses.LEFT || "pending", children: ["L1", "L2"] },
        L1: node("L1", "task"),
        L2: node("L2", "task"),
        RIGHT: { title: "RIGHT", kind: "parallel", status: statuses.RIGHT || "pending", children: ["R1", "R2"] },
        R1: node("R1", "task"),
        R2: node("R2", "task"),
        UNKNOWN_GROUP: { title: "UNKNOWN_GROUP", kind: "unknown-wrapper", status: statuses.UNKNOWN_GROUP || "pending", children: ["U1", "U2"] },
        U1: node("U1", "task"),
        U2: node("U2", "task"),
        GATE_BRANCH: node("GATE_BRANCH", "gate"),
        BLOCKED_LEAF: node("BLOCKED_LEAF", "task", "blocked"),
        FAILED_LEAF: node("FAILED_LEAF", "task", "failed"),
        CUSTOM_STATUS: node("CUSTOM_STATUS", "task", "waiting-for-signal"),
        FINAL_GATE: node("FINAL_GATE", "gate"),
        AFTER: node("AFTER", "task")
      }
    }
  };
}

export function depthPriorityGraph() {
  return {
    graphVersion: 1,
    title: "Depth Priority Fixture",
    description: "Traversal reaches A_DEEP first, but depth priority should choose Z_SHALLOW.",
    priorityFixture: {
      rule: "depth",
      traversalFirst: "A_DEEP",
      expectedWinner: "Z_SHALLOW"
    },
    graph: {
      root: "ROOT",
      nodes: {
        ROOT: { title: "Root", kind: "parallel", status: "pending", children: ["DEEP_WRAP", "Z_SHALLOW"] },
        DEEP_WRAP: { title: "Deep wrapper", kind: "series", status: "pending", children: ["A_DEEP"] },
        A_DEEP: { title: "Deeper ready task", kind: "task", status: "pending" },
        Z_SHALLOW: { title: "Expected winner: shallower ready task", kind: "task", status: "pending" }
      }
    }
  };
}

export function leafOnlyChildCountPriorityGraph() {
  return {
    graphVersion: 1,
    title: "Leaf-Only Child Count Priority Fixture",
    description: "Under the leaf-only readiness contract, child_count ties at 0 for claimable candidates.",
    priorityFixture: {
      rule: "child_count",
      contract: "leaf-only",
      expectedWinner: "A_NO_CHILDREN"
    },
    graph: {
      root: "ROOT",
      nodes: {
        ROOT: {
          title: "Root",
          kind: "parallel",
          status: "pending",
          children: ["WIDE_INTERNAL", "B_EMPTY_CHILDREN", "A_NO_CHILDREN"]
        },
        WIDE_INTERNAL: {
          title: "Internal node with more children is not a claimable leaf",
          kind: "parallel",
          status: "pending",
          children: ["WIDE_DONE_1", "WIDE_DONE_2", "WIDE_DONE_3"]
        },
        WIDE_DONE_1: { title: "Wide child one", kind: "task", status: "done" },
        WIDE_DONE_2: { title: "Wide child two", kind: "task", status: "done" },
        WIDE_DONE_3: { title: "Wide child three", kind: "task", status: "done" },
        B_EMPTY_CHILDREN: { title: "Leaf represented by an empty children array", kind: "task", status: "pending", children: [] },
        A_NO_CHILDREN: { title: "Expected winner: child_count ties resolve by id", kind: "task", status: "pending" }
      }
    }
  };
}

export function sharedParentPriorityGraph() {
  return {
    graphVersion: 1,
    title: "Shared Parent Priority Fixture",
    description: "Candidates tie on depth and child_count; Z_FAR shares the fewest parents with CURRENT.",
    priorityFixture: {
      rule: "shared_parent_count_with_current_task",
      currentTaskId: "CURRENT",
      expectedWinner: "ZZ_FAR_TIE",
      fallbackWinner: "A_NEAR",
      tiedSharedParentWinner: "ZZ_FAR_TIE"
    },
    graph: {
      root: "ROOT",
      nodes: {
        ROOT: { title: "Root", kind: "parallel", status: "pending", children: ["WORK", "OTHER"] },
        WORK: { title: "Shared work area", kind: "parallel", status: "pending", children: ["LEFT", "RIGHT"] },
        LEFT: { title: "Left group", kind: "parallel", status: "pending", children: ["CURRENT", "A_NEAR"] },
        CURRENT: { title: "Current task context", kind: "task", status: "done" },
        A_NEAR: { title: "Shares ROOT, WORK, and LEFT with current task", kind: "task", status: "pending" },
        RIGHT: { title: "Right group", kind: "parallel", status: "pending", children: ["B_MID"] },
        B_MID: { title: "Shares ROOT and WORK with current task", kind: "task", status: "pending" },
        OTHER: { title: "Other work area", kind: "parallel", status: "pending", children: ["FAR_GROUP"] },
        FAR_GROUP: { title: "Far group", kind: "parallel", status: "pending", children: ["ZZ_FAR_TIE", "Z_FAR"] },
        Z_FAR: { title: "Shares only ROOT with current task", kind: "task", status: "pending" },
        ZZ_FAR_TIE: { title: "Expected winner: tied far candidate with the lowest raw node id", kind: "task", status: "pending" }
      }
    }
  };
}

export function completedDeepReadinessGraph() {
  return deepReadinessGraph({
    ROOT: "done",
    SETUP: "done",
    S1: "done",
    S2: "done",
    FANOUT: "done",
    LEFT: "done",
    L1: "done",
    L2: "done",
    RIGHT: "done",
    R1: "done",
    R2: "done",
    UNKNOWN_GROUP: "done",
    U1: "done",
    U2: "done",
    GATE_BRANCH: "done",
    BLOCKED_LEAF: "done",
    FAILED_LEAF: "done",
    CUSTOM_STATUS: "done",
    FINAL_GATE: "done",
    AFTER: "done"
  });
}

export function concurrentMutationGraph() {
  const future = "2999-01-01T00:00:00.000Z";
  const past = "2026-05-27T00:00:00.000Z";
  const leasedNode = (title, status, session, runId, expiresAt = future) => ({
    title,
    kind: "task",
    status,
    lease: {
      session,
      runId,
      claimedAt: "2026-05-27T00:00:00.000Z",
      expiresAt
    }
  });

  return {
    graphVersion: 1,
    title: "Concurrent Mutation Regression Plan",
    description: "Fixture for reproducible multi-worker mutation races.",
    scheduler: { leaseSeconds: 30 },
    graph: {
      root: "ROOT",
      nodes: {
        ROOT: {
          title: "Root",
          kind: "parallel",
          status: "pending",
          children: ["RENEW", "EXPIRE", "COMPLETE", "FAIL", "RESET", "DECOMPOSE"]
        },
        RENEW: leasedNode("Renew in place", "running", "renew-owner", "run-renew"),
        EXPIRE: leasedNode("Expired lease", "running", "expired-owner", "run-expired", past),
        COMPLETE: leasedNode("Complete concurrently", "running", "complete-owner", "run-complete"),
        FAIL: leasedNode("Fail concurrently", "running", "fail-owner", "run-fail"),
        RESET: { title: "Reset concurrently", kind: "task", status: "done", report: "reports/reset.md" },
        DECOMPOSE: leasedNode("Decompose concurrently", "running", "decompose-owner", "run-decompose")
      }
    }
  };
}

export function renderRaceGraph() {
  return {
    graphVersion: 1,
    title: "Concurrent Render Regression Plan",
    description: "Fixture for render-after-update serialization.",
    scheduler: { htmlView: "plan.html" },
    document: {
      pageTitle: "Concurrent Render Regression Plan",
      intro: ["Render should reflect all completed updates after concurrent update/render pipelines."],
      sections: [{ heading: "Regression", paragraphs: ["Concurrent render pipelines completed."] }]
    },
    graph: {
      root: "ROOT",
      nodes: {
        ROOT: { title: "Root", kind: "parallel", status: "pending", children: ["R1", "R2", "R3", "R4"] },
        R1: { title: "Render race one", kind: "task", status: "pending" },
        R2: { title: "Render race two", kind: "task", status: "pending" },
        R3: { title: "Render race three", kind: "task", status: "pending" },
        R4: { title: "Render race four", kind: "task", status: "pending" }
      }
    }
  };
}

export async function withTempGraph(fn) {
  const dir = await mkdtemp(join(tmpdir(), "plan-scheduler-"));
  const graphPath = join(dir, "plan.graph.json");
  await writeFile(graphPath, `${JSON.stringify(fixtureGraph(), null, 2)}\n`, "utf8");
  try {
    await fn(graphPath, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function withLocalBareRemote(fn) {
  const dir = await mkdtemp(join(tmpdir(), "git-runtime-"));
  const sourcePath = join(dir, "source");
  const remotePath = join(dir, "remote.git");
  await mkdir(sourcePath);
  await execFileAsync("git", ["init"], { cwd: sourcePath });
  await execFileAsync("git", ["checkout", "-B", "main"], { cwd: sourcePath });
  await execFileAsync("git", ["config", "user.email", "scheduler-tests@example.test"], { cwd: sourcePath });
  await execFileAsync("git", ["config", "user.name", "Scheduler Tests"], { cwd: sourcePath });
  await writeFile(join(sourcePath, "README.md"), "fixture\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: sourcePath });
  await execFileAsync("git", ["commit", "-m", "initial fixture"], { cwd: sourcePath });
  await execFileAsync("git", ["clone", "--bare", sourcePath, remotePath]);

  try {
    await fn({ dir, sourcePath, remotePath });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function writeWorkerIsolationGraph(graphPath, remotePath, graph = fixtureGraph()) {
  graph.scheduler = {
    ...(graph.scheduler || {}),
    remote: remotePath
  };
  await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
}

export function parallelWorkerIsolationGraph(remotePath) {
  return {
    graphVersion: 1,
    title: "Parallel Worker Isolation Plan",
    scheduler: { remote: remotePath, leaseSeconds: 5 },
    graph: {
      root: "ROOT",
      nodes: {
        ROOT: { title: "Root", kind: "parallel", status: "pending", children: ["A", "B"] },
        A: { title: "Branch A", kind: "task", status: "pending" },
        B: { title: "Branch B", kind: "task", status: "pending" }
      }
    }
  };
}

export async function writeCommittingWorkerRunner(runnerPath) {
  await writeFile(
    runnerPath,
    [
      "import { execFileSync } from 'node:child_process';",
      "import { writeFileSync } from 'node:fs';",
      "const prompt = process.argv.at(-1) || '';",
      "const nodeId = prompt.match(/^- Node: (.+)$/m)?.[1] || 'unknown';",
      "const runId = prompt.match(/^- Run: (.+)$/m)?.[1] || 'unknown';",
      "const cwd = process.cwd();",
      "execFileSync('git', ['config', 'user.email', 'scheduler-tests@example.test']);",
      "execFileSync('git', ['config', 'user.name', 'Scheduler Tests']);",
      "const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();",
      "writeFileSync(`worker-output-${nodeId}.txt`, `node=${nodeId}\\nrun=${runId}\\ncwd=${cwd}\\nbranch=${branch}\\n`);",
      "writeFileSync('shared-name.txt', `${nodeId}\\n`);",
      "execFileSync('git', ['add', `worker-output-${nodeId}.txt`, 'shared-name.txt']);",
      "execFileSync('git', ['commit', '-m', `worker output ${nodeId}`]);",
      "console.log(`node=${nodeId}`);",
      "console.log(`cwd=${cwd}`);",
      "console.log(`branch=${branch}`);"
    ].join("\n"),
    "utf8"
  );
}

export async function writeNoopWorkerRunner(runnerPath) {
  await writeFile(
    runnerPath,
    [
      "import { execFileSync } from 'node:child_process';",
      "const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();",
      "console.log(`noop cwd=${process.cwd()}`);",
      "console.log(`noop branch=${branch}`);"
    ].join("\n"),
    "utf8"
  );
}

export async function gitShow(bareRepoPath, ref, filePath) {
  const { stdout } = await execFileAsync("git", ["--git-dir", bareRepoPath, "show", `${ref}:${filePath}`]);
  return stdout;
}

export async function createSourceBranch({ sourcePath, remotePath, branchName, files, message }) {
  await execFileAsync("git", ["checkout", "-B", branchName, "main"], { cwd: sourcePath });
  for (const [filePath, contents] of Object.entries(files)) {
    const fileDir = dirname(filePath);
    if (fileDir !== ".") {
      await mkdir(join(sourcePath, fileDir), { recursive: true });
    }
    await writeFile(join(sourcePath, filePath), contents, "utf8");
  }
  await execFileAsync("git", ["add", "."], { cwd: sourcePath });
  await execFileAsync("git", ["commit", "-m", message], { cwd: sourcePath });
  await execFileAsync("git", ["push", remotePath, `${branchName}:refs/heads/${branchName}`], { cwd: sourcePath });
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: sourcePath });
  await execFileAsync("git", ["checkout", "main"], { cwd: sourcePath });
  return {
    name: `refs/heads/${branchName}`,
    commit: stdout.trim()
  };
}

export async function prepareCompositionBareRepository({ graphDir, remotePath }) {
  const bareRepoPath = join(graphDir, "runs", "git", "cache", "repo.git");
  await prepareBareRepository({ remote: remotePath, bareRepoPath });
  return bareRepoPath;
}

export const knownTransitionStatuses = ["pending", "claimed", "running", "blocked", "review", "failed", "done"];

export async function setNodeStatus(graphPath, nodeId, status, { lease = false, expiresAt } = {}) {
  const graph = await readGraph(graphPath);
  const node = graph.graph.nodes[nodeId];
  node.status = status;
  delete node.startedAt;
  delete node.completedAt;
  delete node.failedAt;
  delete node.failureReason;
  delete node.blockedAt;
  delete node.blockedReason;
  delete node.question;
  delete node.report;
  if (lease) {
    node.lease = {
      session: "owner",
      runId: `run-${nodeId}-${status}`,
      claimedAt: "2026-05-27T00:00:00.000Z",
      expiresAt: expiresAt || "2999-01-01T00:00:00.000Z"
    };
  } else {
    delete node.lease;
  }
  await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
}

export async function addUnknownMetadata(graphPath) {
  const graph = await readGraph(graphPath);
  graph.vendorTopLevel = { retained: true, scope: "file" };
  graph.scheduler = {
    ...graph.scheduler,
    vendorScheduler: { retained: true, scope: "scheduler" }
  };
  graph.graph.vendorGraph = { retained: true, scope: "graph" };
  graph.document = {
    pageTitle: "Metadata Fixture",
    vendorDocument: { retained: true, scope: "document" }
  };
  for (const [nodeId, node] of Object.entries(graph.graph.nodes)) {
    node.vendorNode = { retained: true, nodeId };
  }
  await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
}

export function assertUnknownMetadata(graph, nodeId = "A") {
  assert.deepEqual(graph.vendorTopLevel, { retained: true, scope: "file" });
  assert.deepEqual(graph.scheduler.vendorScheduler, { retained: true, scope: "scheduler" });
  assert.deepEqual(graph.graph.vendorGraph, { retained: true, scope: "graph" });
  assert.deepEqual(graph.document.vendorDocument, { retained: true, scope: "document" });
  assert.deepEqual(graph.graph.nodes[nodeId].vendorNode, { retained: true, nodeId });
}

export function lastHistory(node) {
  assert.ok(Array.isArray(node.history), "expected node history");
  return node.history.at(-1);
}

export function readyIds(graph) {
  return listReadyLeafNodes(graph).map((node) => node.id);
}

export function normalizeWorkerReport(report) {
  return report
    .replaceAll(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<iso-date>")
    .replaceAll(/- Duration ms: \d+/g, "- Duration ms: <duration-ms>");
}

export async function waitFor(predicate, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error("Timed out waiting for condition");
}

export function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export async function lockArtifacts(dir) {
  return (await readdir(dir)).filter((entry) => entry.includes(".lock") || entry.endsWith(".tmp")).sort();
}

export async function assertCliFails(args, stderrPattern, options = {}) {
  await assert.rejects(
    execFileAsync(process.execPath, [schedulerScriptPath, ...args], options),
    (error) => {
      assert.equal(error.stdout, "");
      assert.match(error.stderr, stderrPattern);
      assert.doesNotMatch(error.stderr, /\n\s+at /);
      return true;
    }
  );
}

export async function captureSchedulerCli(args, { env = {}, replacements = {} } = {}) {
  const childEnv = { ...process.env, SLACK_WEBHOOK_URL: "", ...env };
  try {
    const result = await execFileAsync(process.execPath, [schedulerScriptPath, ...args], { env: childEnv });
    return normalizeCliCapture({
      exitCode: 0,
      stdout: result.stdout,
      stderr: result.stderr
    }, replacements);
  } catch (error) {
    return normalizeCliCapture({
      exitCode: error.code || 1,
      stdout: error.stdout || "",
      stderr: error.stderr || ""
    }, replacements);
  }
}

export function normalizeCliCapture(capture, replacements) {
  return {
    exitCode: capture.exitCode,
    stdout: normalizeCliStream(capture.stdout, replacements),
    stderr: normalizeCliStream(capture.stderr, replacements)
  };
}

export function normalizeCliStream(stream, replacements) {
  const text = normalizeDynamicText(String(stream || "").trimEnd(), replacements);
  if (!text) {
    return "";
  }
  if (!/^[{[]/.test(text)) {
    return text;
  }
  try {
    return normalizeDynamicValue(JSON.parse(text), replacements);
  } catch {
    return text;
  }
}

export function normalizeDynamicValue(value, replacements) {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeDynamicValue(entry, replacements));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, normalizeDynamicValue(entry, replacements)])
    );
  }
  return typeof value === "string" ? normalizeDynamicText(value, replacements) : value;
}

export function normalizeDynamicText(value, replacements) {
  let normalized = value;
  for (const [actual, replacement] of Object.entries(replacements)) {
    normalized = normalized.replaceAll(actual, replacement);
  }
  return normalized
    .replaceAll(/run_\d{8}_\d{9}_[A-Za-z0-9_-]+_[0-9a-f]{8}/g, "<run-id>")
    .replaceAll(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<iso-date>");
}

export async function assertCliGolden(actual) {
  if (process.env.UPDATE_CLI_GOLDENS === "1") {
    await writeFile(cliGoldensPath, `${JSON.stringify(actual, null, 2)}\n`, "utf8");
  }

  const expected = JSON.parse(await readFile(cliGoldensPath, "utf8"));
  assert.deepEqual(
    actual,
    expected,
    "CLI golden output changed. Review the diff, then run UPDATE_CLI_GOLDENS=1 npm test -- --test-name-pattern 'CLI golden outputs cover public command shapes' to accept intentional public output changes."
  );
}

export function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function graphValidationCases() {
  return [
    {
      name: "missing graph body",
      mutate(graph) {
        delete graph.graph;
      },
      pathPattern: /\$\.graph/,
      messagePattern: /Expected graph body to be an object/
    },
    {
      name: "missing root id",
      mutate(graph) {
        delete graph.graph.root;
      },
      pathPattern: /\$\.graph\.root/,
      messagePattern: /Expected root node id string/
    },
    {
      name: "root id absent from nodes map",
      mutate(graph) {
        graph.graph.root = "MISSING_ROOT";
      },
      pathPattern: /\$\.graph\.root/,
      messagePattern: /Root node is not present in nodes: MISSING_ROOT/
    },
    {
      name: "missing nodes map",
      mutate(graph) {
        delete graph.graph.nodes;
      },
      pathPattern: /\$\.graph\.nodes/,
      messagePattern: /Expected node map object/
    },
    {
      name: "unknown child id",
      mutate(graph) {
        graph.graph.nodes.ROOT.children = ["MISSING"];
      },
      pathPattern: /\$\.graph\.nodes\.ROOT\.children/,
      messagePattern: /Unknown child node id: MISSING/
    },
    {
      name: "non-array children",
      mutate(graph) {
        graph.graph.nodes.ROOT.children = "A";
      },
      pathPattern: /\$\.graph\.nodes\.ROOT\.children/,
      messagePattern: /Expected children to be an array of node id strings/
    },
    {
      name: "children array with non-string ids",
      mutate(graph) {
        graph.graph.nodes.ROOT.children = ["A", 42];
      },
      pathPattern: /\$\.graph\.nodes\.ROOT\.children/,
      messagePattern: /Expected children to be an array of node id strings/
    },
    {
      name: "duplicate child id",
      mutate(graph) {
        graph.graph.nodes.ROOT.children = ["A", "A", "P", "G"];
      },
      pathPattern: /\$\.graph\.nodes\.ROOT\.children\[1\]/,
      messagePattern: /Duplicate child node id: A/
    },
    {
      name: "cycle in child topology",
      mutate(graph) {
        graph.graph.nodes.P.children = ["B", "ROOT"];
      },
      pathPattern: /\$\.graph\.nodes\.P\.children\[1\]/,
      messagePattern: /Cycle detected: ROOT -> P -> ROOT/
    },
    {
      name: "empty internal node children",
      mutate(graph) {
        graph.graph.nodes.P.children = [];
      },
      pathPattern: /\$\.graph\.nodes\.P\.children/,
      messagePattern: /parallel node must define at least one child/
    },
    {
      name: "invalid lease shape",
      mutate(graph) {
        graph.graph.nodes.A.status = "claimed";
        graph.graph.nodes.A.lease = { session: "codex-A", claimedAt: "2026-05-27T00:00:00.000Z" };
      },
      pathPattern: /\$\.graph\.nodes\.A\.lease\.runId/,
      messagePattern: /Expected lease runId string/
    },
    {
      name: "invalid timestamp shape",
      mutate(graph) {
        graph.graph.nodes.A.startedAt = "not-a-timestamp";
      },
      pathPattern: /\$\.graph\.nodes\.A\.startedAt/,
      messagePattern: /Expected timestamp string/
    }
  ];
}

export function createSeededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

export function randomInt(random, exclusiveMax) {
  return Math.floor(random() * exclusiveMax);
}

export function chooseSeeded(random, values) {
  return values[randomInt(random, values.length)];
}

export function generateSeededTopologyGraph(seed) {
  const random = createSeededRandom(seed);
  const nodeCount = 2 + randomInt(random, 7);
  const nodes = {};

  for (let index = 0; index < nodeCount; index += 1) {
    const nodeId = `N${index}`;
    nodes[nodeId] = {
      title: `Generated node ${index}`,
      status: chooseSeeded(random, ["pending", "pending", "done", "claimed", "running", "blocked", "review", "failed"]),
      children: []
    };
  }

  for (let childIndex = 1; childIndex < nodeCount; childIndex += 1) {
    const parentId = `N${randomInt(random, childIndex)}`;
    nodes[parentId].children.push(`N${childIndex}`);
  }

  for (let parentIndex = 0; parentIndex < nodeCount - 1; parentIndex += 1) {
    for (let childIndex = parentIndex + 1; childIndex < nodeCount; childIndex += 1) {
      const parent = nodes[`N${parentIndex}`];
      const childId = `N${childIndex}`;
      if (!parent.children.includes(childId) && random() < 0.18) {
        parent.children.push(childId);
      }
    }
  }

  for (const node of Object.values(nodes)) {
    if (node.children.length > 0) {
      node.kind = chooseSeeded(random, ["series", "parallel"]);
    } else {
      delete node.children;
      node.kind = chooseSeeded(random, ["task", "gate"]);
    }
  }

  return {
    graphVersion: seed,
    title: `Generated topology ${seed}`,
    graph: {
      root: "N0",
      nodes
    }
  };
}

export function generatedParentWithChildren(graph, seed) {
  const parents = Object.entries(graph.graph.nodes)
    .filter(([, node]) => Array.isArray(node.children) && node.children.length > 0)
    .map(([nodeId]) => nodeId);
  assert.ok(parents.length > 0, `seed ${seed} should generate at least one parent`);
  return parents[seed % parents.length];
}

export function generatedLeafNodeId(graph) {
  return Object.entries(graph.graph.nodes)
    .find(([, node]) => !Array.isArray(node.children) || node.children.length === 0)?.[0];
}

export function createGeneratedMalformedVariant(seed, variant) {
  const graph = generateSeededTopologyGraph(seed);
  if (variant === "missing-child") {
    const parentId = generatedParentWithChildren(graph, seed);
    const parent = graph.graph.nodes[parentId];
    const missingChildId = `MISSING_${seed}`;
    const childIndex = parent.children.length;
    parent.children.push(missingChildId);
    return {
      graph,
      expectedPath: `$.graph.nodes.${parentId}.children[${childIndex}]`,
      expectedMessage: `Unknown child node id: ${missingChildId}`
    };
  }
  if (variant === "duplicate-child") {
    const parentId = generatedParentWithChildren(graph, seed);
    const parent = graph.graph.nodes[parentId];
    const duplicateChildId = parent.children[0];
    const childIndex = parent.children.length;
    parent.children.push(duplicateChildId);
    return {
      graph,
      expectedPath: `$.graph.nodes.${parentId}.children[${childIndex}]`,
      expectedMessage: `Duplicate child node id: ${duplicateChildId}`
    };
  }
  if (variant === "cycle") {
    const nodeIds = Object.keys(graph.graph.nodes);
    const cycleNodeId = nodeIds.at(-1);
    const cycleNode = graph.graph.nodes[cycleNodeId];
    cycleNode.children = ["N0"];
    return {
      graph,
      expectedPath: `$.graph.nodes.${cycleNodeId}.children[0]`,
      expectedMessage: "Cycle detected"
    };
  }
  throw new Error(`Unknown generated malformed variant: ${variant}`);
}

export function generatedWarningVariant(seed, variant) {
  const graph = generateSeededTopologyGraph(seed);
  if (variant === "unknown-kind") {
    const parentId = generatedParentWithChildren(graph, seed);
    graph.graph.nodes[parentId].kind = `custom-wrapper-${seed}`;
    return {
      graph,
      expectedPath: `$.graph.nodes.${parentId}.kind`,
      expectedMessage: `Unknown node kind: custom-wrapper-${seed}`
    };
  }
  if (variant === "custom-status") {
    const leafNodeId = generatedLeafNodeId(graph);
    assert.equal(typeof leafNodeId, "string", `seed ${seed} should generate at least one leaf`);
    graph.graph.nodes[leafNodeId].status = `waiting-for-signal-${seed}`;
    return {
      graph,
      expectedPath: `$.graph.nodes.${leafNodeId}.status`,
      expectedMessage: `Unknown node status: waiting-for-signal-${seed}`
    };
  }
  throw new Error(`Unknown generated warning variant: ${variant}`);
}

export function validateThenTraverseGraph(graph) {
  const validation = validatePlanGraphFileResult(graph);
  if (validation.errors.length > 0) {
    return { validation, traversed: false };
  }
  const ready = listReadyLeafNodes(graph);
  const summary = summarizeGraph(graph);
  return { validation, traversed: true, ready, summary };
}

export function assertGeneratedGraphReachableAndAcyclic(graph) {
  const reachable = new Set();
  const visiting = new Set();
  const visited = new Set();

  function visit(nodeId) {
    assert.ok(!visiting.has(nodeId), `cycle reached at ${nodeId}`);
    if (visited.has(nodeId)) {
      return;
    }
    const node = graph.graph.nodes[nodeId];
    assert.ok(node, `missing generated node ${nodeId}`);
    reachable.add(nodeId);
    visiting.add(nodeId);
    for (const childId of node.children || []) {
      visit(childId);
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
  }

  visit(graph.graph.root);
  assert.deepEqual([...reachable].sort(), Object.keys(graph.graph.nodes).sort());
}

export function assertGeneratedTraversalSafe(graph, label) {
  const result = validateThenTraverseGraph(graph);
  assert.deepEqual(result.validation.errors, [], `${label} should not have validation errors`);
  assert.equal(result.traversed, true, `${label} should traverse after validation`);
  assert.equal(result.summary.totalNodes, Object.keys(graph.graph.nodes).length);

  for (const readyNode of result.ready) {
    const graphNode = graph.graph.nodes[readyNode.id];
    assert.ok(graphNode, `${label} returned unknown ready node ${readyNode.id}`);
    assert.ok(!Array.isArray(graphNode.children) || graphNode.children.length === 0, `${label} returned non-leaf ${readyNode.id}`);
    assert.equal(readyNode.status, graphNode.status || "pending");
  }
}

export function assertGeneratedPathSpecificFailure(graph, expectedPath, expectedMessage, label) {
  const result = validateThenTraverseGraph(graph);
  assert.equal(result.traversed, false, `${label} should fail validation before traversal`);
  assert.ok(result.validation.errors.length > 0, `${label} should have validation errors`);
  assert.ok(
    result.validation.errors.some((issue) => issue.path === expectedPath && issue.message.includes(expectedMessage)),
    `${label} missing path-specific error ${expectedPath}: ${expectedMessage}; got ${JSON.stringify(result.validation.errors)}`
  );
}

export function rendererDocumentFixture() {
  return {
    pageTitle: "Invalid Graph",
    intro: ["Renderer should validate first."],
    sections: []
  };
}

export function runVisualizerClientScript() {
  const html = renderVisualizerHtml();
  const script = html.match(/<script>\n([\s\S]*)\n<\/script>/)?.[1];
  assert.equal(typeof script, "string");

  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) {
      elements.set(id, {
        id,
        value: "",
        checked: false,
        dataset: {},
        disabled: false,
        addEventListener() {},
        closest() {
          return undefined;
        },
        querySelector() {
          return element(`${id}:query`);
        },
        get innerHTML() {
          return this._innerHTML || "";
        },
        set innerHTML(value) {
          this._innerHTML = String(value);
        },
        get textContent() {
          return this._textContent || "";
        },
        set textContent(value) {
          this._textContent = String(value);
        }
      });
    }
    return elements.get(id);
  }

  const context = {
    document: {
      addEventListener() {},
      getElementById: element,
      querySelector(selector) {
        return element(`query:${selector}`);
      }
    },
    localStorage: {
      getItem() {
        return null;
      },
      setItem() {}
    },
    EventSource: class {
      constructor() {
        this.onmessage = undefined;
        this.onerror = undefined;
      }
    },
    fetch: async () => ({
      ok: true,
      json: async () => ({
        summary: { graphVersion: 1, totalNodes: 0, counts: {} },
        graphSvg: "<svg></svg>",
        ready: [],
        working: [],
        workerManager: { defaults: {}, workers: [] }
      }),
      text: async () => ""
    })
  };

  runInNewContext(script, context);
  return { context, element };
}

export function assertReadableGraphValidationOutput(output, graphPath, validationCase) {
  assert.match(output, /Invalid graph file/);
  assert.ok(output.includes(graphPath));
  assert.match(output, validationCase.pathPattern);
  assert.match(output, validationCase.messagePattern);
  assert.doesNotMatch(output, /Unknown child node referenced by graph/);
}

export function assertInvalidFixtureFailure(output, graphPath, outcome) {
  assert.ok(output.includes(graphPath), `expected ${graphPath} in ${output}`);
  if (outcome.parseError) {
    assert.match(output, /Failed to parse graph file/);
    return;
  }

  assert.match(output, /Invalid graph file/);
  for (const issue of outcome.errors) {
    assert.ok(output.includes(issue.path), `expected issue path ${issue.path} in ${output}`);
    assert.ok(output.includes(issue.message), `expected issue message ${issue.message} in ${output}`);
  }
  assert.doesNotMatch(output, /Unknown child node referenced by graph/);
}
