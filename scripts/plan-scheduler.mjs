#!/usr/bin/env node
import { createServer } from "node:http";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { renderPlanarSvg } from "./sp-layout.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, "..");
const defaultGraphPath = resolve(rootDir, "plan.graph.json");
const defaultRendererPath = resolve(rootDir, "scripts/render-plan.mjs");
const defaultPromptTemplatePath = resolve(rootDir, "prompts/codex-worker-task.md");
const terminalStatuses = new Set(["done"]);
const busyStatuses = new Set(["claimed", "running", "blocked", "review", "failed"]);
const autoReleasableStatuses = new Set(["claimed", "running"]);

export async function readGraph(graphPath = defaultGraphPath) {
  return JSON.parse(await readFile(graphPath, "utf8"));
}

export async function writeGraphAtomic(graph, graphPath = defaultGraphPath) {
  const tempPath = `${graphPath}.${process.pid}.${Date.now()}.tmp`;
  const content = `${JSON.stringify(graph, null, 2)}\n`;
  await writeFile(tempPath, content, "utf8");
  await rename(tempPath, graphPath);
}

export async function withGraphLock(graphPath, fn, options = {}) {
  const lockPath = options.lockPath || `${graphPath}.lock`;
  const staleMs = options.staleMs ?? 10 * 60 * 1000;
  const retryMs = options.retryMs ?? 100;
  const timeoutMs = options.timeoutMs ?? 5000;
  const startedAt = Date.now();

  while (true) {
    try {
      await mkdir(lockPath);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }

      try {
        const lockStat = await stat(lockPath);
        if (Date.now() - lockStat.mtimeMs > staleMs) {
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch (statError) {
        if (statError?.code !== "ENOENT") {
          throw statError;
        }
      }

      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`Timed out waiting for graph lock: ${lockPath}`);
      }

      await sleep(retryMs);
    }
  }

  try {
    return await fn();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

export function getNode(graph, nodeId) {
  const node = graph.graph?.nodes?.[nodeId];
  if (!node) {
    throw new Error(`Unknown node: ${nodeId}`);
  }
  return node;
}

export function isLeaf(graph, nodeId) {
  const node = getNode(graph, nodeId);
  return !Array.isArray(node.children) || node.children.length === 0;
}

export function isSubtreeDone(graph, nodeId) {
  const node = getNode(graph, nodeId);
  if (isLeaf(graph, nodeId)) {
    return terminalStatuses.has(node.status);
  }
  return node.children.every((childId) => isSubtreeDone(graph, childId));
}

export function summarizeGraph(graph) {
  const counts = {};
  for (const node of Object.values(graph.graph.nodes)) {
    const status = node.status || "pending";
    counts[status] = (counts[status] || 0) + 1;
  }

  return {
    graphVersion: graph.graphVersion,
    totalNodes: Object.keys(graph.graph.nodes).length,
    root: graph.graph.root,
    counts
  };
}

export function listReadyLeafNodes(graph, startId = graph.graph.root) {
  const ready = [];

  function visit(nodeId) {
    const node = getNode(graph, nodeId);
    if (isSubtreeDone(graph, nodeId) || busyStatuses.has(node.status)) {
      return;
    }

    if (isLeaf(graph, nodeId)) {
      if (!busyStatuses.has(node.status) && !terminalStatuses.has(node.status)) {
        ready.push({
          id: nodeId,
          title: node.title,
          kind: node.kind || "task",
          status: node.status || "pending",
          question: node.question,
          answer: node.answer,
          answeredAt: node.answeredAt
        });
      }
      return;
    }

    if (node.kind === "series") {
      const nextChild = node.children.find((childId) => !isSubtreeDone(graph, childId));
      if (nextChild) {
        visit(nextChild);
      }
      return;
    }

    if (node.kind === "parallel") {
      for (const childId of node.children) {
        visit(childId);
      }
      return;
    }

    for (const childId of node.children) {
      visit(childId);
    }
  }

  visit(startId);
  return ready;
}

export function listWorkingNodes(graph) {
  return Object.entries(graph.graph?.nodes || {})
    .filter(([, node]) => node.lease || busyStatuses.has(node.status))
    .map(([id, node]) => ({
      id,
      title: node.title || id,
      kind: node.kind || "task",
      status: node.status || "pending",
      session: node.lease?.session,
      runId: node.lease?.runId,
      claimedAt: node.lease?.claimedAt,
      expiresAt: node.lease?.expiresAt,
      question: node.question,
      answer: node.answer,
      answeredAt: node.answeredAt,
      report: node.report
    }))
    .sort((left, right) => {
      const leftTime = left.claimedAt || left.expiresAt || "";
      const rightTime = right.claimedAt || right.expiresAt || "";
      return leftTime.localeCompare(rightTime) || left.id.localeCompare(right.id);
    });
}

export async function claimNode(graphPath, { session, nodeId, leaseSeconds } = {}) {
  return withGraphLock(graphPath, async () => {
    const graph = await readGraph(graphPath);
    const released = releaseExpiredLeasesInGraph(graph, new Date());
    const ready = listReadyLeafNodes(graph);
    const target = nodeId ? ready.find((node) => node.id === nodeId) : ready[0];

    if (!target) {
      if (released.length > 0) {
        reconcileCompletedSubtrees(graph);
        graph.graphVersion = (graph.graphVersion || 0) + 1;
        await writeGraphAtomic(graph, graphPath);
      }
      throw new Error(nodeId ? `Node is not ready to claim: ${nodeId}` : "No ready nodes to claim");
    }

    const leaseDuration = leaseSeconds ?? graph.scheduler?.leaseSeconds ?? 1800;
    const now = new Date();
    const runId = `run_${now.toISOString().replaceAll(/[-:.]/g, "").replace("T", "_").replace("Z", "")}_${target.id}_${randomUUID().slice(0, 8)}`;
    const node = getNode(graph, target.id);
    node.status = "claimed";
    node.lease = {
      session: session || "codex",
      runId,
      claimedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + leaseDuration * 1000).toISOString()
    };
    appendHistory(node, "claimed", { session: node.lease.session, runId });
    graph.graphVersion = (graph.graphVersion || 0) + 1;

    await writeGraphAtomic(graph, graphPath);
    return { nodeId: target.id, title: node.title, runId, lease: node.lease, releasedExpired: released, summary: summarizeGraph(graph) };
  });
}

