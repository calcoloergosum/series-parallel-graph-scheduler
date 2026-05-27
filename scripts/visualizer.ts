import { spawn } from "node:child_process";
import { watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";

import type {
  AnswerNodeResult,
  JsonValue,
  PublicWorker,
  SlackNotificationResult,
  StartWorkerOptions,
  VisualizerPayload,
  VisualizerServerHandle,
  WorkerLogEntry,
  WorkerManager,
  WorkerManagerStatus
} from "./contracts.js";
import { defaultGraphPath, readGraph } from "./graph-io.js";
import { listReadyLeafNodes, listWorkingNodes, summarizeGraph } from "./graph-traversal.js";
import { NumericArgumentError, numericArgumentRanges, parseNumericArgument } from "./numeric-args.js";
import { renderPlanarSvg } from "./sp-layout.js";

export interface VisualizerRuntime {
  defaultGraphPath: string;
  schedulerScriptPath: string;
  rootDir: string;
  answerNode(graphPath: string, options: {
    nodeId?: string;
    answer?: string;
    responder?: string;
  }): Promise<AnswerNodeResult>;
  renderPlanAfterUpdate(graphPath: string): Promise<void>;
  sendSlackNotification(
    graphPath: string,
    event: string,
    details?: Record<string, JsonValue | undefined>
  ): Promise<SlackNotificationResult>;
}

export interface CreateWorkerManagerOptions {
  graphPath?: string;
  defaultCwd?: string;
  onChange?: () => Promise<void> | void;
  schedulerScriptPath: string;
  rootDir: string;
}

export interface CreateVisualizerServerOptions {
  graphPath?: string;
  port?: number;
  host?: string;
  defaultWorkerCwd?: string;
  runtime: VisualizerRuntime;
}

interface ManagedWorker {
  id: string;
  session: string;
  pid?: number;
  status: "running" | "stopping" | "exited" | "error";
  cwd: string;
  startedAt: string;
  finishedAt?: string;
  stoppingAt?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | string | null;
  error?: string;
  command: string;
  args: string[];
  child?: ReturnType<typeof spawn>;
  logTail: WorkerLogEntry[];
}

interface ValidatedStartWorkerOptions {
  count: number;
  sessionPrefix?: string;
  cwd?: string;
  codexCommand?: string;
  codexArgs?: string[];
  idleMs?: number;
  leaseSeconds?: number;
  templatePath?: string;
  nodeId?: string;
  quiet: boolean;
  once: boolean;
}

const workerStartLimits = {
  sessionPrefixLength: 64,
  nodeIdLength: 256,
  pathLength: 4096,
  commandLength: 4096,
  codexArgsLength: 64,
  codexArgLength: 4096
} as const;

class WorkerStartValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerStartValidationError";
  }
}

export function isLocalVisualizerHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "localhost"
    || normalized === "127.0.0.1"
    || normalized === "::1"
    || normalized === "[::1]";
}

export function visualizerHostSecurityWarning(host: string): string | undefined {
  if (isLocalVisualizerHost(host)) {
    return undefined;
  }
  return `Warning: the visualizer worker manager API is intended for trusted local use. Binding to ${host} may expose worker start/stop controls to other machines.`;
}

