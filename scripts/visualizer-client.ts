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
    .panel-heading {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: flex-start;
      margin-bottom: 12px;
    }
    h2 {
      margin: 0 0 8px;
      font-size: 18px;
      letter-spacing: 0;
    }
    .toolbar {
      display: grid;
      grid-template-columns: minmax(220px, 1fr) auto;
      gap: 12px;
      align-items: end;
      margin-bottom: 14px;
    }
    .filter-row {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      align-items: center;
    }
    .filter-label {
      color: var(--muted);
      font-size: 12px;
      font-weight: 800;
      text-transform: uppercase;
    }
    .filter-button {
      border: 1px solid var(--line);
      background: #fff;
      color: var(--ink);
      min-height: 34px;
    }
    .filter-button[aria-pressed="true"] {
      border-color: var(--accent);
      background: #e9f7f5;
      color: #084a45;
      box-shadow: inset 0 0 0 1px var(--accent);
    }
    .filter-button[data-filter="attention"][aria-pressed="true"],
    .filter-button[data-worker-filter="needs-review"][aria-pressed="true"] {
      border-color: var(--failed);
      background: #fff1f1;
      color: var(--failed);
      box-shadow: inset 0 0 0 1px var(--failed);
    }
    .graph-viewport {
      overflow: auto;
      padding: 10px;
      border-radius: 8px;
      background: #fbfcfd;
      border: 1px solid #e5ebf2;
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
    .sp-node.status-failed rect { stroke: var(--failed); fill: #fff1f1; stroke-width: 2.4; }
    .badge {
      flex: 0 0 auto;
      border-radius: 999px;
      padding: 2px 8px;
      color: #fff;
      font-size: 12px;
      font-weight: 800;
      text-transform: uppercase;
    }
    .count-chip {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 2px 8px;
      color: var(--muted);
      background: #fff;
      font-size: 12px;
      font-weight: 800;
      white-space: nowrap;
    }
    .count-chip.urgent {
      border-color: #efb4b4;
      color: var(--failed);
      background: #fff5f5;
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
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }
    .sidebar-section + .sidebar-section {
      border-top: 1px solid var(--line);
      margin-top: 16px;
      padding-top: 16px;
    }
    .section-tools {
      display: grid;
      gap: 8px;
      margin-top: 10px;
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
    select,
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
      min-width: 0;
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
    button:focus-visible,
    input:focus-visible,
    select:focus-visible,
    textarea:focus-visible {
      outline: 3px solid #81c9c3;
      outline-offset: 2px;
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
    .worker-list,
    .diagnostic-list,
    .event-list {
      display: grid;
      gap: 8px;
      margin-top: 12px;
    }
    .ready-item,
    .working-item,
    .worker-item,
    .diagnostic-item,
    .event-item {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 9px;
      background: #fbfcfd;
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    .diagnostic-item.warning {
      border-color: #e7b767;
      border-left: 6px solid var(--blocked);
      background: #fff9ef;
    }
    .diagnostic-item.critical {
      border-color: #efa9a9;
      border-left: 6px solid var(--failed);
      background: #fff5f5;
    }
    .event-heading {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      align-items: baseline;
    }
    .event-details {
      margin-top: 5px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 11px;
      white-space: pre-wrap;
    }
    .working-item.status-blocked,
    .working-item.status-review {
      border-color: #e7b767;
      border-left: 6px solid var(--blocked);
      background: #fff9ef;
    }
    .working-item.status-failed,
    .worker-item.status-error {
      border-color: #efa9a9;
      border-left: 6px solid var(--failed);
      background: #fff5f5;
    }
    .working-item.status-running,
    .working-item.status-claimed,
    .worker-item.status-running,
    .worker-item.status-stopping {
      border-left: 6px solid var(--running);
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
      overflow-wrap: anywhere;
      word-break: break-word;
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
      .toolbar { grid-template-columns: 1fr; }
      .field-row { grid-template-columns: 1fr; }
      main { width: min(100% - 20px, 1280px); margin-top: 12px; }
      .sp-graph { min-width: 760px; }
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
  <div id="status-announcer" class="sr-only" aria-live="polite" aria-atomic="true"></div>
  <div class="layout">
    <section class="panel" aria-labelledby="graph-heading">
      <div class="panel-heading">
        <div>
          <h2 id="graph-heading">Graph</h2>
          <p id="graph-filter-summary">All nodes visible.</p>
        </div>
        <div id="attention-summary" class="summary" aria-label="Attention summary"></div>
      </div>
      <div class="toolbar" aria-label="Graph filters">
        <div class="field">
          <label for="graph-search">Search nodes, paths, logs</label>
          <input id="graph-search" type="search" autocomplete="off" placeholder="Filter lists by id, title, status, session, path, or log text">
        </div>
        <div>
          <div class="filter-label" id="activity-filter-label">Active Work</div>
          <div class="filter-row" role="group" aria-labelledby="activity-filter-label">
            <button class="filter-button" type="button" data-filter="all" aria-pressed="true">All</button>
            <button class="filter-button" type="button" data-filter="ready" aria-pressed="false">Ready</button>
            <button class="filter-button" type="button" data-filter="working" aria-pressed="false">Working</button>
            <button class="filter-button" type="button" data-filter="attention" aria-pressed="false">Attention</button>
          </div>
        </div>
      </div>
      <div id="graph" class="graph-viewport" role="region" aria-label="Scrollable graph diagram" tabindex="0"></div>
    </section>
    <aside class="panel" aria-label="Scheduler controls and status lists">
      <section class="sidebar-section" aria-labelledby="worker-manager-heading">
        <h2 id="worker-manager-heading">Worker Manager</h2>
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
              <label for="worker-isolation">Isolation</label>
              <select id="worker-isolation" name="isolation">
                <option value="off">off</option>
                <option value="git">git</option>
              </select>
            </div>
            <div class="field">
              <label for="worker-retention">Retention</label>
              <select id="worker-retention" name="workspaceRetention">
                <option value="on-failure">on-failure</option>
                <option value="always">always</option>
                <option value="never">never</option>
              </select>
            </div>
          </div>
          <div class="field-row">
            <div class="field">
              <label for="worker-remote">Remote</label>
              <input id="worker-remote" name="remote" autocomplete="off">
            </div>
            <div class="field">
              <label for="worker-workspace-root">Workspace Root</label>
              <input id="worker-workspace-root" name="workspaceRoot" autocomplete="off" value="runs/workspaces">
            </div>
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
        <div class="section-tools">
          <div class="filter-label" id="worker-filter-label">Worker State</div>
          <div class="filter-row" role="group" aria-labelledby="worker-filter-label">
            <button class="filter-button" type="button" data-worker-filter="all" aria-pressed="true">All</button>
            <button class="filter-button" type="button" data-worker-filter="active" aria-pressed="false">Active</button>
            <button class="filter-button" type="button" data-worker-filter="done" aria-pressed="false">Exited</button>
            <button class="filter-button" type="button" data-worker-filter="needs-review" aria-pressed="false">Error</button>
          </div>
        </div>
        <div id="workers" class="worker-list" role="list"></div>
      </section>
      <section class="sidebar-section" aria-labelledby="working-heading">
        <h2 id="working-heading">Active Sessions</h2>
        <p>Claimed, running, blocked, review, and failed nodes.</p>
        <div id="working" class="working-list" role="list"></div>
      </section>
      <section class="sidebar-section" aria-labelledby="diagnostics-heading">
        <h2 id="diagnostics-heading">Diagnostics</h2>
        <div id="diagnostics" class="diagnostic-list" role="list"></div>
      </section>
      <section class="sidebar-section" aria-labelledby="events-heading">
        <h2 id="events-heading">Recent Events</h2>
        <div id="recent-events" class="event-list" role="list"></div>
      </section>
      <section class="sidebar-section" aria-labelledby="ready-heading">
        <h2 id="ready-heading">Ready Leaf Nodes</h2>
        <p>These are claimable by Codex sessions.</p>
        <div id="ready" class="ready-list" role="list"></div>
      </section>
    </aside>
  </div>
</main>
<script>
  let workerDefaultsHydrated = false;
  let latestPayload = undefined;
  let lastAnnouncement = "";
  const filters = {
    activity: "all",
    worker: "all",
    query: ""
  };

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function statusToken(value) {
    return String(value || "unknown").toLowerCase().replaceAll(/[^a-z0-9_-]/g, "-");
  }

  function normalize(value) {
    return String(value || "").toLowerCase();
  }

  function boundedText(value) {
    const text = String(value || "");
    return text.length > 1000 ? text.slice(0, 1000) + "\\n[truncated from " + text.length + " chars]" : text;
  }

  function metaLine(label, value) {
    return value ? '<div class="meta">' + label + ': ' + escapeHtml(boundedText(value)) + '</div>' : "";
  }

  function nodeSearchText(node) {
    const isolation = node.isolation || {};
    return [
      node.id,
      node.title,
      node.status,
      node.kind,
      node.session,
      node.runId,
      node.expiresAt,
      node.question,
      node.answer,
      node.report,
      isolation.cloneCwd,
      isolation.baseRef,
      isolation.workRef,
      isolation.outputRef,
      isolation.integrationRef,
      ...(isolation.mergeRefs || []).map((input) => input.outputRef)
    ].map(normalize).join(" ");
  }

  function workerSearchText(worker) {
    return [
      worker.id,
      worker.session,
      worker.status,
      worker.pid,
      worker.cwd,
      worker.isolation,
      worker.remote,
      worker.workspaceRoot,
      worker.workspaceRetention,
      worker.exitCode,
      worker.signal,
      ...(worker.logTail || []).map((entry) => entry.text)
    ].map(normalize).join(" ");
  }

  function matchesQuery(searchText) {
    return !filters.query || searchText.includes(filters.query);
  }

  function isAttentionStatus(status) {
    return status === "blocked" || status === "review" || status === "failed";
  }

  function isAttentionNode(node) {
    const expiredIds = latestPayload?.attention?.expired?.nodeIds || [];
    return isAttentionStatus(node.status) || expiredIds.includes(node.id);
  }

  function workingPriority(node) {
    if (node.status === "failed") {
      return 0;
    }
    if (node.status === "blocked" || node.status === "review") {
      return 1;
    }
    if (node.status === "running" || node.status === "claimed") {
      return 2;
    }
    return 3;
  }

  function filterReadyNodes(ready) {
    if (filters.activity === "working" || filters.activity === "attention") {
      return [];
    }
    return ready.filter((node) => matchesQuery(nodeSearchText(node)));
  }

  function filterWorkingNodes(working) {
    if (filters.activity === "ready") {
      return [];
    }
    return working
      .filter((node) => filters.activity !== "attention" || isAttentionNode(node))
      .filter((node) => matchesQuery(nodeSearchText(node)))
      .slice()
      .sort((left, right) => workingPriority(left) - workingPriority(right) || String(left.id).localeCompare(String(right.id)));
  }

  function filterWorkers(workers) {
    return workers
      .filter((worker) => {
        if (filters.worker === "active") {
          return worker.status === "running" || worker.status === "stopping";
        }
        if (filters.worker === "done") {
          return worker.status === "exited";
        }
        if (filters.worker === "needs-review") {
          return worker.status === "error";
        }
        return true;
      })
      .filter((worker) => matchesQuery(workerSearchText(worker)));
  }

  function setPressed(selector, activeValue, attribute) {
    if (!document.querySelectorAll) {
      return;
    }
    document.querySelectorAll(selector).forEach((button) => {
      button.setAttribute("aria-pressed", button.getAttribute(attribute) === activeValue ? "true" : "false");
    });
  }

  function announce(message) {
    if (message === lastAnnouncement) {
      return;
    }
    lastAnnouncement = message;
    document.getElementById("status-announcer").textContent = message;
  }

  function renderReady(ready) {
    if (!ready.length) {
      return '<p>No ready nodes match the current filters.</p>';
    }
    return ready.map((node) => {
      const question = node.question ? '<div class="meta">question: ' + escapeHtml(node.question) + '</div>' : "";
      const answer = node.answer ? '<div class="meta">answer: ' + escapeHtml(node.answer) + '</div>' : "";
      return '<div class="ready-item" role="listitem">' +
        '<strong>' + escapeHtml(node.id) + '</strong><br>' + escapeHtml(node.title || node.id) +
        question + answer +
        '</div>';
    }).join("");
  }

  function renderWorking(working) {
    if (!working.length) {
      return '<p>No active sessions match the current filters.</p>';
    }
    return working.map((node, index) => {
      const isolation = node.isolation || {};
      const lease = metaLine("session", node.session);
      const run = metaLine("run", node.runId);
      const expiry = metaLine("expires", node.expiresAt);
      const question = metaLine("question", node.question);
      const answer = metaLine("answer", node.answer);
      const report = metaLine("report", node.report);
      const cloneCwd = metaLine("clone cwd", isolation.cloneCwd);
      const baseRef = metaLine("base ref", isolation.baseRef);
      const workRef = metaLine("work ref", isolation.workRef);
      const outputRef = metaLine("output ref", isolation.outputRef || isolation.publishedOutputRef);
      const integrationRef = metaLine("integration ref", isolation.integrationRef);
      const mergeRefs = isolation.mergeRefs?.length
        ? metaLine("merge refs", isolation.mergeRefs.map((input) => input.nodeId + ": " + input.outputRef).join("\\n"))
        : "";
      const conflictedRefs = isolation.conflictedMergeRefs?.length
        ? metaLine("conflicted refs", isolation.conflictedMergeRefs.map((input) => input.nodeId + ": " + input.outputRef).join("\\n"))
        : "";
      const answerId = "answer-" + index + "-" + statusToken(node.id).slice(0, 48);
      const answerForm = node.status === "blocked" ? '<form class="answer-form" data-answer-form data-node-id="' + escapeHtml(node.id) + '">' +
        '<label for="' + answerId + '">Answer for ' + escapeHtml(node.id) + '</label>' +
        '<textarea id="' + answerId + '" name="answer" placeholder="Answer" required></textarea>' +
        '<button type="submit">Answer</button>' +
        '</form>' : "";
      const token = statusToken(node.status);
      return '<div class="working-item status-' + token + '" role="listitem">' +
        '<span class="badge status-' + token + '">' + escapeHtml(node.status) + '</span>' +
        '<div><strong>' + escapeHtml(node.id) + '</strong><br>' + escapeHtml(node.title || node.id) + '</div>' +
        lease + run + expiry + question + answer + report + cloneCwd + baseRef + workRef + outputRef + integrationRef + mergeRefs + conflictedRefs + answerForm +
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
    document.getElementById("worker-isolation").value = saved.isolation || manager.defaults.isolation || "off";
    document.getElementById("worker-remote").value = saved.remote || "";
    document.getElementById("worker-workspace-root").value = saved.workspaceRoot || manager.defaults.workspaceRoot || "runs/workspaces";
    document.getElementById("worker-retention").value = saved.workspaceRetention || manager.defaults.workspaceRetention || "on-failure";
    document.querySelector("[name=quiet]").checked = Boolean(saved.quiet);
    document.querySelector("[name=once]").checked = Boolean(saved.once);
    syncIsolationFields();
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
    const visibleWorkers = filterWorkers(workers);
    const active = (manager?.running || 0) + (manager?.stopping || 0);
    const failures = manager?.recentFailureReason ? " / last failure: " + manager.recentFailureReason : "";
    document.getElementById("worker-manager-summary").textContent = active + " active / " + (manager?.retainedWorkers ?? workers.length) + " retained / " + (manager?.exited || 0) + " exited / " + (manager?.error || 0) + " error" + failures;
    if (!visibleWorkers.length) {
      document.getElementById("workers").innerHTML = '<p>No managed workers match the current filters.</p>';
      return;
    }
    document.getElementById("workers").innerHTML = visibleWorkers.map((worker) => {
      const pid = metaLine("pid", worker.pid);
      const cwd = metaLine("repo", worker.cwd);
      const isolation = metaLine("isolation", worker.isolation);
      const remote = metaLine("remote", worker.remote);
      const workspaceRoot = metaLine("workspace root", worker.workspaceRoot);
      const retention = metaLine("retention", worker.workspaceRetention);
      const duration = worker.durationMs !== undefined ? metaLine("duration", worker.durationMs + " ms") : "";
      const exit = worker.exitCode !== undefined && worker.exitCode !== null ? metaLine("exit", worker.exitCode) : "";
      const signal = metaLine("signal", worker.signal);
      const failure = metaLine("failure", worker.recentFailureReason);
      const log = worker.logTail?.length ? '<div class="log-tail">' + escapeHtml(worker.logTail.map((entry) => {
        const marker = entry.truncated ? "[" + entry.stream + " truncated from " + entry.originalLength + " chars]\\n" : "";
        return marker + entry.text;
      }).join("")) + '</div>' : "";
      const stop = worker.status === "running" || worker.status === "stopping"
        ? '<button class="danger" type="button" data-stop-worker="' + escapeHtml(worker.id) + '" aria-label="Stop worker ' + escapeHtml(worker.session) + '">Stop</button>'
        : "";
      return '<div class="worker-item status-' + statusToken(worker.status) + '" role="listitem">' +
        '<div class="worker-heading"><div><span class="badge status-' + statusClass(worker.status) + '">' + escapeHtml(worker.status) + '</span>' +
        '<div><strong>' + escapeHtml(worker.session) + '</strong></div></div>' + stop + '</div>' +
        pid + cwd + isolation + remote + workspaceRoot + retention + duration + exit + signal + failure + log +
        '</div>';
    }).join("");
  }

  function renderSummary(summary) {
    const counts = summary.counts || {};
    return Object.keys(counts).sort().map((status) => '<span class="pill">' + escapeHtml(status) + ': ' + counts[status] + '</span>').join("");
  }

  function renderAttentionSummary(payload) {
    const attention = payload.attention || {};
    const blocked = Number(attention.blocked?.count || 0);
    const failed = Number(attention.failed?.count || 0);
    const expired = Number(attention.expired?.count || 0);
    const workerErrors = Number(attention.workerErrors?.count || 0);
    const className = failed || blocked || expired || workerErrors ? "count-chip urgent" : "count-chip";
    document.getElementById("attention-summary").innerHTML =
      '<span class="' + className + '">failed: ' + failed + '</span>' +
      '<span class="' + className + '">blocked: ' + blocked + '</span>' +
      '<span class="' + className + '">expired: ' + expired + '</span>' +
      '<span class="' + className + '">worker errors: ' + workerErrors + '</span>';
  }

  function renderDiagnostics(payload) {
    const diagnostics = payload.diagnostics || {};
    const attention = payload.attention || {};
    const items = [];
    if (attention.failed?.count) {
      items.push({
        severity: "critical",
        title: "Failed nodes",
        body: attention.failed.nodeIds.join(", ")
      });
    }
    if (attention.blocked?.count) {
      items.push({
        severity: "warning",
        title: "Blocked or review nodes",
        body: attention.blocked.nodeIds.join(", ")
      });
    }
    if (attention.expired?.count) {
      items.push({
        severity: "warning",
        title: "Expired leases",
        body: attention.expired.nodeIds.join(", ") + " / releasable: " + Number(attention.expired.releasable || 0)
      });
    }
    if (attention.workerErrors?.count) {
      items.push({
        severity: "critical",
        title: "Worker errors",
        body: attention.workerErrors.workerIds.join(", ")
      });
    }
    if (diagnostics.lock) {
      const lock = diagnostics.lock;
      const owner = lock.owner ? [
        lock.owner.ownerId,
        lock.owner.pid ? "pid " + lock.owner.pid : "",
        lock.owner.host
      ].filter(Boolean).join(" / ") : "unknown owner";
      items.push({
        severity: lock.exists ? (lock.stale ? "critical" : "warning") : "info",
        title: lock.exists ? (lock.stale ? "Stale graph lock" : "Graph lock present") : "Graph lock clear",
        body: lock.exists
          ? "read-only / " + owner + " / age " + Math.round(Number(lock.ageMs || 0) / 1000) + "s / refresh diagnostics after the owner finishes"
          : "no lock directory present"
      });
    }
    if (!items.length) {
      return '<p>No diagnostics need attention.</p>';
    }
    return items.map((item) => '<div class="diagnostic-item ' + escapeHtml(item.severity) + '" role="listitem">' +
      '<strong>' + escapeHtml(item.title) + '</strong>' +
      '<div class="meta">' + escapeHtml(item.body) + '</div>' +
      '</div>').join("");
  }

  function renderRecentEvents(events) {
    if (!events?.length) {
      return '<p>No recent events are recorded.</p>';
    }
    return events.slice(0, 8).map((event) => {
      const details = event.details && Object.keys(event.details).length
        ? '<div class="event-details">' + escapeHtml(boundedText(JSON.stringify(event.details, null, 2))) + '</div>'
        : "";
      return '<div class="event-item" role="listitem">' +
        '<div class="event-heading"><strong>' + escapeHtml(event.event) + '</strong><span class="meta">' + escapeHtml(event.nodeId) + '</span></div>' +
        '<div class="meta">' + escapeHtml(event.at || "") + '</div>' +
        details +
        '</div>';
    }).join("");
  }

  function renderFilterSummary(visibleReady, visibleWorking, visibleWorkers) {
    const query = filters.query ? ' / search "' + filters.query + '"' : "";
    const message = "Showing " + visibleReady.length + " ready, " + visibleWorking.length + " active, " + visibleWorkers.length + " workers" + query + ".";
    document.getElementById("graph-filter-summary").textContent = message;
    announce(message);
  }

  function render(payload) {
    latestPayload = payload;
    setPressed("[data-filter]", filters.activity, "data-filter");
    setPressed("[data-worker-filter]", filters.worker, "data-worker-filter");
    const visibleReady = filterReadyNodes(payload.ready || []);
    const visibleWorking = filterWorkingNodes(payload.working || []);
    const visibleWorkers = filterWorkers(payload.workerManager?.workers || []);
    document.getElementById("subtitle").textContent = "graph v" + payload.summary.graphVersion + " / " + payload.summary.totalNodes + " nodes";
    document.getElementById("summary").innerHTML = renderSummary(payload.summary);
    document.getElementById("graph").innerHTML = payload.graphSvg;
    document.getElementById("working").innerHTML = renderWorking(visibleWorking);
    document.getElementById("diagnostics").innerHTML = renderDiagnostics(payload);
    document.getElementById("recent-events").innerHTML = renderRecentEvents(payload.recentEvents || []);
    document.getElementById("ready").innerHTML = renderReady(visibleReady);
    renderAttentionSummary(payload);
    renderFilterSummary(visibleReady, visibleWorking, visibleWorkers);
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
        headers: writeHeaders(true),
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
    const isolation = form.isolation.value || "off";
    const remote = form.remote.value.trim();
    const body = {
      count: Number(form.count.value || 1),
      sessionPrefix: form.sessionPrefix.value.trim() || "codex",
      cwd: isolation === "git" ? undefined : form.cwd.value.trim(),
      codexCommand: form.codexCommand.value.trim() || "codex",
      codexArgs: form.codexArgs.value.split(/\\r?\\n/).map((line) => line.trim()).filter(Boolean),
      idleMs: Number(form.idleMs.value || 5000),
      quiet: form.quiet.checked,
      once: form.once.checked,
      isolation,
      remote: remote || undefined,
      workspaceRoot: form.workspaceRoot.value.trim() || undefined,
      workspaceRetention: form.workspaceRetention.value || "on-failure"
    };
    localStorage.setItem("spgWorkerManager", JSON.stringify(body));
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    try {
      const response = await fetch("/api/workers/start", {
        method: "POST",
        headers: writeHeaders(true),
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
      headers: writeHeaders(true),
      body: JSON.stringify({ id: stopButton.dataset.stopWorker })
    });
    await load();
  });

  document.getElementById("stop-all-workers").addEventListener("click", async () => {
    await fetch("/api/workers/stop-all", { method: "POST", headers: writeHeaders(false) });
    await load();
  });

  document.addEventListener("click", (event) => {
    const activityButton = event.target.closest("[data-filter]");
    if (activityButton) {
      filters.activity = activityButton.dataset.filter || "all";
      if (latestPayload) {
        render(latestPayload);
      }
      return;
    }
    const workerButton = event.target.closest("[data-worker-filter]");
    if (workerButton) {
      filters.worker = workerButton.dataset.workerFilter || "all";
      if (latestPayload) {
        render(latestPayload);
      }
    }
  });

  document.getElementById("graph-search").addEventListener("input", (event) => {
    filters.query = normalize(event.target.value).trim();
    if (latestPayload) {
      render(latestPayload);
    }
  });

  document.getElementById("worker-isolation").addEventListener("change", syncIsolationFields);

  function syncIsolationFields() {
    const isolation = document.getElementById("worker-isolation").value;
    const git = isolation === "git";
    document.getElementById("worker-cwd").disabled = git;
    document.getElementById("worker-remote").disabled = !git;
    document.getElementById("worker-workspace-root").disabled = !git;
    document.getElementById("worker-retention").disabled = !git;
  }

  load();
  const events = new EventSource("/events");
  events.onmessage = (event) => render(JSON.parse(event.data));
  events.onerror = () => {
    document.getElementById("subtitle").textContent = "Connection lost. Retrying...";
  };

  function visualizerWriteToken() {
    const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
    const hashToken = hash.get("write-token") || hash.get("writeToken");
    if (hashToken) {
      localStorage.setItem("spgVisualizerWriteToken", hashToken);
      return hashToken;
    }
    return localStorage.getItem("spgVisualizerWriteToken") || "";
  }

  function writeHeaders(json) {
    const headers = json ? { "content-type": "application/json" } : {};
    const token = visualizerWriteToken();
    if (token) {
      headers["x-spg-visualizer-token"] = token;
    }
    return headers;
  }
</script>
</body>
</html>`;
}