export async function startNode(graphPath, { nodeId, session, runId } = {}) {
  return updateNodeStatus(graphPath, {
    nodeId,
    status: "running",
    owner: { session, runId },
    validate: (graph, node) => {
      assertLeafNode(graph, nodeId);
      assertStatus(node, ["claimed"], "start");
    },
    patch: (node) => {
      node.startedAt = new Date().toISOString();
      if (session && node.lease) {
        node.lease.session = session;
      }
    }
  });
}

export async function completeNode(graphPath, { nodeId, report, session, runId } = {}) {
  return updateNodeStatus(graphPath, {
    nodeId,
    status: "done",
    owner: { session, runId },
    validate: (graph, node) => {
      assertLeafNode(graph, nodeId);
      assertStatus(node, ["claimed", "running", "blocked", "review"], "complete");
    },
    patch: (node) => {
      node.completedAt = new Date().toISOString();
      if (report) {
        node.report = report;
      }
      delete node.lease;
      delete node.blockedReason;
      delete node.question;
    }
  });
}

export async function writeReportFile(graphPath, reportPath, reportBody) {
  if (!reportPath || reportBody === undefined) {
    return undefined;
  }

  const resolvedPath = resolveGraphRelativePath(graphPath, reportPath);
  await mkdir(dirname(resolvedPath), { recursive: true });
  await writeFile(resolvedPath, `${String(reportBody).replace(/\s*$/, "")}\n`, "utf8");
  return resolvedPath;
}

export async function buildWorkerPrompt(graphPath, { nodeId, session, runId, templatePath = defaultPromptTemplatePath, cwd = dirname(graphPath), reportPath } = {}) {
  if (!nodeId) {
    throw new Error("Missing node id");
  }

  const graph = await readGraph(graphPath);
  const node = getNode(graph, nodeId);
  const template = await readFile(resolveTemplatePath(graphPath, templatePath), "utf8");
  const ready = listReadyLeafNodes(graph);
  const context = {
    cwd,
    graphPath,
    nodeId,
    runId: runId || node.lease?.runId || "",
    session: session || node.lease?.session || "codex",
    reportPath: reportPath || defaultReportPath(nodeId, runId || node.lease?.runId || "manual"),
    schedulerCommand: `node ${resolve(rootDir, "scripts/plan-scheduler.mjs")}`,
    nodeTitle: node.title || nodeId,
    nodeKind: node.kind || "task",
    nodeStatus: node.status || "pending",
    nodeJson: JSON.stringify(node, null, 2),
    readyJson: JSON.stringify(ready, null, 2),
    summaryJson: JSON.stringify(summarizeGraph(graph), null, 2)
  };

  return renderPromptTemplate(template, context);
}

export async function blockNode(graphPath, { nodeId, question, reason, session, runId } = {}) {
  return updateNodeStatus(graphPath, {
    nodeId,
    status: "blocked",
    owner: { session, runId },
    validate: (graph, node) => {
      assertLeafNode(graph, nodeId);
      assertStatus(node, ["claimed", "running"], "block");
    },
    patch: (node) => {
      node.blockedAt = new Date().toISOString();
      node.blockedReason = reason || "needs_operator_decision";
      if (question) {
        node.question = question;
      }
    }
  });
}

export async function answerNode(graphPath, { nodeId, answer, responder } = {}) {
  if (!nodeId) {
    throw new Error("Missing node id");
  }
  if (!answer) {
    throw new Error("answer requires --answer");
  }

  return withGraphLock(graphPath, async () => {
    const graph = await readGraph(graphPath);
    const node = getNode(graph, nodeId);
    assertLeafNode(graph, nodeId);
    assertStatus(node, ["blocked"], "answer");

    node.status = "pending";
    node.answer = String(answer);
    node.answeredAt = new Date().toISOString();
    if (responder) {
      node.answeredBy = responder;
    } else {
      delete node.answeredBy;
    }
    delete node.lease;
    appendHistory(node, "answered", { answer: node.answer, responder: node.answeredBy });

    graph.graphVersion = (graph.graphVersion || 0) + 1;
    await writeGraphAtomic(graph, graphPath);
    return { nodeId, status: node.status, answer: node.answer, summary: summarizeGraph(graph) };
  });
}

export async function failNode(graphPath, { nodeId, reason, report, session, runId } = {}) {
  return updateNodeStatus(graphPath, {
    nodeId,
    status: "failed",
    owner: { session, runId },
    validate: (graph, node) => {
      assertLeafNode(graph, nodeId);
      assertStatus(node, ["claimed", "running", "blocked", "review"], "fail");
    },
    patch: (node) => {
      node.failedAt = new Date().toISOString();
      node.failureReason = reason || "unspecified";
      if (report) {
        node.report = report;
      }
      delete node.lease;
    }
  });
}

export async function releaseExpiredLeases(graphPath, now = new Date()) {
  return withGraphLock(graphPath, async () => {
    const graph = await readGraph(graphPath);
    const released = releaseExpiredLeasesInGraph(graph, now);

    if (released.length > 0) {
      reconcileCompletedSubtrees(graph);
      graph.graphVersion = (graph.graphVersion || 0) + 1;
      await writeGraphAtomic(graph, graphPath);
    }

    return { released, summary: summarizeGraph(graph) };
  });
}

export async function renewNodeLease(graphPath, { nodeId, session, runId, leaseSeconds } = {}) {
  if (!nodeId) {
    throw new Error("Missing node id");
  }

  return withGraphLock(graphPath, async () => {
    const graph = await readGraph(graphPath);
    const node = getNode(graph, nodeId);
    assertLeafNode(graph, nodeId);
    if (!node.lease) {
      throw new Error(`Cannot renew node without a lease: ${nodeId}`);
    }
    assertStatus(node, ["claimed", "running", "blocked", "review"], "renew");
    assertLeaseOwner(node, { session, runId });

    const leaseDuration = leaseSeconds ?? graph.scheduler?.leaseSeconds ?? 1800;
    const now = new Date();
    node.lease.renewedAt = now.toISOString();
    node.lease.expiresAt = new Date(now.getTime() + leaseDuration * 1000).toISOString();
    graph.graphVersion = (graph.graphVersion || 0) + 1;
    await writeGraphAtomic(graph, graphPath);
    return { nodeId, lease: node.lease, summary: summarizeGraph(graph) };
  });
}