export function renderVisualizerHtml(): string {
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
      grid-template-columns: minmax(0, 1fr) 340px;
      gap: 18px;
      align-items: start;
    }
    .panel {
      min-width: 0;
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
    .manager-form {
      display: grid;
      gap: 9px;
      margin-top: 12px;
    }
    .field-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }
    .field {
      display: grid;
      gap: 4px;
    }
    label {
      color: var(--muted);
      font-size: 12px;
      font-weight: 800;
      text-transform: uppercase;
    }
    input,
    textarea {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 7px 8px;
      color: var(--ink);
      font: inherit;
      font-size: 13px;
      line-height: 1.35;
      background: #fff;
    }
    textarea {
      min-height: 68px;
      resize: vertical;
    }
    .checkbox-row {
      display: flex;
      gap: 12px;
      align-items: center;
      flex-wrap: wrap;
    }
    .checkbox-row label {
      display: flex;
      gap: 6px;
      align-items: center;
      text-transform: none;
      font-size: 13px;
    }
    .checkbox-row input {
      width: auto;
    }
    .button-row {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
      flex-wrap: wrap;
    }
    button {
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
    button.secondary {
      border: 1px solid var(--line);
      background: #fff;
      color: var(--ink);
    }
    button.danger {
      background: var(--failed);
    }
    button:disabled {
      cursor: wait;
      opacity: 0.65;
    }
    .ready-list,
    .working-list,
    .worker-list {
      display: grid;
      gap: 8px;
      margin-top: 12px;
    }
    .ready-item,
    .working-item,
    .worker-item {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 9px;
      background: #fbfcfd;
    }
    .working-item .badge,
    .worker-item .badge {
      display: inline-block;
      margin-bottom: 5px;
    }
    .worker-heading {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      align-items: flex-start;
    }
    .log-tail {
      margin-top: 8px;
      max-height: 96px;
      overflow: auto;
      border-radius: 8px;
      background: #101820;
      color: #dbe7f2;
      padding: 8px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 11px;
      white-space: pre-wrap;
    }
    .answer-form {
      display: grid;
      gap: 8px;
      margin-top: 10px;
    }
    .answer-form button { justify-self: end; }
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
        <h2 style="margin: 0 0 8px; font-size: 18px;">Worker Manager</h2>
        <div id="worker-manager-summary" class="meta"></div>
        <form id="worker-manager-form" class="manager-form">
          <div class="field-row">
            <div class="field">
              <label for="worker-count">Workers</label>
              <input id="worker-count" name="count" type="number" min="1" max="100" step="1" value="4">
            </div>
            <div class="field">
              <label for="worker-prefix">Session Prefix</label>
              <input id="worker-prefix" name="sessionPrefix" value="codex">
            </div>
          </div>
          <div class="field">
            <label for="worker-cwd">Repository</label>
            <input id="worker-cwd" name="cwd" autocomplete="off">
          </div>
          <div class="field-row">
            <div class="field">
              <label for="worker-command">Command</label>
              <input id="worker-command" name="codexCommand" value="codex">
            </div>
            <div class="field">
              <label for="worker-idle-ms">Idle Ms</label>
              <input id="worker-idle-ms" name="idleMs" type="number" min="250" step="250" value="5000">
            </div>
          </div>
          <div class="field">
            <label for="worker-codex-args">Args</label>
            <textarea id="worker-codex-args" name="codexArgs">exec</textarea>
          </div>
          <div class="checkbox-row">
            <label><input type="checkbox" name="quiet"> Quiet</label>
            <label><input type="checkbox" name="once"> Once</label>
          </div>
          <div class="button-row">
            <button class="secondary" type="button" id="stop-all-workers">Stop All</button>
            <button type="submit">Start</button>
          </div>
        </form>
        <div id="workers" class="worker-list"></div>
      </section>
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
  let workerDefaultsHydrated = false;

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

  function hydrateWorkerDefaults(manager) {
    if (workerDefaultsHydrated || !manager) {
      return;
    }
    workerDefaultsHydrated = true;
    const saved = JSON.parse(localStorage.getItem("spgWorkerManager") || "{}");
    document.getElementById("worker-cwd").value = saved.cwd || manager.defaults.cwd || "";
    document.getElementById("worker-prefix").value = saved.sessionPrefix || manager.defaults.sessionPrefix || "codex";
    document.getElementById("worker-command").value = saved.codexCommand || manager.defaults.codexCommand || "codex";
    document.getElementById("worker-codex-args").value = Array.isArray(saved.codexArgs) ? saved.codexArgs.join("\\n") : "exec";
    document.getElementById("worker-count").value = saved.count || 4;
    document.getElementById("worker-idle-ms").value = saved.idleMs || 5000;
    document.querySelector("[name=quiet]").checked = Boolean(saved.quiet);
    document.querySelector("[name=once]").checked = Boolean(saved.once);
  }

  function statusClass(status) {
    if (status === "running" || status === "stopping") {
      return "running";
    }
    if (status === "exited") {
      return "done";
    }
    return "failed";
  }

  function renderWorkerManager(manager) {
    hydrateWorkerDefaults(manager);
    const workers = manager?.workers || [];
    const running = workers.filter((worker) => worker.status === "running" || worker.status === "stopping").length;
    document.getElementById("worker-manager-summary").textContent = running + " running / " + workers.length + " managed";
    if (!workers.length) {
      document.getElementById("workers").innerHTML = '<p>No managed workers.</p>';
      return;
    }
    document.getElementById("workers").innerHTML = workers.map((worker) => {
      const pid = worker.pid ? '<div class="meta">pid: ' + escapeHtml(worker.pid) + '</div>' : "";
      const cwd = worker.cwd ? '<div class="meta">repo: ' + escapeHtml(worker.cwd) + '</div>' : "";
      const exit = worker.exitCode !== undefined && worker.exitCode !== null ? '<div class="meta">exit: ' + escapeHtml(worker.exitCode) + '</div>' : "";
      const signal = worker.signal ? '<div class="meta">signal: ' + escapeHtml(worker.signal) + '</div>' : "";
      const log = worker.logTail?.length ? '<div class="log-tail">' + escapeHtml(worker.logTail.map((entry) => entry.text).join("")) + '</div>' : "";
      const stop = worker.status === "running" || worker.status === "stopping"
        ? '<button class="danger" type="button" data-stop-worker="' + escapeHtml(worker.id) + '">Stop</button>'
        : "";
      return '<div class="worker-item">' +
        '<div class="worker-heading"><div><span class="badge status-' + statusClass(worker.status) + '">' + escapeHtml(worker.status) + '</span>' +
        '<div><strong>' + escapeHtml(worker.session) + '</strong></div></div>' + stop + '</div>' +
        pid + cwd + exit + signal + log +
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
    renderWorkerManager(payload.workerManager);
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

  document.getElementById("worker-manager-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const body = {
      count: Number(form.count.value || 1),
      sessionPrefix: form.sessionPrefix.value.trim() || "codex",
      cwd: form.cwd.value.trim(),
      codexCommand: form.codexCommand.value.trim() || "codex",
      codexArgs: form.codexArgs.value.split(/\\r?\\n/).map((line) => line.trim()).filter(Boolean),
      idleMs: Number(form.idleMs.value || 5000),
      quiet: form.quiet.checked,
      once: form.once.checked
    };
    localStorage.setItem("spgWorkerManager", JSON.stringify(body));
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    try {
      const response = await fetch("/api/workers/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!response.ok) {
        throw new Error(await response.text());
      }
      await load();
    } catch (error) {
      document.getElementById("subtitle").textContent = "Worker start failed: " + (error.message || String(error));
    } finally {
      button.disabled = false;
    }
  });

  document.addEventListener("click", async (event) => {
    const stopButton = event.target.closest("[data-stop-worker]");
    if (!stopButton) {
      return;
    }
    stopButton.disabled = true;
    await fetch("/api/workers/stop", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: stopButton.dataset.stopWorker })
    });
    await load();
  });

  document.getElementById("stop-all-workers").addEventListener("click", async () => {
    await fetch("/api/workers/stop-all", { method: "POST" });
    await load();
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

export function createWorkerManager({
  graphPath = defaultGraphPath,
  defaultCwd,
  onChange,
  schedulerScriptPath,
  rootDir
}: CreateWorkerManagerOptions): WorkerManager {
  const workers = new Map<string, ManagedWorker>();
  let counter = 0;

  function nextWorkerId(): string {
    counter += 1;
    return `worker-${Date.now()}-${counter}`;
  }

  function nextSession(prefix?: string): string {
    const base = safeFilePart(prefix || "codex");
    let index = 1;
    const existing = new Set([...workers.values()].map((worker) => worker.session));
    while (existing.has(`${base}-${String(index).padStart(2, "0")}`)) {
      index += 1;
    }
    return `${base}-${String(index).padStart(2, "0")}`;
  }

  function appendLog(worker: ManagedWorker, stream: WorkerLogEntry["stream"], chunk: Buffer): void {
    worker.logTail.push({ at: new Date().toISOString(), stream, text: String(chunk) });
    if (worker.logTail.length > 80) {
      worker.logTail.splice(0, worker.logTail.length - 80);
    }
  }

  function notify(): void {
    Promise.resolve(onChange?.()).catch(() => {});
  }

  function startWorkers(options: StartWorkerOptions = {}): PublicWorker[] {
    const validated = validateStartWorkerOptions(options);
    const started: PublicWorker[] = [];
    for (let index = 0; index < validated.count; index += 1) {
      const id = nextWorkerId();
      const session = nextSession(validated.sessionPrefix);
      const cwd = resolve(validated.cwd || defaultCwd || dirname(graphPath));
      const workerArgs = [
        schedulerScriptPath,
        "worker",
        "--graph",
        graphPath,
        "--session",
        session,
        "--cwd",
        cwd
      ];

      if (validated.once) {
        workerArgs.push("--once");
      }
      if (validated.quiet) {
        workerArgs.push("--quiet");
      }
      if (validated.nodeId) {
        workerArgs.push("--node", validated.nodeId);
      }
      if (validated.idleMs !== undefined) {
        workerArgs.push("--idle-ms", String(validated.idleMs));
      }
      if (validated.leaseSeconds !== undefined) {
        workerArgs.push("--lease", String(validated.leaseSeconds));
      }
      if (validated.templatePath) {
        workerArgs.push("--template", validated.templatePath);
      }
      if (validated.codexCommand) {
        workerArgs.push("--codex-command", validated.codexCommand);
      }

      const codexArgs = validated.codexArgs && validated.codexArgs.length > 0
        ? validated.codexArgs
        : ["exec"];
      for (const arg of codexArgs) {
        workerArgs.push("--codex-arg", arg);
      }

      const child = spawn(process.execPath, workerArgs, {
        cwd: rootDir,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"]
      });
      const worker: ManagedWorker = {
        id,
        session,
        pid: child.pid,
        status: "running",
        cwd,
        startedAt: new Date().toISOString(),
        command: process.execPath,
        args: workerArgs,
        child,
        logTail: []
      };
      workers.set(id, worker);
      started.push(publicWorker(worker));

      child.stdout?.on("data", (chunk: Buffer) => {
        appendLog(worker, "stdout", chunk);
        notify();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        appendLog(worker, "stderr", chunk);
        notify();
      });
      child.on("error", (error) => {
        worker.status = "error";
        worker.error = error.message;
        worker.finishedAt = new Date().toISOString();
        notify();
      });
      child.on("exit", (code, signal) => {
        worker.status = "exited";
        worker.exitCode = code;
        worker.signal = signal;
        worker.finishedAt = new Date().toISOString();
        delete worker.child;
        notify();
      });
    }

    notify();
    return started;
  }

  function stopWorker(id: string): PublicWorker {
    const worker = workers.get(id);
    if (!worker) {
      throw new Error(`Unknown worker: ${id}`);
    }
    if (worker.child && worker.status === "running") {
      worker.status = "stopping";
      worker.stoppingAt = new Date().toISOString();
      worker.child.kill("SIGTERM");
    }
    notify();
    return publicWorker(worker);
  }

  function stopAll(): PublicWorker[] {
    const stopped: PublicWorker[] = [];
    for (const worker of workers.values()) {
      if (worker.child && worker.status === "running") {
        worker.status = "stopping";
        worker.stoppingAt = new Date().toISOString();
        worker.child.kill("SIGTERM");
      }
      stopped.push(publicWorker(worker));
    }
    notify();
    return stopped;
  }

  function status(): WorkerManagerStatus {
    return {
      defaults: {
        cwd: defaultCwd || dirname(graphPath),
        sessionPrefix: "codex",
        codexCommand: "codex"
      },
      workers: [...workers.values()]
        .map(publicWorker)
        .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
    };
  }

  return { startWorkers, stopWorker, stopAll, status };
}

export async function createVisualizerServer({
  graphPath = defaultGraphPath,
  port = 8787,
  host = "127.0.0.1",
  defaultWorkerCwd,
  runtime
}: CreateVisualizerServerOptions): Promise<VisualizerServerHandle> {
  const clients = new Set<ServerResponse>();
  let watcher: FSWatcher | undefined;
  let workerManager: WorkerManager;
  const listenPort = parseNumericArgument(port, { flag: "--port", ...numericArgumentRanges.port, defaultValue: 8787 })!;
  const securityWarning = visualizerHostSecurityWarning(host);

  async function send(client: ServerResponse): Promise<void> {
    const data = JSON.stringify(await buildVisualizerPayload(graphPath, workerManager));
    client.write(`data: ${data}\n\n`);
  }

  async function broadcast(): Promise<void> {
    for (const client of clients) {
      try {
        await send(client);
      } catch {
        clients.delete(client);
      }
    }
  }

  workerManager = createWorkerManager({
    graphPath,
    defaultCwd: defaultWorkerCwd || dirname(graphPath),
    schedulerScriptPath: runtime.schedulerScriptPath,
    rootDir: runtime.rootDir,
    onChange: broadcast
  });

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${host}:${listenPort}`);

      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(renderVisualizerHtml());
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/graph") {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify(await buildVisualizerPayload(graphPath, workerManager)));
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/workers") {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify(workerManager.status()));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/workers/start") {
        const body = await readRequestJson(req);
        const started = workerManager.startWorkers(body as StartWorkerOptions);
        await broadcast();
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ started, workerManager: workerManager.status() }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/workers/stop") {
        const body = await readRequestJson(req);
        const worker = workerManager.stopWorker(stringBodyField(body, "id"));
        await broadcast();
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ worker, workerManager: workerManager.status() }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/workers/stop-all") {
        const stopped = workerManager.stopAll();
        await broadcast();
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ stopped, workerManager: workerManager.status() }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/answer") {
        const body = await readRequestJson(req);
        const result: AnswerNodeResult & { slack?: SlackNotificationResult } = {
          ...await runtime.answerNode(graphPath, {
            nodeId: stringBodyField(body, "nodeId"),
            answer: stringBodyField(body, "answer"),
            responder: optionalStringBodyField(body, "responder")
          })
        };
        await runtime.renderPlanAfterUpdate(graphPath);
        result.slack = await runtime.sendSlackNotification(graphPath, "answered", {
          nodeId: optionalStringBodyField(body, "nodeId"),
          answer: optionalStringBodyField(body, "answer")
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
      const badRequest = error instanceof NumericArgumentError || error instanceof WorkerStartValidationError;
      res.writeHead(badRequest ? 400 : 500, { "content-type": "text/plain; charset=utf-8" });
      res.end(error instanceof Error ? (badRequest ? error.message : error.stack || error.message) : String(error));
    }
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(listenPort, host, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });

  watcher = watch(graphPath, async () => {
    await broadcast();
  });

  const address = server.address() as AddressInfo | string | null;
  const actualPort = typeof address === "object" && address ? address.port : listenPort;

  return {
    server,
    url: `http://${host}:${actualPort}`,
    securityWarning,
    close: async () => {
      workerManager.stopAll();
      watcher?.close();
      for (const client of clients) {
        client.end();
      }
      server.closeAllConnections?.();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  };
}

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
    workerManager: workerManager?.status?.() || {
      defaults: { cwd: dirname(graphPath), sessionPrefix: "codex", codexCommand: "codex" },
      workers: []
    }
  };
}

export async function readRequestJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 64 * 1024) {
      throw new Error("Request body is too large");
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) {
    return {};
  }
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function validateStartWorkerOptions(options: StartWorkerOptions): ValidatedStartWorkerOptions {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new WorkerStartValidationError("Worker start request body must be a JSON object");
  }

  const body = options as Record<string, unknown>;
  const countValue = numericStartField(body, "count", "--count");
  const idleMsValue = numericStartField(body, "idleMs", "--idle-ms");
  const leaseSecondsValue = numericStartField(body, "leaseSeconds", "--lease");

  return {
    count: parseNumericArgument(countValue, { flag: "--count", ...numericArgumentRanges.workerCount, defaultValue: 1 })!,
    idleMs: parseNumericArgument(idleMsValue, { flag: "--idle-ms", ...numericArgumentRanges.idleMs }),
    leaseSeconds: parseNumericArgument(leaseSecondsValue, { flag: "--lease", ...numericArgumentRanges.leaseSeconds }),
    sessionPrefix: optionalBoundedString(body, "sessionPrefix", workerStartLimits.sessionPrefixLength),
    cwd: optionalBoundedString(body, "cwd", workerStartLimits.pathLength),
    codexCommand: optionalBoundedString(body, "codexCommand", workerStartLimits.commandLength),
    codexArgs: optionalStringArray(body, "codexArgs", {
      maxLength: workerStartLimits.codexArgsLength,
      maxItemLength: workerStartLimits.codexArgLength
    }),
    templatePath: optionalBoundedString(body, "templatePath", workerStartLimits.pathLength),
    nodeId: optionalBoundedString(body, "nodeId", workerStartLimits.nodeIdLength),
    quiet: optionalBoolean(body, "quiet"),
    once: optionalBoolean(body, "once")
  };
}