export async function resetNode(graphPath, { nodeId, reason } = {}) {
  if (!nodeId) {
    throw new Error("Missing node id");
  }

  return withGraphLock(graphPath, async () => {
    const graph = await readGraph(graphPath);
    const node = getNode(graph, nodeId);
    assertLeafNode(graph, nodeId);

    const previousStatus = node.status || "pending";
    node.status = "pending";
    delete node.lease;
    delete node.startedAt;
    delete node.completedAt;
    delete node.failedAt;
    delete node.failureReason;
    delete node.blockedAt;
    delete node.blockedReason;
    delete node.question;
    delete node.report;
    delete node.expiredAt;
    appendHistory(node, "reset", { previousStatus, reason: reason || "manual_reset" });

    const resetAncestors = [];
    for (const ancestorId of findAncestorIds(graph, nodeId)) {
      const ancestor = getNode(graph, ancestorId);
      if (ancestor.status === "done") {
        ancestor.status = "pending";
        delete ancestor.completedAt;
        appendHistory(ancestor, "child_reset", { childId: nodeId });
        resetAncestors.push(ancestorId);
      }
    }

    graph.graphVersion = (graph.graphVersion || 0) + 1;
    await writeGraphAtomic(graph, graphPath);
    return { nodeId, status: node.status, resetAncestors, summary: summarizeGraph(graph) };
  });
}

export async function reconcileGraphStatus(graphPath = defaultGraphPath) {
  return withGraphLock(graphPath, async () => {
    const graph = await readGraph(graphPath);
    const changed = reconcileCompletedSubtrees(graph);
    if (changed.length > 0) {
      graph.graphVersion = (graph.graphVersion || 0) + 1;
      await writeGraphAtomic(graph, graphPath);
    }
    return { changed, summary: summarizeGraph(graph) };
  });
}

export async function decomposeNode(graphPath, { nodeId, kind, children, session, runId } = {}) {
  if (!nodeId || !Array.isArray(children) || children.length === 0) {
    throw new Error("decompose requires --node and at least one child definition");
  }

  return withGraphLock(graphPath, async () => {
    const graph = await readGraph(graphPath);
    const node = getNode(graph, nodeId);
    if (!isLeaf(graph, nodeId)) {
      throw new Error(`Cannot decompose non-leaf node: ${nodeId}`);
    }
    assertStatus(node, ["claimed", "running"], "decompose");
    assertLeaseOwner(node, { session, runId });

    const normalizedChildren = normalizeChildDefinitions(children);

    node.kind = kind || "series";
    node.status = "pending";
    node.children = normalizedChildren.map((child) => child.id);
    delete node.lease;
    delete node.startedAt;
    delete node.blockedAt;
    delete node.blockedReason;
    delete node.question;
    appendHistory(node, "decomposed", { childIds: node.children, session, runId });

    for (const child of normalizedChildren) {
      if (!child.id || !child.title) {
        throw new Error("Each child requires id and title");
      }
      if (graph.graph.nodes[child.id]) {
        throw new Error(`Child node already exists: ${child.id}`);
      }
      graph.graph.nodes[child.id] = {
        title: child.title,
        kind: child.kind || "task",
        status: child.status || "pending",
        children: child.children
      };
      if (!graph.graph.nodes[child.id].children) {
        delete graph.graph.nodes[child.id].children;
      }
    }

    reconcileCompletedSubtrees(graph);
    graph.graphVersion = (graph.graphVersion || 0) + 1;
    await writeGraphAtomic(graph, graphPath);
    return { nodeId, children: node.children, summary: summarizeGraph(graph) };
  });
}

export function renderVisualizerHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Plan Graph Scheduler</title>
  <style>
    :root {
      --bg: #f6f8fb;
      --paper: #fff;
      --ink: #16202a;
      --muted: #657282;
      --line: #d7dee8;
      --accent: #0f6f68;
      --done: #137a46;
      --running: #075db3;
      --blocked: #a15c00;
      --failed: #a32121;
      --pending: #6b7280;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.5;
    }
    main {
      width: min(1280px, calc(100% - 32px));
      margin: 24px auto 40px;
    }
    header {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: flex-start;
      margin-bottom: 18px;
    }
    h1 { margin: 0 0 6px; font-size: 28px; letter-spacing: 0; }
    p { margin: 0; color: var(--muted); }
    .summary {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .pill {
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 4px 10px;
      background: var(--paper);
      color: var(--muted);
      font-size: 13px;
      font-weight: 700;
    }
    .layout {
      display: grid;
      grid-template-columns: 1fr 340px;
      gap: 18px;
      align-items: start;
    }
    .panel {
      background: var(--paper);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 16px;
      box-shadow: 0 10px 28px rgba(20, 30, 42, 0.07);
    }
    .graph-viewport {
      overflow: auto;
      padding: 10px;
      border-radius: 8px;
      background: #fbfcfd;
    }
    .sp-graph {
      display: block;
      min-width: 980px;
      width: 100%;
      height: auto;
      color: var(--ink);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .sp-frame rect {
      fill: rgba(238, 241, 244, 0.42);
      stroke: #c7d1dc;
      stroke-dasharray: 5 5;
      stroke-width: 1.2;
    }
    .sp-frame text {
      fill: var(--muted);
      font-size: 12px;
      font-weight: 800;
      text-transform: uppercase;
    }
    .sp-frame-id {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    .sp-edge {
      fill: none;
      stroke: #8794a3;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .sp-edge-parallel {
      stroke: #9aa7b3;
    }
    .sp-terminal circle {
      fill: var(--accent);
      stroke: #fff;
      stroke-width: 2;
    }
    .sp-terminal text {
      fill: var(--muted);
      font-size: 11px;
      font-weight: 800;
      text-anchor: middle;
      text-transform: uppercase;
    }
    .sp-node rect {
      fill: #fff;
      stroke: #b9c4d0;
      stroke-width: 1.4;
      filter: url(#sp-node-shadow);
    }
    .sp-node-id {
      fill: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      font-weight: 750;
    }
    .sp-node-title {
      fill: var(--ink);
      font-size: 13px;
      font-weight: 750;
    }
    .sp-node.status-done rect { stroke: var(--done); fill: #f0faf4; }
    .sp-node.status-claimed rect,
    .sp-node.status-running rect { stroke: var(--running); fill: #eef6ff; }
    .sp-node.status-blocked rect,
    .sp-node.status-review rect { stroke: var(--blocked); fill: #fff7eb; }
    .sp-node.status-failed rect { stroke: var(--failed); fill: #fff1f1; }
    .badge {
      flex: 0 0 auto;
      border-radius: 999px;
      padding: 2px 8px;
      color: #fff;
      font-size: 12px;
      font-weight: 800;
      text-transform: uppercase;
    }
    .status-pending, .status-ready { background: var(--pending); }
    .status-claimed, .status-running { background: var(--running); }
    .status-blocked, .status-review { background: var(--blocked); }
    .status-done { background: var(--done); }
    .status-failed { background: var(--failed); }
    .meta {
      margin-top: 6px;
      color: var(--muted);
      font-size: 12px;
    }
    .sidebar-section + .sidebar-section {
      border-top: 1px solid var(--line);
      margin-top: 16px;
      padding-top: 16px;
    }
    .ready-list,
    .working-list {
      display: grid;
      gap: 8px;
      margin-top: 12px;
    }
    .ready-item,
    .working-item {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 9px;
      background: #fbfcfd;
    }
    .working-item .badge {
      display: inline-block;
      margin-bottom: 5px;
    }
    .answer-form {
      display: grid;
      gap: 8px;
      margin-top: 10px;
    }
    .answer-form textarea {
      width: 100%;
      min-height: 76px;
      resize: vertical;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 8px;
      color: var(--ink);
      font: inherit;
      font-size: 13px;
      line-height: 1.35;
      background: #fff;
    }
    .answer-form button {
      justify-self: end;
      border: 0;
      border-radius: 8px;
      padding: 7px 12px;
      background: var(--accent);
      color: #fff;
      font: inherit;
      font-size: 13px;
      font-weight: 800;
      cursor: pointer;
    }
    .answer-form button:disabled {
      cursor: wait;
      opacity: 0.65;
    }
    @media (max-width: 900px) {
      header, .layout { display: block; }
      .summary { justify-content: flex-start; margin-top: 12px; }
      .panel { margin-bottom: 16px; }
    }
  </style>
</head>
<body>
<main>
  <header>
    <div>
      <h1>Plan Graph Scheduler</h1>
      <p id="subtitle">Loading plan graph...</p>
    </div>
    <div id="summary" class="summary"></div>
  </header>
  <div class="layout">
    <section class="panel">
      <div id="graph" class="graph-viewport"></div>
    </section>
    <aside class="panel">
      <section class="sidebar-section">
        <h2 style="margin: 0 0 8px; font-size: 18px;">Active Sessions</h2>
        <p>Claimed, running, blocked, review, and failed nodes.</p>
        <div id="working" class="working-list"></div>
      </section>
      <section class="sidebar-section">
        <h2 style="margin: 0 0 8px; font-size: 18px;">Ready Leaf Nodes</h2>
        <p>These are claimable by Codex sessions.</p>
        <div id="ready" class="ready-list"></div>
      </section>
    </aside>
  </div>
</main>
<script>
  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function renderReady(ready) {
    if (!ready.length) {
      return '<p>No ready nodes.</p>';
    }
    return ready.map((node) => {
      const question = node.question ? '<div class="meta">question: ' + escapeHtml(node.question) + '</div>' : "";
      const answer = node.answer ? '<div class="meta">answer: ' + escapeHtml(node.answer) + '</div>' : "";
      return '<div class="ready-item"><strong>' + escapeHtml(node.id) + '</strong><br>' + escapeHtml(node.title) + question + answer + '</div>';
    }).join("");
  }

  function renderWorking(working) {
    if (!working.length) {
      return '<p>No active sessions.</p>';
    }
    return working.map((node) => {
      const lease = node.session ? '<div class="meta">session: ' + escapeHtml(node.session) + '</div>' : "";
      const run = node.runId ? '<div class="meta">run: ' + escapeHtml(node.runId) + '</div>' : "";
      const expiry = node.expiresAt ? '<div class="meta">expires: ' + escapeHtml(node.expiresAt) + '</div>' : "";
      const question = node.question ? '<div class="meta">question: ' + escapeHtml(node.question) + '</div>' : "";
      const answer = node.answer ? '<div class="meta">answer: ' + escapeHtml(node.answer) + '</div>' : "";
      const report = node.report ? '<div class="meta">report: ' + escapeHtml(node.report) + '</div>' : "";
      const answerForm = node.status === "blocked" ? '<form class="answer-form" data-answer-form data-node-id="' + escapeHtml(node.id) + '">' +
        '<textarea name="answer" placeholder="Answer" required></textarea>' +
        '<button type="submit">Answer</button>' +
        '</form>' : "";
      return '<div class="working-item">' +
        '<span class="badge status-' + escapeHtml(node.status) + '">' + escapeHtml(node.status) + '</span>' +
        '<div><strong>' + escapeHtml(node.id) + '</strong><br>' + escapeHtml(node.title) + '</div>' +
        lease + run + expiry + question + answer + report + answerForm +
        '</div>';
    }).join("");
  }

  function renderSummary(summary) {
    const counts = summary.counts || {};
    return Object.keys(counts).sort().map((status) => '<span class="pill">' + escapeHtml(status) + ': ' + counts[status] + '</span>').join("");
  }

  function render(payload) {
    document.getElementById("subtitle").textContent = "graph v" + payload.summary.graphVersion + " / " + payload.summary.totalNodes + " nodes";
    document.getElementById("summary").innerHTML = renderSummary(payload.summary);
    document.getElementById("graph").innerHTML = payload.graphSvg;
    document.getElementById("working").innerHTML = renderWorking(payload.working);
    document.getElementById("ready").innerHTML = renderReady(payload.ready);
  }

  async function load() {
    const response = await fetch("/api/graph");
    render(await response.json());
  }

  document.addEventListener("submit", async (event) => {
    const form = event.target.closest("[data-answer-form]");
    if (!form) {
      return;
    }
    event.preventDefault();
    const button = form.querySelector("button");
    const textarea = form.querySelector("textarea[name=answer]");
    const answer = textarea.value.trim();
    if (!answer) {
      textarea.focus();
      return;
    }
    button.disabled = true;
    try {
      const response = await fetch("/api/answer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nodeId: form.dataset.nodeId, answer, responder: "visualizer" })
      });
      if (!response.ok) {
        throw new Error(await response.text());
      }
      await load();
    } catch (error) {
      document.getElementById("subtitle").textContent = "Answer failed: " + (error.message || String(error));
      button.disabled = false;
    }
  });

  load();
  const events = new EventSource("/events");
  events.onmessage = (event) => render(JSON.parse(event.data));
  events.onerror = () => {
    document.getElementById("subtitle").textContent = "Connection lost. Retrying...";
  };
</script>
</body>
</html>`;
}

export async function createVisualizerServer({ graphPath = defaultGraphPath, port = 8787, host = "127.0.0.1" } = {}) {
  const clients = new Set();

  async function send(client) {
    const data = JSON.stringify(await buildVisualizerPayload(graphPath));
    client.write(`data: ${data}\n\n`);
  }

  async function broadcast() {
    for (const client of clients) {
      try {
        await send(client);
      } catch {
        clients.delete(client);
      }
    }
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${host}:${port}`);

      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(renderVisualizerHtml());
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/graph") {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify(await buildVisualizerPayload(graphPath)));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/answer") {
        const body = await readRequestJson(req);
        const result = await answerNode(graphPath, {
          nodeId: body.nodeId,
          answer: body.answer,
          responder: body.responder
        });
        await renderPlanAfterUpdate(graphPath);
        result.slack = await sendSlackNotification(graphPath, "answered", {
          nodeId: body.nodeId,
          answer: body.answer
        });
        await broadcast();
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify(result));
        return;
      }

      if (req.method === "GET" && url.pathname === "/events") {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          connection: "keep-alive"
        });
        clients.add(res);
        await send(res);
        req.on("close", () => clients.delete(res));
        return;
      }

      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
    } catch (error) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(error.stack || String(error));
    }
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, host, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });

  const watcher = watch(graphPath, async () => {
    await broadcast();
  });

  return {
    server,
    url: `http://${host}:${server.address().port}`,
    close: async () => {
      watcher.close();
      for (const client of clients) {
        client.end();
      }
      server.closeAllConnections?.();
      await new Promise((resolveClose) => server.close(resolveClose));
    }
  };
}