function numericStartField(
  body: Record<string, unknown>,
  field: string,
  flag: string
): string | number | undefined {
  const value = body[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" && typeof value !== "number") {
    throw new WorkerStartValidationError(`Invalid ${flag}: expected number or numeric string`);
  }
  return value;
}

function optionalBoundedString(body: Record<string, unknown>, field: string, maxLength: number): string | undefined {
  const value = body[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new WorkerStartValidationError(`Invalid ${field}: expected string`);
  }
  if (!value.trim()) {
    throw new WorkerStartValidationError(`Invalid ${field}: expected non-empty string`);
  }
  if (value.length > maxLength) {
    throw new WorkerStartValidationError(`Invalid ${field}: expected string length <= ${maxLength}`);
  }
  if (value.includes("\0")) {
    throw new WorkerStartValidationError(`Invalid ${field}: null bytes are not allowed`);
  }
  return value;
}

function optionalStringArray(
  body: Record<string, unknown>,
  field: string,
  { maxLength, maxItemLength }: { maxLength: number; maxItemLength: number }
): string[] | undefined {
  const value = body[field];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new WorkerStartValidationError(`Invalid ${field}: expected string array`);
  }
  if (value.length > maxLength) {
    throw new WorkerStartValidationError(`Invalid ${field}: expected at most ${maxLength} entries`);
  }
  return value.map((item, index) => {
    if (typeof item !== "string") {
      throw new WorkerStartValidationError(`Invalid ${field}[${index}]: expected string`);
    }
    if (item.length > maxItemLength) {
      throw new WorkerStartValidationError(`Invalid ${field}[${index}]: expected string length <= ${maxItemLength}`);
    }
    if (item.includes("\0")) {
      throw new WorkerStartValidationError(`Invalid ${field}[${index}]: null bytes are not allowed`);
    }
    return item;
  });
}

function optionalBoolean(body: Record<string, unknown>, field: string): boolean {
  const value = body[field];
  if (value === undefined) {
    return false;
  }
  if (typeof value !== "boolean") {
    throw new WorkerStartValidationError(`Invalid ${field}: expected boolean`);
  }
  return value;
}

function publicWorker(worker: ManagedWorker): PublicWorker {
  return {
    id: worker.id,
    session: worker.session,
    pid: worker.pid,
    status: worker.status,
    cwd: worker.cwd,
    startedAt: worker.startedAt,
    finishedAt: worker.finishedAt,
    stoppingAt: worker.stoppingAt,
    exitCode: worker.exitCode,
    signal: worker.signal,
    error: worker.error,
    logTail: worker.logTail
  };
}

function stringBodyField(body: Record<string, unknown>, field: string): string {
  const value = optionalStringBodyField(body, field);
  if (!value) {
    throw new Error(`Missing ${field}`);
  }
  return value;
}

function optionalStringBodyField(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  return value === undefined ? undefined : String(value);
}

function safeFilePart(value: unknown): string {
  return String(value || "run").replaceAll(/[^a-zA-Z0-9._-]/g, "_");
}