export async function buildVisualizerPayload(graphPath = defaultGraphPath) {
  const graph = await readGraph(graphPath);
  return {
    graph,
    graphSvg: renderPlanarSvg(graph),
    ready: listReadyLeafNodes(graph),
    working: listWorkingNodes(graph),
    summary: summarizeGraph(graph)
  };
}

export async function runWorker(graphPath, options = {}) {
  const session = options.session || "codex-worker";
  const once = Boolean(options.once);
  const idleMs = Number(options.idleMs ?? 5000);
  const stream = options.stream !== false;
  const results = [];

  while (true) {
    let claim;
    try {
      claim = await claimNode(graphPath, {
        session,
        nodeId: options.nodeId,
        leaseSeconds: options.leaseSeconds
      });
    } catch (error) {
      if (!String(error?.message || error).includes("No ready nodes") && !String(error?.message || error).includes("Node is not ready")) {
        throw error;
      }
      if (once) {
        return { session, idle: true, results };
      }
      await waitForReadyJob({ session, graphPath, idleMs, stream });
      continue;
    }

    await renderPlanAfterUpdate(graphPath);
    await startNode(graphPath, { nodeId: claim.nodeId, session, runId: claim.runId });
    await renderPlanAfterUpdate(graphPath);

    const reportPath = options.reportPath || defaultReportPath(claim.nodeId, claim.runId);
    const prompt = await buildWorkerPrompt(graphPath, {
      nodeId: claim.nodeId,
      session,
      runId: claim.runId,
      templatePath: options.templatePath,
      cwd: options.cwd,
      reportPath
    });
    const heartbeat = startLeaseHeartbeat(graphPath, { claim, session, leaseSeconds: options.leaseSeconds });
    let run;
    try {
      run = await runCodexPrompt(prompt, {
        ...options,
        graphPath,
        logPrefix: `${session}:${claim.nodeId}`
      });
    } finally {
      heartbeat.stop();
    }
    const outcome = await finalizeWorkerRun(graphPath, { claim, session, run, reportPath });
    results.push(outcome);

    await renderPlanAfterUpdate(graphPath);
    if (once) {
      return { session, idle: false, results };
    }
  }
}

async function updateNodeStatus(graphPath, { nodeId, status, owner, validate, patch }) {
  if (!nodeId) {
    throw new Error("Missing node id");
  }

  return withGraphLock(graphPath, async () => {
    const graph = await readGraph(graphPath);
    const node = getNode(graph, nodeId);
    validate?.(graph, node);
    assertLeaseOwner(node, owner);
    node.status = status;
    patch?.(node, graph);
    appendHistory(node, status);
    reconcileCompletedSubtrees(graph);
    graph.graphVersion = (graph.graphVersion || 0) + 1;
    await writeGraphAtomic(graph, graphPath);
    return { nodeId, status, title: node.title, summary: summarizeGraph(graph) };
  });
}

function reconcileCompletedSubtrees(graph) {
  const changed = [];
  const rootId = graph.graph?.root;
  if (!rootId) {
    return changed;
  }

  function visit(nodeId, stack = []) {
    if (stack.includes(nodeId)) {
      throw new Error(`Cycle detected in graph: ${[...stack, nodeId].join(" -> ")}`);
    }

    const node = getNode(graph, nodeId);
    if (isLeaf(graph, nodeId)) {
      return terminalStatuses.has(node.status);
    }

    const childrenDone = node.children.every((childId) => visit(childId, [...stack, nodeId]));
    if (childrenDone && node.status !== "done") {
      node.status = "done";
      node.completedAt ||= new Date().toISOString();
      appendHistory(node, "subtree_done");
      changed.push(nodeId);
    }
    return childrenDone && terminalStatuses.has(node.status);
  }

  visit(rootId);
  return changed;
}

function releaseExpiredLeasesInGraph(graph, now = new Date()) {
  const released = [];
  const nowMs = now.getTime();

  for (const [nodeId, node] of Object.entries(graph.graph?.nodes || {})) {
    if (!node.lease?.expiresAt || !autoReleasableStatuses.has(node.status || "pending")) {
      continue;
    }

    const expiresAtMs = new Date(node.lease.expiresAt).getTime();
    if (!Number.isFinite(expiresAtMs) || expiresAtMs > nowMs) {
      continue;
    }

    released.push(nodeId);
    appendHistory(node, "lease_expired", { previousStatus: node.status, runId: node.lease.runId });
    node.status = "pending";
    node.expiredAt = now.toISOString();
    delete node.lease;
    delete node.startedAt;
  }

  return released;
}

function findAncestorIds(graph, nodeId) {
  const ancestors = [];
  const rootId = graph.graph?.root;
  if (!rootId || rootId === nodeId) {
    return ancestors;
  }

  function visit(currentId, path = []) {
    const current = getNode(graph, currentId);
    if (!Array.isArray(current.children)) {
      return false;
    }
    if (current.children.includes(nodeId)) {
      ancestors.push(...path, currentId);
      return true;
    }
    return current.children.some((childId) => visit(childId, [...path, currentId]));
  }

  visit(rootId);
  return ancestors.reverse();
}

function assertLeafNode(graph, nodeId) {
  if (!isLeaf(graph, nodeId)) {
    throw new Error(`Only leaf nodes can be mutated directly: ${nodeId}`);
  }
}

function assertStatus(node, allowedStatuses, action) {
  const current = node.status || "pending";
  if (!allowedStatuses.includes(current)) {
    throw new Error(`Cannot ${action} node from status ${current}; expected one of ${allowedStatuses.join(", ")}`);
  }
}

function assertLeaseOwner(node, owner = {}) {
  if (!node.lease) {
    return;
  }

  const { session, runId } = owner;
  if (!session && !runId) {
    throw new Error("A session or runId is required to update a leased node");
  }
  if (runId && node.lease.runId !== runId) {
    throw new Error(`Lease runId mismatch for node; expected ${node.lease.runId}`);
  }
  if (session && node.lease.session !== session) {
    throw new Error(`Lease session mismatch for node; expected ${node.lease.session}`);
  }
}

function normalizeChildDefinitions(children) {
  const normalized = [];
  const seen = new Set();

  for (const child of children) {
    if (!child || typeof child !== "object") {
      throw new Error("Each child must be an object");
    }
    if (!child.id || !child.title) {
      throw new Error("Each child requires id and title");
    }
    if (seen.has(child.id)) {
      throw new Error(`Duplicate child id in decomposition: ${child.id}`);
    }
    seen.add(child.id);
    normalized.push({
      id: child.id,
      title: child.title,
      kind: child.kind || "task",
      status: child.status || "pending",
      children: child.children
    });
  }

  return normalized;
}

function appendHistory(node, event, details = {}) {
  node.history ||= [];
  node.history.push({
    at: new Date().toISOString(),
    event,
    ...details
  });
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function waitForReadyJob({ session, graphPath, idleMs, stream }) {
  if (!stream) {
    await sleep(idleMs);
    return;
  }

  const label = `[${session}] waiting for ready job in ${graphPath}`;
  if (!process.stdout.isTTY) {
    process.stdout.write(`${label}; next check in ${Math.round(idleMs / 1000)}s\n`);
    await sleep(idleMs);
    return;
  }

  const frames = ["-", "\\", "|", "/"];
  let index = 0;
  process.stdout.write("\x1B[?25l");
  const timer = setInterval(() => {
    process.stdout.write(`\r${frames[index % frames.length]} ${label}`);
    index += 1;
  }, 180);

  try {
    await sleep(idleMs);
  } finally {
    clearInterval(timer);
    process.stdout.write(`\r\x1B[2K\x1B[?25h`);
  }
}

async function readRequestJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) {
      throw new Error("Request body is too large");
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function startLeaseHeartbeat(graphPath, { claim, session, leaseSeconds }) {
  const claimedAtMs = new Date(claim.lease?.claimedAt || Date.now()).getTime();
  const expiresAtMs = new Date(claim.lease?.expiresAt || Date.now() + 1800 * 1000).getTime();
  const leaseMs = Number.isFinite(expiresAtMs - claimedAtMs) && expiresAtMs > claimedAtMs
    ? expiresAtMs - claimedAtMs
    : Number(leaseSeconds || 1800) * 1000;
  const intervalMs = Math.max(250, Math.min(60_000, Math.floor(leaseMs / 3)));
  let stopped = false;
  let inFlight = false;

  const renew = async () => {
    if (stopped || inFlight) {
      return;
    }
    inFlight = true;
    try {
      await renewNodeLease(graphPath, {
        nodeId: claim.nodeId,
        session,
        runId: claim.runId,
        leaseSeconds
      });
    } catch {
      stopped = true;
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(renew, intervalMs);
  timer.unref?.();

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    }
  };
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      args._.push(arg);
      continue;
    }
    const equalsIndex = arg.indexOf("=");
    if (equalsIndex > 2) {
      appendArg(args, arg.slice(2, equalsIndex), arg.slice(equalsIndex + 1));
      continue;
    }

    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      appendArg(args, key, true);
    } else {
      appendArg(args, key, next);
      index += 1;
    }
  }
  return args;
}

function appendArg(args, key, value) {
  if (Object.hasOwn(args, key)) {
    args[key] = Array.isArray(args[key]) ? [...args[key], value] : [args[key], value];
  } else {
    args[key] = value;
  }
}

function parseChildrenArgs(args) {
  if (args["child-json"]) {
    const raw = Array.isArray(args["child-json"]) ? args["child-json"][args["child-json"].length - 1] : args["child-json"];
    const children = JSON.parse(raw);
    if (!Array.isArray(children)) {
      throw new Error("--child-json must be a JSON array");
    }
    return children;
  }

  const rawChildren = args.child === undefined ? [] : Array.isArray(args.child) ? args.child : [args.child];
  return rawChildren.map((value) => {
    const text = String(value);
    const separator = text.includes("=") ? "=" : ":";
    const index = text.indexOf(separator);
    if (index <= 0) {
      throw new Error(`Invalid --child value: ${text}. Use ID=Title or ID:Title`);
    }
    return {
      id: text.slice(0, index).trim(),
      title: text.slice(index + 1).trim()
    };
  });
}

export function parseCodexArgs(args, codexCommand) {
  if (args["codex-arg"] === undefined) {
    return ["exec"];
  }
  const codexArgs = Array.isArray(args["codex-arg"]) ? args["codex-arg"].map(String) : [String(args["codex-arg"])];
  if (!codexCommand && codexArgs[0]?.startsWith("-")) {
    return ["exec", ...codexArgs];
  }
  return codexArgs;
}

function shouldStreamWorkerOutput(args) {
  return !args.quiet;
}

function resolveGraphRelativePath(graphPath, targetPath) {
  const baseDir = dirname(graphPath);
  const resolvedPath = isAbsolute(targetPath) ? resolve(targetPath) : resolve(baseDir, targetPath);
  const pathFromBase = relative(baseDir, resolvedPath);
  if (pathFromBase.startsWith("..") || isAbsolute(pathFromBase)) {
    throw new Error(`Path escapes graph directory: ${targetPath}`);
  }
  return resolvedPath;
}

function resolveTemplatePath(graphPath, templatePath) {
  if (!templatePath) {
    return defaultPromptTemplatePath;
  }
  return isAbsolute(templatePath) ? resolve(templatePath) : resolve(dirname(graphPath), templatePath);
}

function renderPromptTemplate(template, context) {
  return template.replaceAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key) => {
    if (Object.hasOwn(context, key)) {
      return String(context[key]);
    }
    return match;
  });
}

function defaultReportPath(nodeId, runId) {
  return `reports/${safeFilePart(nodeId)}-${safeFilePart(runId)}.md`;
}

function safeFilePart(value) {
  return String(value || "run").replaceAll(/[^a-zA-Z0-9._-]/g, "_");
}

async function runCodexPrompt(prompt, options = {}) {
  const cwd = options.cwd || dirname(options.graphPath || defaultGraphPath);
  const command = options.codexCommand || "codex";
  const commandArgs = options.codexArgs || ["exec"];
  const stream = options.stream !== false;
  const prefix = options.logPrefix ? `[${options.logPrefix}] ` : "";
  const startedAt = new Date().toISOString();

  const result = await new Promise((resolveRun) => {
    const child = spawn(command, [...commandArgs, prompt], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
      if (stream) {
        process.stdout.write(prefixChunk(chunk, prefix));
      }
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
      if (stream) {
        process.stderr.write(prefixChunk(chunk, prefix));
      }
    });
    child.on("error", (error) => {
      resolveRun({ code: 1, error: error.message, stdout, stderr });
    });
    child.on("exit", (code, signal) => {
      resolveRun({ code: code ?? 1, signal, stdout, stderr });
    });
  });

  return {
    ...result,
    command,
    args: commandArgs,
    startedAt,
    finishedAt: new Date().toISOString()
  };
}

function prefixChunk(chunk, prefix) {
  if (!prefix) {
    return chunk;
  }
  return String(chunk)
    .split(/(\r?\n)/)
    .map((part, index, parts) => {
      if (part === "\n" || part === "\r\n" || part === "") {
        return part;
      }
      const previous = parts[index - 1];
      return index === 0 || previous === "\n" || previous === "\r\n" ? `${prefix}${part}` : part;
    })
    .join("");
}

async function finalizeWorkerRun(graphPath, { claim, session, run, reportPath }) {
  const graph = await readGraph(graphPath);
  const node = getNode(graph, claim.nodeId);
  const stillOwned = node.lease?.runId === claim.runId && node.lease?.session === session;
  const reportBody = formatWorkerReport({ claim, run });

  if (!stillOwned || !["claimed", "running"].includes(node.status || "pending")) {
    return {
      nodeId: claim.nodeId,
      runId: claim.runId,
      status: node.status || "pending",
      code: run.code,
      note: "node state was changed by the Codex run"
    };
  }

  if (run.code === 0) {
    await writeReportFile(graphPath, reportPath, reportBody);
    const result = await completeNode(graphPath, {
      nodeId: claim.nodeId,
      session,
      runId: claim.runId,
      report: reportPath
    });
    result.slack = await sendSlackNotification(graphPath, "done", { nodeId: claim.nodeId, report: reportPath });
    return { ...result, runId: claim.runId, code: run.code };
  }

  await writeReportFile(graphPath, reportPath, reportBody);
  const result = await failNode(graphPath, {
    nodeId: claim.nodeId,
    session,
    runId: claim.runId,
    reason: `codex exited with ${run.code}`,
    report: reportPath
  });
  result.slack = await sendSlackNotification(graphPath, "failed", {
    nodeId: claim.nodeId,
    reason: `codex exited with ${run.code}`,
    report: reportPath
  });
  return { ...result, runId: claim.runId, code: run.code };
}

function formatWorkerReport({ claim, run }) {
  const sections = [
    `# ${claim.nodeId}: ${claim.title}`,
    "",
    `- Run: ${claim.runId}`,
    `- Exit code: ${run.code}`,
    `- Started: ${run.startedAt}`,
    `- Finished: ${run.finishedAt}`
  ];

  if (run.stdout?.trim()) {
    sections.push("", "## Stdout", "", "```text", run.stdout.trim(), "```");
  }
  if (run.stderr?.trim()) {
    sections.push("", "## Stderr", "", "```text", run.stderr.trim(), "```");
  }
  if (run.error) {
    sections.push("", "## Error", "", run.error);
  }

  return sections.join("\n");
}

async function sendSlackNotification(graphPath, event, details = {}) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    return { skipped: true, reason: "SLACK_WEBHOOK_URL is not set" };
  }

  const graph = await readGraph(graphPath);
  const node = details.nodeId ? graph.graph.nodes[details.nodeId] : undefined;
  const summary = summarizeGraph(graph);
  const lines = [
    `*${event.toUpperCase()}* ${details.nodeId || ""} ${node?.title ? `- ${node.title}` : ""}`.trim(),
    `graph v${summary.graphVersion}; ${Object.entries(summary.counts).map(([status, count]) => `${status}=${count}`).join(", ")}`
  ];

  if (details.question) {
    lines.push(`question: ${details.question}`);
  }
  if (details.answer) {
    lines.push(`answer: ${details.answer}`);
  }
  if (details.reason) {
    lines.push(`reason: ${details.reason}`);
  }
  if (details.report) {
    lines.push(`report: ${details.report}`);
  }

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: lines.join("\n") })
  });

  if (!response.ok) {
    throw new Error(`Slack notification failed: HTTP ${response.status} ${await response.text()}`);
  }

  return { sent: true };
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

async function renderPlanAfterUpdate(graphPath) {
  await withGraphLock(graphPath, async () => {
    const graph = await readGraph(graphPath);
    if (!graph.document) {
      return;
    }
    await new Promise((resolveRender, rejectRender) => {
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  const graphPath = resolve(rootDir, args.graph || process.env.PLAN_GRAPH || "plan.graph.json");

  if (!command || command === "help") {
    console.log(`Usage:
  node scripts/plan-scheduler.mjs ready [--graph plan.graph.json]
  node scripts/plan-scheduler.mjs summary [--graph plan.graph.json]
  node scripts/plan-scheduler.mjs claim [--session codex-A] [--node A1]
  node scripts/plan-scheduler.mjs start --node A1 [--session codex-A] [--run run_id]
  node scripts/plan-scheduler.mjs renew --node A1 [--session codex-A] [--run run_id] [--lease 1800]
  node scripts/plan-scheduler.mjs reset --node A1 [--reason "retry"]
  node scripts/plan-scheduler.mjs done --node A1 [--session codex-A] [--run run_id] [--report reports/A1.md] [--report-body "..."]
  node scripts/plan-scheduler.mjs block --node A1 [--session codex-A] [--run run_id] --question "Need operator decision"
  node scripts/plan-scheduler.mjs answer --node A1 --answer "Operator decision" [--responder jason]
  node scripts/plan-scheduler.mjs fail --node A1 [--session codex-A] [--run run_id] --reason "..."
  node scripts/plan-scheduler.mjs decompose --node A1 [--session codex-A] [--run run_id] --kind series --child A1a="First step" --child A1b="Second step"
  node scripts/plan-scheduler.mjs prompt --node A1 [--session codex-A] [--run run_id] [--template prompts/codex-worker-task.md]
  node scripts/plan-scheduler.mjs worker --session codex-A [--graph plan.graph.json] [--once] [--quiet] [--cwd /path/to/workspace] [--template prompts/codex-worker-task.md]
  node scripts/plan-scheduler.mjs reconcile [--graph plan.graph.json]
  node scripts/plan-scheduler.mjs release-expired
  node scripts/plan-scheduler.mjs serve [--port 8787] [--host 127.0.0.1]`);
    return;
  }

  if (command === "ready") {
    printJson(listReadyLeafNodes(await readGraph(graphPath)));
    return;
  }

  if (command === "summary") {
    printJson(summarizeGraph(await readGraph(graphPath)));
    return;
  }

  if (command === "claim") {
    const result = await claimNode(graphPath, {
      session: args.session,
      nodeId: args.node,
      leaseSeconds: args.lease ? Number(args.lease) : undefined
    });
    await renderPlanAfterUpdate(graphPath);
    printJson(result);
    return;
  }

  if (command === "start") {
    const result = await startNode(graphPath, { nodeId: args.node, session: args.session, runId: args.run });
    await renderPlanAfterUpdate(graphPath);
    printJson(result);
    return;
  }

  if (command === "renew") {
    const result = await renewNodeLease(graphPath, {
      nodeId: args.node,
      session: args.session,
      runId: args.run,
      leaseSeconds: args.lease ? Number(args.lease) : undefined
    });
    await renderPlanAfterUpdate(graphPath);
    printJson(result);
    return;
  }

  if (command === "reset") {
    const result = await resetNode(graphPath, { nodeId: args.node, reason: args.reason });
    await renderPlanAfterUpdate(graphPath);
    printJson(result);
    return;
  }

  if (command === "done") {
    await writeReportFile(graphPath, args.report, args["report-body"]);
    const result = await completeNode(graphPath, { nodeId: args.node, report: args.report, session: args.session, runId: args.run });
    await renderPlanAfterUpdate(graphPath);
    result.slack = await sendSlackNotification(graphPath, "done", { nodeId: args.node, report: args.report });
    printJson(result);
    return;
  }

  if (command === "block") {
    const result = await blockNode(graphPath, {
      nodeId: args.node,
      question: args.question,
      reason: args.reason,
      session: args.session,
      runId: args.run
    });
    await renderPlanAfterUpdate(graphPath);
    result.slack = await sendSlackNotification(graphPath, "blocked", {
      nodeId: args.node,
      question: args.question,
      reason: args.reason
    });
    printJson(result);
    return;
  }

  if (command === "answer") {
    const result = await answerNode(graphPath, {
      nodeId: args.node,
      answer: args.answer,
      responder: args.responder
    });
    await renderPlanAfterUpdate(graphPath);
    result.slack = await sendSlackNotification(graphPath, "answered", {
      nodeId: args.node,
      answer: args.answer
    });
    printJson(result);
    return;
  }

  if (command === "fail") {
    const result = await failNode(graphPath, {
      nodeId: args.node,
      reason: args.reason,
      report: args.report,
      session: args.session,
      runId: args.run
    });
    await renderPlanAfterUpdate(graphPath);
    result.slack = await sendSlackNotification(graphPath, "failed", {
      nodeId: args.node,
      reason: args.reason,
      report: args.report
    });
    printJson(result);
    return;
  }

  if (command === "decompose") {
    const result = await decomposeNode(graphPath, {
      nodeId: args.node,
      kind: args.kind,
      children: parseChildrenArgs(args),
      session: args.session,
      runId: args.run
    });
    await renderPlanAfterUpdate(graphPath);
    result.slack = await sendSlackNotification(graphPath, "decomposed", { nodeId: args.node });
    printJson(result);
    return;
  }

  if (command === "prompt") {
    const prompt = await buildWorkerPrompt(graphPath, {
      nodeId: args.node,
      session: args.session,
      runId: args.run,
      templatePath: args.template,
      cwd: args.cwd || dirname(graphPath),
      reportPath: args.report
    });
    console.log(prompt);
    return;
  }

  if (command === "worker") {
    const cwd = args.cwd ? resolve(args.cwd) : dirname(graphPath);
    const result = await runWorker(graphPath, {
      session: args.session,
      nodeId: args.node,
      once: Boolean(args.once),
      idleMs: args["idle-ms"] ? Number(args["idle-ms"]) : undefined,
      leaseSeconds: args.lease ? Number(args.lease) : undefined,
      templatePath: args.template,
      cwd,
      stream: shouldStreamWorkerOutput(args),
      codexCommand: args["codex-command"],
      codexArgs: parseCodexArgs(args, args["codex-command"])
    });
    printJson(result);
    return;
  }

  if (command === "reconcile") {
    const result = await reconcileGraphStatus(graphPath);
    await renderPlanAfterUpdate(graphPath);
    printJson(result);
    return;
  }

  if (command === "release-expired") {
    const result = await releaseExpiredLeases(graphPath);
    await renderPlanAfterUpdate(graphPath);
    printJson(result);
    return;
  }

  if (command === "serve") {
    const visualizer = await createVisualizerServer({
      graphPath,
      host: args.host || "127.0.0.1",
      port: args.port ? Number(args.port) : 8787
    });
    console.log(`Plan scheduler visualizer: ${visualizer.url}`);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.stack || String(error));
    process.exitCode = 1;
  });
}
