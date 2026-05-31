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
    .sp-node-ref {
      fill: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 10.5px;
      font-weight: 800;
      letter-spacing: 0;
      text-anchor: end;
    }
    .sp-node-insertions { fill: var(--done); }
    .sp-node-deletions { fill: var(--failed); }
    .sp-node-files { fill: var(--muted); }
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
    .planner-result {
      margin-top: 10px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 9px;
      background: #fbfcfd;
      overflow-wrap: anywhere;
      word-break: break-word;
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
    .node-select-button {
      display: block;
      width: 100%;
      padding: 0;
      border: 0;
      background: transparent;
      color: inherit;
      text-align: left;
      font: inherit;
      cursor: pointer;
    }
    .node-select-button[aria-current="true"] {
      outline: 3px solid #81c9c3;
      outline-offset: 3px;
      border-radius: 6px;
    }
    .selected-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin: 10px 0;
    }
    .selected-actions button[disabled] {
      cursor: not-allowed;
      opacity: 0.55;
    }
    .inspector-section {
      margin-top: 14px;
      padding-top: 12px;
      border-top: 1px solid var(--line);
    }
    .inspector-section h3 {
      margin: 0 0 8px;
      font-size: 14px;
      letter-spacing: 0;
    }
    .git-action-row {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin: 10px 0;
    }
    .git-action-link,
    .git-action-disabled {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 32px;
      border-radius: 8px;
      padding: 6px 10px;
      font-size: 12px;
      font-weight: 800;
      text-decoration: none;
    }
    .git-action-link {
      border: 1px solid var(--line);
      color: var(--ink);
      background: #fff;
    }
    .git-action-disabled {
      border: 1px solid var(--line);
      color: var(--muted);
      background: #f1f4f8;
      cursor: not-allowed;
    }
    .git-file-table-wrap {
      max-height: 240px;
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
    }
    .git-file-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }
    .git-file-table th,
    .git-file-table td {
      padding: 6px 8px;
      border-bottom: 1px solid #edf1f5;
      text-align: left;
      vertical-align: top;
    }
    .git-file-table th {
      position: sticky;
      top: 0;
      z-index: 1;
      background: #f8fafc;
      color: var(--muted);
      font-size: 11px;
      text-transform: uppercase;
    }
    .git-file-table td.number {
      text-align: right;
      white-space: nowrap;
      font-variant-numeric: tabular-nums;
    }
    .git-file-path {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    .modal-backdrop {
      position: fixed;
      inset: 0;
      z-index: 20;
      display: grid;
      place-items: center;
      padding: 16px;
      background: rgba(15, 23, 42, 0.42);
    }
    .modal-dialog {
      width: min(620px, 100%);
      max-height: min(90vh, 760px);
      overflow: auto;
      background: var(--paper);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 16px;
      box-shadow: 0 24px 70px rgba(20, 30, 42, 0.28);
    }
    .modal-form,
    .decompose-form,
    .decompose-children {
      display: grid;
      gap: 10px;
    }
    .decompose-child-row {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px;
      display: grid;
      gap: 8px;
    }
    .decompose-preview {
      max-height: 180px;
      overflow: auto;
      margin: 0;
      border-radius: 8px;
      background: #101820;
      color: #dbe7f2;
      padding: 8px;
      font-size: 11px;
      white-space: pre-wrap;
    }
    .planner-preview-list {
      display: grid;
      gap: 6px;
      margin: 8px 0;
      padding: 0;
      list-style: none;
    }
    [data-modal-error],
    .action-error {
      color: var(--failed);
      font-size: 13px;
      font-weight: 700;
    }
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
      <section class="sidebar-section" aria-labelledby="goal-planner-heading">
        <h2 id="goal-planner-heading">Goal Planner</h2>
        <form id="goal-planner-form" class="manager-form">
          <div class="field">
            <label for="goal-text">Goal</label>
            <textarea id="goal-text" name="goal" placeholder="Describe the outcome to plan" required></textarea>
          </div>
          <div class="field">
            <label for="goal-title">Title</label>
            <input id="goal-title" name="title" autocomplete="off" placeholder="Optional plan title">
          </div>
          <div class="field">
            <label for="goal-planner-fixture">Planner Fixture</label>
            <input id="goal-planner-fixture" name="plannerFixturePath" autocomplete="off" placeholder="Optional fixture path relative to graph">
          </div>
          <div id="goal-planner-error" class="action-error" role="alert"></div>
          <div class="button-row">
            <button class="secondary" type="submit" name="intent" value="preview">Preview</button>
            <button type="submit" name="intent" value="create">Create Graph</button>
          </div>
        </form>
        <div id="goal-planner-result" class="planner-result">No goal preview generated.</div>
      </section>
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
            <button class="secondary" type="button" id="start-selected-worker" disabled>Start Selected</button>
            <button type="submit">Start</button>
          </div>
        </form>
        <div id="selected-worker-summary" class="meta">No node selected.</div>
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
      <section class="sidebar-section" aria-labelledby="selected-node-heading">
        <h2 id="selected-node-heading">Node Detail</h2>
        <div id="selected-node-details"><p>Select a node to inspect it.</p></div>
      </section>
      <section class="sidebar-section" aria-labelledby="attention-heading">
        <h2 id="attention-heading">Attention</h2>
        <div id="attention-dashboard"></div>
      </section>
      <section class="sidebar-section" aria-labelledby="triage-heading">
        <h2 id="triage-heading">Triage</h2>
        <div id="diagnostics-panel"></div>
      </section>
      <section class="sidebar-section" aria-labelledby="event-browser-heading">
        <h2 id="event-browser-heading">Event Browser</h2>
        <div class="field-row">
          <div class="field">
            <label for="event-node-filter">Node</label>
            <input id="event-node-filter" autocomplete="off">
          </div>
          <div class="field">
            <label for="event-name-filter">Event</label>
            <select id="event-name-filter"><option value="">Any event</option></select>
          </div>
        </div>
        <div id="events-list"></div>
      </section>
    </aside>
  </div>
  <div id="modal-root"></div>
</main>
<script>
  let workerDefaultsHydrated = false;
  let latestPayload = undefined;
  let lastAnnouncement = "";
  let selectedNodeId = "";
  const eventFilters = { node: "", event: "" };
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

  function numericValue(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  }

  function additionsValue(value) {
    return numericValue(value?.additions) ?? numericValue(value?.insertions);
  }

  function formatCount(value) {
    return value === null || value === undefined ? "n/a" : String(value);
  }

  function goalText(goal) {
    return typeof goal === "string" ? goal : goal?.text;
  }

  function detailGoalText(node) {
    return node.goalText || goalText(node.goal);
  }

  function plannerDecisionText(node) {
    return node.plannerDecision || node.decision || node.planner?.decision || node.planner?.rationale;
  }

  function decompositionReasonText(node) {
    return node.decompositionReason || node.decomposeReason || node.planner?.decompositionReason || node.rationale;
  }

  function plannerPreviewText(node) {
    const preview = node.pendingPlannerPreview;
    if (!preview) {
      return "";
    }
    const children = Array.isArray(preview.decompose?.children)
      ? preview.decompose.children.map((child) => child.id + ": " + child.title).join("; ")
      : (Array.isArray(preview.childIds) ? preview.childIds.join(", ") : "");
    return [
      "request " + (preview.requestId || "unknown"),
      "graph v" + (preview.graphVersion ?? "unknown"),
      "kind " + (preview.decompose?.kind || preview.proposedKind || "unknown"),
      children ? "children " + children : "",
      preview.report ? "report " + preview.report : ""
    ].filter(Boolean).join(" / ");
  }

  function nodeAction(node, actionId) {
    return (node.actions || []).find((action) => action.id === actionId);
  }

  function actionableDisabledReason(action, node) {
    if (!action?.disabledReason) {
      return "";
    }
    if (node?.lease && /no worker credentials/.test(action.disabledReason)) {
      return "";
    }
    return action.disabledReason;
  }

  function previewNodeState(node) {
    return {
      status: node.status,
      kind: node.kind,
      children: Array.isArray(node.children) && node.children.length ? [...node.children] : undefined,
      lease: node.lease ? { session: node.lease.session, runId: node.lease.runId } : undefined,
      blockedReason: node.blockedReason,
      question: node.question,
      report: node.report
    };
  }

  function sortJsonValue(value) {
    if (Array.isArray(value)) {
      return value.map(sortJsonValue);
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value)
        .filter((entry) => entry[1] !== undefined)
        .sort((left, right) => left[0].localeCompare(right[0]))
        .map((entry) => [entry[0], sortJsonValue(entry[1])]));
    }
    return value;
  }

  function stableJsonStringify(value) {
    return JSON.stringify(sortJsonValue(value));
  }

  function clientPreviewFreshnessReason(node) {
    const preview = node.pendingPlannerPreview;
    if (!preview) {
      return "";
    }
    const graphVersion = latestPayload?.summary?.graphVersion;
    if (preview.graphVersion !== undefined && graphVersion !== undefined && preview.graphVersion !== graphVersion) {
      return "Planner preview is stale: graph version changed from " + preview.graphVersion + " to " + graphVersion + ".";
    }
    if (stableJsonStringify(preview.nodeState || {}) !== stableJsonStringify(previewNodeState(node) || {})) {
      return "Planner preview is stale: node state changed.";
    }
    return "";
  }

  function joinList(values) {
    return Array.isArray(values) && values.length ? values.join(", ") : undefined;
  }

  function formatContextRefs(refs) {
    if (!Array.isArray(refs) || !refs.length) {
      return undefined;
    }
    return refs.map((ref) => [
      ref.title,
      ref.type,
      ref.ref,
      ref.nodeId ? "node " + ref.nodeId : ""
    ].filter(Boolean).join(" / ")).join("\\n");
  }

  function formatOutputContract(contract) {
    if (!contract || typeof contract !== "object") {
      return undefined;
    }
    return [
      contract.format ? "format: " + contract.format : "",
      contract.schemaRef ? "schema: " + contract.schemaRef : "",
      joinList(contract.requiredArtifacts) ? "required artifacts: " + joinList(contract.requiredArtifacts) : "",
      joinList(contract.acceptanceCriteria) ? "acceptance: " + joinList(contract.acceptanceCriteria) : ""
    ].filter(Boolean).join("\\n");
  }

  function formatResultSummary(result) {
    if (!result || typeof result !== "object") {
      return undefined;
    }
    return [
      result.status ? "status: " + result.status : "",
      result.summary,
      joinList(result.artifacts) ? "artifacts: " + joinList(result.artifacts) : "",
      result.report ? "report: " + result.report : "",
      result.outputRef ? "output ref: " + result.outputRef : "",
      result.completedAt ? "completed: " + result.completedAt : "",
      result.updatedAt ? "updated: " + result.updatedAt : ""
    ].filter(Boolean).join("\\n");
  }

  function gitRefText(ref) {
    return ref?.display || [ref?.name, ref?.commit].filter(Boolean).join(" @ ");
  }

  function appendGitFootprintSection(parent, git) {
    if (!git) {
      return;
    }
    const section = document.createElement("section");
    const heading = document.createElement("h3");
    heading.textContent = "Git Footprint";
    section.append(heading);

    appendMetaLine(section, "commit", git.commit);
    appendMetaLine(section, "branch", git.branch);
    appendMetaLine(section, "base ref", gitRefText(git.baseRef));
    appendMetaLine(section, "work ref", gitRefText(git.workRef));
    appendMetaLine(section, "output ref", gitRefText(git.outputRef || git.headRef));
    appendMetaLine(section, "integration ref", git.integrationRef?.name);
    appendMetaLine(section, "remote", git.remoteDisplay);
    appendMetaLine(section, "workspace", git.workspaceDisplay);

    if (git.diffStat) {
      appendMetaLine(
        section,
        "diffstat",
        git.diffStat.filesChanged + " files, +" + git.diffStat.insertions + " / -" + git.diffStat.deletions
      );
    }

    if (Array.isArray(git.changedFiles) && git.changedFiles.length) {
      const fileList = document.createElement("div");
      fileList.className = "meta";
      const rows = git.changedFiles.map((file) => {
        const oldPath = file.oldPath ? " from " + file.oldPath : "";
        const type = file.changeType ? " [" + file.changeType + "]" : "";
        const insertions = file.insertions === null ? "?" : file.insertions;
        const deletions = file.deletions === null ? "?" : file.deletions;
        return file.path + oldPath + type + " +" + insertions + " / -" + deletions;
      });
      if (git.changedFilesTruncated > 0) {
        rows.push("+" + git.changedFilesTruncated + " more files");
      }
      fileList.textContent = "changed files: " + boundedText(rows.join("\\n"));
      section.append(fileList);
    }

    parent.append(section);
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
      detailGoalText(node),
      plannerDecisionText(node),
      decompositionReasonText(node),
      formatContextRefs(node.contextRefs),
      formatOutputContract(node.outputContract),
      formatResultSummary(node.resultSummary),
      node.expiresAt,
      node.question,
      node.answer,
      node.blockedReason,
      node.failureReason,
      node.report,
      node.git?.commit,
      node.git?.branch,
      node.git?.baseRef?.display,
      node.git?.workRef?.display,
      node.git?.outputRef?.display,
      node.git?.remoteDisplay,
      node.git?.workspaceDisplay,
      ...(node.git?.changedFiles || []).map((file) => file.path),
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

  function graphNodeEntries(payload = latestPayload) {
    return Object.entries(payload?.graph?.graph?.nodes || {}).map(([id, node]) => ({ id, node }));
  }

  function selectedEntry() {
    const detail = latestPayload?.nodes?.find((node) => node.id === selectedNodeId);
    if (detail) {
      return { id: detail.id, node: detail };
    }
    return graphNodeEntries().find((entry) => entry.id === selectedNodeId);
  }

  function selectedDetail() {
    return (latestPayload?.nodes || []).find((node) => node.id === selectedNodeId);
  }

  function nodeIsReady(nodeId) {
    return (latestPayload?.ready || []).some((node) => node.id === nodeId);
  }

  function selectNode(nodeId) {
    selectedNodeId = String(nodeId || "");
    if (latestPayload) {
      render(latestPayload);
    }
    announce(selectedNodeId ? "Selected node " + selectedNodeId + "." : "Selection cleared.");
  }

  function closeModal() {
    document.getElementById("modal-root").innerHTML = "";
  }

  async function apiPost(path, body) {
    const response = await fetch(path, {
      method: "POST",
      headers: writeHeaders(true),
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      throw new Error(await response.text());
    }
    const result = await response.json();
    await load();
    return result;
  }

  function modalFieldHtml(field) {
    const id = "modal-field-" + statusToken(field.name);
    const value = field.value === undefined || field.value === null ? "" : String(field.value);
    const required = field.required ? " required" : "";
    const label = '<label for="' + id + '">' + escapeHtml(field.label) + '</label>';
    if (field.type === "textarea") {
      return '<div class="field">' + label + '<textarea id="' + id + '" name="' + escapeHtml(field.name) + '"' + required + '>' + escapeHtml(value) + '</textarea></div>';
    }
    return '<div class="field">' + label + '<input id="' + id + '" name="' + escapeHtml(field.name) + '" type="' + escapeHtml(field.type || "text") + '" value="' + escapeHtml(value) + '"' + required + '></div>';
  }

  function openActionModal({ title, fields, submitLabel, onSubmit }) {
    const root = document.getElementById("modal-root");
    root.innerHTML = '<div class="modal-backdrop">' +
      '<section class="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="action-modal-title">' +
        '<h2 id="action-modal-title">' + escapeHtml(title) + '</h2>' +
        '<form class="modal-form" data-action-modal-form>' +
          fields.map(modalFieldHtml).join("") +
          '<div data-modal-error></div>' +
          '<div class="button-row"><button class="secondary" type="button" data-modal-cancel>Cancel</button><button type="submit">' + escapeHtml(submitLabel || "Confirm") + '</button></div>' +
        '</form>' +
      '</section>' +
    '</div>';
    const form = root.querySelector("[data-action-modal-form]");
    root.querySelector("[data-modal-cancel]").addEventListener("click", closeModal);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const values = {};
      form.querySelectorAll("input[name], textarea[name]").forEach((field) => {
        values[field.name] = field.value.trim();
      });
      try {
        await onSubmit(values);
        closeModal();
      } catch (error) {
        root.querySelector("[data-modal-error]").textContent = error?.message || String(error);
      }
    });
    (form.querySelector("input, textarea") || form.querySelector("button[type=submit]"))?.focus();
  }

  function renderReady(ready) {
    if (!ready.length) {
      return '<p>No ready nodes match the current filters.</p>';
    }
    return ready.map((node) => {
      const question = node.question ? '<div class="meta">question: ' + escapeHtml(node.question) + '</div>' : "";
      const answer = node.answer ? '<div class="meta">answer: ' + escapeHtml(node.answer) + '</div>' : "";
      return '<div class="ready-item" role="listitem">' +
        '<button class="node-select-button" type="button" data-select-node="' + escapeHtml(node.id) + '" aria-current="' + (selectedNodeId === node.id ? "true" : "false") + '">' +
        '<strong>' + escapeHtml(node.id) + '</strong><br>' + escapeHtml(node.title || node.id) +
        '</button>' +
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
      const blockedReason = metaLine("blocked reason", node.blockedReason);
      const failureReason = metaLine("failure reason", node.failureReason);
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
        '<button class="node-select-button" type="button" data-select-node="' + escapeHtml(node.id) + '" aria-current="' + (selectedNodeId === node.id ? "true" : "false") + '">' +
        '<span class="badge status-' + token + '">' + escapeHtml(node.status) + '</span>' +
        '<div><strong>' + escapeHtml(node.id) + '</strong><br>' + escapeHtml(node.title || node.id) + '</div>' +
        '</button>' +
        lease + run + expiry + question + answer + blockedReason + failureReason + report + cloneCwd + baseRef + workRef + outputRef + integrationRef + mergeRefs + conflictedRefs + answerForm +
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

  function refLabel(ref) {
    if (!ref) {
      return "";
    }
    return ref.display || [ref.name, ref.commit ? ref.commit.slice(0, 12) : ""].filter(Boolean).join(" @ ");
  }

  function compareToken(ref) {
    const value = ref?.commit || ref?.name;
    if (!value) {
      return "";
    }
    return String(value)
      .replace(/^refs\\/heads\\//, "")
      .replace(/^refs\\/remotes\\/origin\\//, "")
      .replace(/^refs\\/remotes\\/[^/]+\\//, "");
  }

  function githubProjectUrl(remote) {
    const text = String(remote || "").trim();
    const httpsMatch = text.match(/^https?:\\/\\/(?:[^/@]+@)?github\\.com\\/([^/\\s]+)\\/([^/\\s]+?)(?:\\.git)?\\/?$/i);
    const sshMatch = text.match(/^git@github\\.com:([^/\\s]+)\\/([^/\\s]+?)(?:\\.git)?$/i)
      || text.match(/^ssh:\\/\\/git@github\\.com\\/([^/\\s]+)\\/([^/\\s]+?)(?:\\.git)?\\/?$/i);
    const match = httpsMatch || sshMatch;
    if (!match) {
      return "";
    }
    return "https://github.com/" + encodeURIComponent(match[1]) + "/" + encodeURIComponent(match[2].replace(/\\.git$/i, ""));
  }

  function gitActionAvailability(detail) {
    const refs = detail?.refs || {};
    const footprint = detail?.gitFootprint || refs.gitFootprint || {};
    const git = detail?.git || {};
    const baseRef = git.baseRef || footprint.baseRef || refs.baseRef || detail?.baseRef;
    const headRef = git.headRef || footprint.headRef || git.outputRef || refs.outputRef || refs.integrationRef || refs.workRef || detail?.outputRef || detail?.integrationRef || detail?.workRef || git.integrationRef || git.workRef;
    const base = compareToken(baseRef);
    const head = compareToken(headRef);
    const remote = detail?.workspace?.remote || detail?.workspaceDisplay?.remote || git.remoteDisplay;
    const projectUrl = githubProjectUrl(remote);
    const missing = [];
    if (!base) {
      missing.push("base ref");
    }
    if (!head) {
      missing.push("head ref");
    }
    if (missing.length) {
      return { disabledReason: "Missing " + missing.join(" and ") + "." };
    }
    if (!remote) {
      return { disabledReason: "Missing git remote metadata." };
    }
    if (!projectUrl) {
      return { disabledReason: "Compare links require a GitHub remote." };
    }
    const range = encodeURIComponent(base) + "..." + encodeURIComponent(head);
    const compareUrl = projectUrl + "/compare/" + range;
    return {
      compareUrl,
      diffUrl: compareUrl + ".diff"
    };
  }

  function appendGitActionLinks(parent, detail) {
    const availability = gitActionAvailability(detail);
    const row = document.createElement("div");
    row.className = "git-action-row";
    if (availability.compareUrl && availability.diffUrl) {
      for (const [label, href] of [["Open diff", availability.diffUrl], ["Compare", availability.compareUrl]]) {
        const link = document.createElement("a");
        link.className = "git-action-link";
        link.setAttribute("target", "_blank");
        link.setAttribute("rel", "noreferrer");
        link.setAttribute("href", href);
        link.textContent = label;
        row.append(link);
      }
      parent.append(row);
      return;
    }
    const reason = availability.disabledReason || "Compare metadata is incomplete.";
    for (const label of ["Open diff", "Compare"]) {
      const disabled = document.createElement("span");
      disabled.className = "git-action-disabled";
      disabled.setAttribute("aria-disabled", "true");
      disabled.setAttribute("title", reason);
      disabled.textContent = label;
      row.append(disabled);
    }
    parent.append(row);
    appendMetaLine(parent, "compare disabled", reason);
  }

  function appendGitDiffStat(parent, stat) {
    if (!stat) {
      const empty = document.createElement("p");
      empty.className = "meta";
      empty.textContent = "No diffstat totals recorded.";
      parent.append(empty);
      return;
    }
    const additions = additionsValue(stat);
    const grid = document.createElement("div");
    grid.className = "detail-grid";
    appendMetaLine(parent, "diffstat", stat.filesChanged + " files, +" + additions + " / -" + stat.deletions);
    appendMetaLine(grid, "files", stat.filesChanged);
    appendMetaLine(grid, "insertions", additions);
    appendMetaLine(grid, "deletions", stat.deletions);
    appendMetaLine(grid, "total", stat.totalChanges);
    appendMetaLine(grid, "binary", stat.binaryFiles);
    parent.append(grid);
  }

  function appendChangedFiles(parent, files, truncated) {
    if (!files?.length) {
      const empty = document.createElement("p");
      empty.className = "meta";
      empty.textContent = "No changed files recorded for this node.";
      parent.append(empty);
      return;
    }
    const summaryRows = files.map((file) => {
      const oldPath = file.oldPath ? " from " + file.oldPath : "";
      const type = file.changeType ? " [" + file.changeType + "]" : "";
      return file.path + oldPath + type + " +" + formatCount(additionsValue(file)) + " / -" + formatCount(file.deletions);
    });
    if (truncated > 0) {
      summaryRows.push("+" + truncated + " more files");
    }
    appendMetaLine(parent, "changed files", summaryRows.join("\\n"));
    const wrap = document.createElement("div");
    wrap.className = "git-file-table-wrap";
    const table = document.createElement("table");
    table.className = "git-file-table";
    table.setAttribute("aria-label", "Changed files");
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const label of ["Path", "Ins", "Del"]) {
      const th = document.createElement("th");
      th.setAttribute("scope", "col");
      th.textContent = label;
      headRow.append(th);
    }
    thead.append(headRow);
    const tbody = document.createElement("tbody");
    for (const file of files) {
      const additions = additionsValue(file);
      const path = file.oldPath && file.oldPath !== file.path ? file.oldPath + " -> " + file.path : file.path;
      const changeType = file.changeType || (file.binary ? "binary" : "");
      const row = document.createElement("tr");
      const pathCell = document.createElement("td");
      pathCell.className = "git-file-path";
      pathCell.append(path);
      if (changeType) {
        const type = document.createElement("div");
        type.className = "meta";
        type.textContent = changeType;
        pathCell.append(type);
      }
      const insertionsCell = document.createElement("td");
      insertionsCell.className = "number";
      insertionsCell.textContent = formatCount(additions);
      const deletionsCell = document.createElement("td");
      deletionsCell.className = "number";
      deletionsCell.textContent = formatCount(file.deletions);
      row.append(pathCell, insertionsCell, deletionsCell);
      tbody.append(row);
    }
    table.append(thead, tbody);
    wrap.append(table);
    parent.append(wrap);
  }

  function appendGitInspectorSection(parent, detail) {
    const refs = detail?.refs || {};
    const footprint = detail?.gitFootprint || refs.gitFootprint || {};
    const git = detail?.git || {};
    const section = document.createElement("section");
    section.className = "inspector-section";
    section.setAttribute("aria-label", "Git inspector");

    for (const label of ["Git Footprint", "Git Refs"]) {
      const heading = document.createElement("h3");
      heading.textContent = label;
      section.append(heading);
    }

    const hasGitMetadata = git.commit || git.branch || git.baseRef || git.workRef || git.outputRef || git.integrationRef || git.headRef
      || refs.baseRef || refs.workRef || refs.outputRef || refs.integrationRef || detail?.baseRef || detail?.workRef || detail?.outputRef || detail?.integrationRef
      || footprint.commit || footprint.branch || footprint.baseRef || footprint.headRef || git.source || footprint.source || git.remoteDisplay || git.workspaceDisplay;
    if (hasGitMetadata) {
      appendMetaLine(section, "commit", git.commit || footprint.commit);
      appendMetaLine(section, "branch", git.branch || footprint.branch);
      appendMetaLine(section, "base", refLabel(git.baseRef || footprint.baseRef || refs.baseRef || detail?.baseRef));
      appendMetaLine(section, "work", refLabel(git.workRef || refs.workRef || detail?.workRef));
      appendMetaLine(section, "head", refLabel(git.headRef || git.outputRef || footprint.headRef || refs.outputRef || refs.integrationRef || detail?.outputRef || detail?.integrationRef));
      appendMetaLine(section, "output", refLabel(git.outputRef || refs.outputRef || detail?.outputRef));
      appendMetaLine(section, "integration", git.integrationRef?.name || refs.integrationRef?.name || detail?.integrationRef?.name);
      appendMetaLine(section, "source", git.source || footprint.source);
      appendMetaLine(section, "collected", git.collectedAt || footprint.collectedAt || detail?.outputRef?.collectedAt);
      appendMetaLine(section, "remote", git.remoteDisplay);
      appendMetaLine(section, "workspace", git.workspaceDisplay);
    } else {
      const empty = document.createElement("p");
      empty.className = "meta";
      empty.textContent = "No git refs recorded for this node.";
      section.append(empty);
    }

    appendGitActionLinks(section, detail || {});

    const diffHeading = document.createElement("h3");
    diffHeading.textContent = "Diffstat";
    section.append(diffHeading);
    appendGitDiffStat(section, git.diffStat || detail?.gitDiffStat || footprint.diffStat || detail?.outputRef?.diffStat);

    const filesHeading = document.createElement("h3");
    filesHeading.textContent = "Changed Files";
    section.append(filesHeading);
    appendChangedFiles(section, git.changedFiles || detail?.changedFiles || footprint.files || detail?.outputRef?.files || [], git.changedFilesTruncated || 0);

    parent.append(section);
  }

  function appendPlannerPreviewSection(parent, node) {
    const section = document.createElement("section");
    section.className = "inspector-section";
    const heading = document.createElement("h3");
    heading.textContent = "Planner Preview";
    section.append(heading);

    const preview = node.pendingPlannerPreview;
    if (!preview) {
      const empty = document.createElement("p");
      empty.className = "meta";
      empty.textContent = "No pending planner preview.";
      section.append(empty);
      parent.append(section);
      return;
    }

    appendMetaLine(section, "request", preview.requestId);
    appendMetaLine(section, "kind", preview.decompose?.kind || preview.proposedKind);
    appendMetaLine(section, "freshness", clientPreviewFreshnessReason(node) || "fresh");
    const children = Array.isArray(preview.decompose?.children) ? preview.decompose.children : [];
    if (children.length) {
      const list = document.createElement("ul");
      list.className = "planner-preview-list";
      for (const child of children) {
        const item = document.createElement("li");
        item.className = "meta";
        item.textContent = child.id + ": " + (child.title || child.id);
        list.append(item);
      }
      section.append(list);
    }
    parent.append(section);
  }

  function renderFilterSummary(visibleReady, visibleWorking, visibleWorkers) {
    const query = filters.query ? ' / search "' + filters.query + '"' : "";
    const message = "Showing " + visibleReady.length + " ready, " + visibleWorking.length + " active, " + visibleWorkers.length + " workers" + query + ".";
    document.getElementById("graph-filter-summary").textContent = message;
    announce(message);
  }

  function renderSelectedNode() {
    const details = document.getElementById("selected-node-details");
    const summary = document.getElementById("selected-worker-summary");
    const entry = selectedEntry();
    const detail = selectedDetail();
    if (!entry && !detail) {
      details.textContent = "";
      const empty = document.createElement("p");
      empty.textContent = "Select a node to inspect it.";
      details.append(empty);
      summary.textContent = "No node selected.";
      document.getElementById("start-selected-worker").disabled = true;
      return;
    }
    const id = detail?.id || entry?.id;
    const node = detail || entry?.node;
    if (!id || !node) {
      return;
    }
    const ready = nodeIsReady(id);
    document.getElementById("start-selected-worker").disabled = !ready;
    summary.textContent = ready ? "Selected: " + id + " is ready." : "Selected: " + id + " is " + (node.status || "pending") + ".";
    const children = Array.isArray(node.children) ? node.children.join(", ") : "";
    const previewReason = clientPreviewFreshnessReason(node);
    const actionControls = [
      { action: "claim-selected", policy: "claim", label: "Claim Selected" },
      { action: "start", policy: "start", label: "Start" },
      { action: "block", policy: "block", label: "Block" },
      { action: "reset", policy: "reset", label: "Reset" },
      { action: "decompose", policy: "decompose", label: "Split Series" },
      { action: "split-parallel", policy: "decompose", label: "Split Parallel" },
      ...(node.pendingPlannerPreview ? [
        { action: "planner-preview", policy: "apply-preview", label: "Planner Preview", ignoreDisabled: true },
        { action: "apply-preview", policy: "apply-preview", label: "Apply Preview" },
        { action: "reject-preview", policy: "reject-preview", label: "Reject Preview" }
      ] : []),
      { action: "regenerate-preview", policy: "regenerate-preview", label: "Regenerate" }
    ];
    const history = (node.history || []).slice().reverse().map((event) => event.event || "event").join(", ");
    details.textContent = "";

    const badgeWrap = document.createElement("div");
    const badge = document.createElement("span");
    badge.className = "badge status-" + statusToken(node.status || "pending");
    badge.textContent = node.status || "pending";
    badgeWrap.append(badge);
    details.append(badgeWrap);

    const heading = document.createElement("p");
    const strong = document.createElement("strong");
    strong.textContent = id;
    heading.append(strong, document.createElement("br"), node.title || id);
    details.append(heading);

    const actionWrap = document.createElement("div");
    actionWrap.className = "selected-actions";
    actionWrap.setAttribute("aria-label", "Selected node actions");
    for (const control of actionControls) {
      const policy = nodeAction(node, control.policy);
      let disabledReason = control.ignoreDisabled ? "" : (previewReason && (control.policy === "apply-preview" || control.policy === "decompose") ? previewReason : actionableDisabledReason(policy, node));
      const previewKind = node.pendingPlannerPreview?.decompose?.kind || node.pendingPlannerPreview?.proposedKind;
      if (!disabledReason && control.policy === "decompose" && previewKind) {
        const requestedKind = control.action === "split-parallel" ? "parallel" : "series";
        disabledReason = requestedKind === previewKind ? "" : "Pending planner preview proposed " + previewKind + "; reject or regenerate before using a different split.";
      }
      const button = document.createElement("button");
      button.className = "secondary";
      button.type = "button";
      button.dataset.nodeAction = control.action;
      button.textContent = control.label;
      if (disabledReason) {
        button.disabled = true;
        button.title = disabledReason;
        button.setAttribute("aria-label", control.label + ": " + disabledReason);
      }
      actionWrap.append(button);
    }
    details.append(actionWrap);

    appendPlannerPreviewSection(details, node);

    appendMetaLine(details, "kind", node.kind || "task");
    appendMetaLine(details, "goal", detailGoalText(node));
    appendMetaLine(details, "decision", plannerDecisionText(node));
    appendMetaLine(details, "decomposition reason", decompositionReasonText(node));
    appendMetaLine(details, "pending planner preview", plannerPreviewText(node));
    appendMetaLine(details, "context", formatContextRefs(node.contextRefs));
    appendMetaLine(details, "output contract", formatOutputContract(node.outputContract));
    appendMetaLine(details, "result", formatResultSummary(node.resultSummary));
    appendMetaLine(details, "children", children);
    appendMetaLine(details, "session", node.lease?.session || node.session);
    appendMetaLine(details, "run", node.lease?.runId || node.runId);
    appendMetaLine(details, "question", node.question);
    appendMetaLine(details, "answer", node.answer);
    appendGitInspectorSection(details, detail || node);

    const section = document.createElement("section");
    section.className = "inspector-section";
    const historyHeading = document.createElement("h3");
    historyHeading.textContent = "History";
    const historyBody = document.createElement("p");
    historyBody.textContent = history || "No history recorded for this node.";
    const historyHint = document.createElement("p");
    historyHint.className = "meta";
    historyHint.textContent = "Newest first from the events payload.";
    section.append(historyHeading, historyBody, historyHint);
    details.append(section);
  }

  function appendMetaLine(parent, label, value) {
    if (value === undefined || value === null || value === "") {
      return;
    }
    const line = document.createElement("div");
    line.className = "meta";
    line.textContent = label + ": " + boundedText(value);
    parent.append(line);
  }

  function payloadEvents() {
    return graphNodeEntries()
      .flatMap(({ id, node }) => (node.history || []).map((entry, index) => ({ ...entry, nodeId: id, historyIndex: index })))
      .sort((left, right) => String(right.at || "").localeCompare(String(left.at || "")) || right.nodeId.localeCompare(left.nodeId));
  }

  function renderDiagnosticsAndEvents(payload) {
    const working = payload.working || [];
    const blocked = working.filter((node) => isAttentionStatus(node.status));
    const failed = graphNodeEntries(payload).filter(({ node }) => node.status === "failed").map(({ id, node }) => ({ id, ...node }));
    const attentionItems = [...blocked, ...failed];
    document.getElementById("attention-dashboard").innerHTML = attentionItems.length
      ? attentionItems.map((node) => '<div class="working-item status-' + statusToken(node.status) + '"><strong>' + escapeHtml(node.id) + '</strong><br>' + escapeHtml(node.title || node.id) + metaLine("detail", node.question || node.failureReason || node.blockedReason || node.report) + '</div>').join("")
      : '<p>No blocked or failed nodes need attention.</p>';

    document.getElementById("diagnostics-panel").innerHTML =
      '<div class="detail-grid">' +
      metaLine("next ready", (payload.ready || []).map((node) => node.id).join(", ") || "none") +
      metaLine("recommended actions", blocked.length || failed.length ? "Answer blocked work, inspect failed reports, or reset verified retry nodes." : "Claim ready work or wait for active workers.") +
      '</div>';

    const events = payloadEvents();
    const names = [...new Set(events.map((event) => event.event).filter(Boolean))].sort();
    const select = document.getElementById("event-name-filter");
    const selected = select.value;
    select.innerHTML = '<option value="">Any event</option>' + names.map((name) => '<option value="' + escapeHtml(name) + '"' + (name === selected ? " selected" : "") + '>' + escapeHtml(name) + '</option>').join("");
    const visibleEvents = events
      .filter((event) => !eventFilters.node || event.nodeId.toLowerCase().includes(eventFilters.node))
      .filter((event) => !eventFilters.event || event.event === eventFilters.event)
      .slice(0, 30);
    document.getElementById("events-list").innerHTML = visibleEvents.length
      ? visibleEvents.map((event) => '<div class="ready-item"><strong>' + escapeHtml(event.nodeId) + '</strong><br>' + escapeHtml(event.event || "event") + metaLine("at", event.at) + '</div>').join("")
      : '<p>No events match the current filters.</p>';
  }

  function routeErrorMessage(prefix, error) {
    return prefix + ": " + boundedText(error?.message || String(error));
  }

  function showRouteError(prefix, error) {
    const message = routeErrorMessage(prefix, error);
    document.getElementById("subtitle").textContent = message;
    announce(message);
  }

  function renderGoalPlannerResult(result) {
    const container = document.getElementById("goal-planner-result");
    if (!result) {
      container.textContent = "No goal preview generated.";
      return;
    }
    const root = result.graph?.graph?.root || result.rootId || "unknown";
    const rootNode = result.graph?.graph?.nodes?.[root] || {};
    const children = Array.isArray(rootNode.children) ? rootNode.children.join(", ") : "";
    container.innerHTML =
      '<strong>' + escapeHtml(result.written ? "Created graph" : "Preview graph") + '</strong>' +
      metaLine("path", result.graphPath) +
      metaLine("root", root) +
      metaLine("nodes", result.nodeCount ?? result.summary?.totalNodes) +
      metaLine("title", result.graph?.title) +
      metaLine("children", children || "none");
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
    renderSelectedNode();
    renderDiagnosticsAndEvents(payload);
  }

  async function load() {
    const response = await fetch("/api/graph");
    render(await response.json());
  }

  function ownerFields(node) {
    return [
      { name: "session", label: "Session", value: node.lease?.session || node.session || "" },
      { name: "runId", label: "Run Id", value: node.lease?.runId || node.runId || "" }
    ];
  }

  function runSelectedAction(action) {
    const entry = selectedEntry();
    if (!entry) {
      return;
    }
    const { id, node } = entry;
    if (action === "claim-selected") {
      openActionModal({
        title: "Claim " + id,
        submitLabel: "Claim",
        fields: [
          { name: "session", label: "Session", required: true },
          { name: "leaseSeconds", label: "Lease Seconds", type: "number", value: "1800" }
        ],
        onSubmit: (values) => apiPost("/api/claim", { nodeId: id, session: values.session, leaseSeconds: Number(values.leaseSeconds || 1800) })
      });
      return;
    }
    if (action === "start") {
      openActionModal({
        title: "Start " + id,
        submitLabel: "Start",
        fields: ownerFields(node),
        onSubmit: (values) => apiPost("/api/start", { nodeId: id, session: values.session, runId: values.runId })
      });
      return;
    }
    if (action === "block") {
      openActionModal({
        title: "Block " + id,
        submitLabel: "Block",
        fields: [
          { name: "question", label: "Question", type: "textarea", value: node.question || "" },
          { name: "reason", label: "Reason", type: "textarea", value: node.blockedReason || "" },
          ...ownerFields(node)
        ],
        onSubmit: (values) => apiPost("/api/block", { nodeId: id, question: values.question, reason: values.reason, session: values.session, runId: values.runId })
      });
      return;
    }
    if (action === "reset") {
      openActionModal({
        title: "Reset " + id,
        submitLabel: "Reset",
        fields: [{ name: "reason", label: "Reason", type: "textarea", value: "manual_reset", required: true }],
        onSubmit: (values) => apiPost("/api/reset", { nodeId: id, reason: values.reason })
      });
      return;
    }
    if (action === "apply-preview") {
      openActionModal({
        title: "Apply Preview " + id,
        submitLabel: "Apply Preview",
        fields: ownerFields(node),
        onSubmit: (values) => apiPost("/api/apply-preview", { nodeId: id, session: values.session, runId: values.runId })
      });
      return;
    }
    if (action === "planner-preview") {
      openPlannerPreviewModal(entry);
      return;
    }
    if (action === "reject-preview") {
      openActionModal({
        title: "Reject Preview " + id,
        submitLabel: "Reject Preview",
        fields: [
          { name: "reason", label: "Reason", type: "textarea", value: "operator_rejected_preview" },
          { name: "responder", label: "Responder", value: "visualizer" }
        ],
        onSubmit: (values) => apiPost("/api/reject-preview", { nodeId: id, reason: values.reason, responder: values.responder })
      });
      return;
    }
    if (action === "regenerate-preview") {
      openActionModal({
        title: "Regenerate Preview " + id,
        submitLabel: "Regenerate",
        fields: [
          ...ownerFields(node),
          { name: "requestId", label: "Request Id", value: "" },
          { name: "plannerFixturePath", label: "Planner Fixture", value: "" },
          { name: "report", label: "Report", value: node.pendingPlannerPreview?.report || node.report || "" }
        ],
        onSubmit: (values) => apiPost("/api/regenerate-preview", {
          nodeId: id,
          session: values.session,
          runId: values.runId,
          requestId: values.requestId || undefined,
          plannerFixturePath: values.plannerFixturePath || undefined,
          report: values.report || undefined
        })
      });
      return;
    }
    if (action === "decompose") {
      openDecomposeModal(entry, "series");
      return;
    }
    if (action === "split-parallel") {
      openDecomposeModal(entry, "parallel");
    }
  }

  function openPlannerPreviewModal(entry) {
    const root = document.getElementById("modal-root");
    const preview = entry.node.pendingPlannerPreview;
    root.innerHTML = '<div class="modal-backdrop"><section class="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="planner-preview-modal-title">' +
      '<h2 id="planner-preview-modal-title">Planner Preview ' + escapeHtml(entry.id) + '</h2>' +
      '<pre class="decompose-preview">' + escapeHtml(JSON.stringify(preview || null, null, 2)) + '</pre>' +
      '<div class="button-row"><button class="secondary" type="button" data-modal-cancel>Close</button></div>' +
      '</section></div>';
    root.querySelector("[data-modal-cancel]").addEventListener("click", closeModal);
    root.querySelector("[data-modal-cancel]").focus();
  }

  function decomposeRowHtml(child, index) {
    const idBase = "decompose-child-" + index;
    const { id: _id, title: _title, metadata, kind: _kind, status: _status, ...childMetadata } = child || {};
    const metadataText = metadata || (Object.keys(childMetadata).length ? JSON.stringify(childMetadata, null, 2) : "");
    return '<div class="decompose-child-row" data-decompose-row>' +
      '<div class="button-row"><button class="secondary" type="button" data-decompose-move="up">Up</button><button class="danger" type="button" data-decompose-remove>Remove</button></div>' +
      '<div class="field-row"><div class="field"><label for="' + idBase + '-id">Id</label><input id="' + idBase + '-id" name="childId" value="' + escapeHtml(child.id) + '"></div>' +
      '<div class="field"><label for="' + idBase + '-title">Title</label><input id="' + idBase + '-title" name="childTitle" value="' + escapeHtml(child.title || "") + '"></div></div>' +
      '<div class="field"><label for="' + idBase + '-metadata">Metadata JSON</label><textarea id="' + idBase + '-metadata" name="childMetadata">' + escapeHtml(metadataText) + '</textarea></div>' +
      '</div>';
  }

  function nextChildId(parentId, form) {
    const used = new Set(graphNodeEntries().map((entry) => entry.id));
    form?.querySelectorAll('[name="childId"]').forEach((input) => used.add(input.value.trim()));
    for (const suffix of "abcdefghijklmnopqrstuvwxyz") {
      const candidate = parentId + suffix;
      if (!used.has(candidate)) {
        return candidate;
      }
    }
    return parentId + "_child";
  }

  function buildDecomposePayload(form, nodeId) {
    const seen = new Set();
    const children = [...form.querySelectorAll("[data-decompose-row]")].map((row, index) => {
      const id = row.querySelector('[name="childId"]').value.trim();
      const title = row.querySelector('[name="childTitle"]').value.trim();
      if (!id) {
        throw new Error("Child #" + (index + 1) + " id cannot be empty.");
      }
      if (!title) {
        throw new Error("Child #" + (index + 1) + " title cannot be empty.");
      }
      if (seen.has(id)) {
        throw new Error("Duplicate child id: " + id);
      }
      seen.add(id);
      const metadataText = row.querySelector('[name="childMetadata"]').value.trim();
      const metadata = metadataText ? JSON.parse(metadataText) : {};
      return { ...metadata, id, title, kind: "task", status: "pending" };
    });
    return {
      nodeId,
      kind: form.querySelector('[name="kind"]').value || "series",
      session: form.querySelector('[name="session"]').value.trim(),
      runId: form.querySelector('[name="runId"]').value.trim(),
      children
    };
  }

  function refreshDecomposePreview(form, nodeId) {
    try {
      form.querySelector("[data-decompose-preview]").textContent = JSON.stringify(buildDecomposePayload(form, nodeId), null, 2);
      form.querySelector("[data-modal-error]").textContent = "";
    } catch (error) {
      form.querySelector("[data-decompose-preview]").textContent = error?.message || String(error);
    }
  }

  function openDecomposeModal(entry, forcedKind) {
    const root = document.getElementById("modal-root");
    const node = entry.node;
    const preview = node.pendingPlannerPreview?.decompose;
    const initialKind = forcedKind || preview?.kind || "series";
    const initialChildren = Array.isArray(preview?.children) && preview.children.length
      ? preview.children
      : [{ id: nextChildId(entry.id), title: "" }];
    root.innerHTML = '<div class="modal-backdrop"><section class="modal-dialog" role="dialog" aria-modal="true">' +
      '<h2>Decompose ' + escapeHtml(entry.id) + '</h2>' +
      '<form class="decompose-form" data-decompose-form>' +
        '<div class="field-row"><div class="field"><label for="decompose-kind">Decomposition</label><select id="decompose-kind" name="kind"><option value="series"' + (initialKind === "series" ? " selected" : "") + '>series</option><option value="parallel"' + (initialKind === "parallel" ? " selected" : "") + '>parallel</option></select></div>' +
        '<div class="field"><label for="decompose-session">Session</label><input id="decompose-session" name="session" value="' + escapeHtml(node.lease?.session || node.session || "") + '"></div></div>' +
        '<div class="field"><label for="decompose-run">Run Id</label><input id="decompose-run" name="runId" value="' + escapeHtml(node.lease?.runId || node.runId || "") + '"></div>' +
        '<div class="button-row"><button class="secondary" type="button" data-decompose-add>Add Child</button></div>' +
        '<div class="decompose-children" data-decompose-children>' + initialChildren.map((child, index) => decomposeRowHtml(child, index)).join("") + '</div>' +
        '<div class="field"><label for="decompose-preview">Payload Preview</label><pre id="decompose-preview" class="decompose-preview" data-decompose-preview></pre></div>' +
        '<div data-modal-error></div>' +
        '<div class="button-row"><button class="secondary" type="button" data-modal-cancel>Cancel</button><button type="submit">Decompose</button></div>' +
      '</form></section></div>';
    const form = root.querySelector("[data-decompose-form]");
    const refresh = () => refreshDecomposePreview(form, entry.id);
    root.querySelector("[data-modal-cancel]").addEventListener("click", closeModal);
    form.addEventListener("input", refresh);
    form.addEventListener("change", refresh);
    form.addEventListener("click", (event) => {
      if (event.target.closest("[data-decompose-add]")) {
        const rows = form.querySelectorAll("[data-decompose-row]");
        form.querySelector("[data-decompose-children]").insertAdjacentHTML("beforeend", decomposeRowHtml({ id: nextChildId(entry.id, form), title: "" }, rows.length));
        refresh();
        return;
      }
      if (event.target.closest("[data-decompose-remove]") && form.querySelectorAll("[data-decompose-row]").length > 1) {
        event.target.closest("[data-decompose-row]").remove();
        refresh();
        return;
      }
      if (event.target.closest('[data-decompose-move="up"]')) {
        const row = event.target.closest("[data-decompose-row]");
        row?.parentElement?.insertBefore(row, row.previousElementSibling);
        refresh();
      }
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        await apiPost("/api/decompose", buildDecomposePayload(form, entry.id));
        closeModal();
      } catch (error) {
        form.querySelector("[data-modal-error]").textContent = error?.message || String(error);
      }
    });
    refresh();
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
      showRouteError("Answer failed", error);
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
      showRouteError("Worker start failed", error);
    } finally {
      button.disabled = false;
    }
  });

  document.getElementById("goal-planner-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const intent = event.submitter?.value || "preview";
    const error = document.getElementById("goal-planner-error");
    const buttons = form.querySelectorAll("button[type=submit]");
    const body = {
      goal: form.goal.value.trim(),
      title: form.title.value.trim() || undefined,
      plannerFixturePath: form.plannerFixturePath.value.trim() || undefined,
      dryRun: intent !== "create"
    };
    error.textContent = "";
    buttons.forEach((button) => { button.disabled = true; });
    try {
      const response = await fetch("/api/goal/plan", {
        method: "POST",
        headers: writeHeaders(true),
        body: JSON.stringify(body)
      });
      if (!response.ok) {
        throw new Error(await response.text());
      }
      const result = await response.json();
      renderGoalPlannerResult(result);
      if (result.written) {
        await load();
      }
    } catch (routeError) {
      error.textContent = routeError?.message || String(routeError);
      showRouteError("Goal planning failed", routeError);
    } finally {
      buttons.forEach((button) => { button.disabled = false; });
    }
  });

  document.getElementById("start-selected-worker").addEventListener("click", async (event) => {
    const ready = selectedNodeId && nodeIsReady(selectedNodeId);
    if (!ready) {
      return;
    }
    const form = document.getElementById("worker-manager-form");
    const isolation = form.isolation.value || "off";
    const remote = form.remote.value.trim();
    const basePrefix = form.sessionPrefix.value.trim() || "codex";
    const body = {
      count: 1,
      sessionPrefix: basePrefix + "-" + selectedNodeId,
      cwd: isolation === "git" ? undefined : form.cwd.value.trim(),
      codexCommand: form.codexCommand.value.trim() || "codex",
      codexArgs: form.codexArgs.value.split(/\\r?\\n/).map((line) => line.trim()).filter(Boolean),
      idleMs: Number(form.idleMs.value || 5000),
      quiet: form.quiet.checked,
      once: form.once.checked,
      isolation,
      remote: remote || undefined,
      workspaceRoot: form.workspaceRoot.value.trim() || undefined,
      workspaceRetention: form.workspaceRetention.value || "on-failure",
      nodeId: selectedNodeId
    };
    event.currentTarget.disabled = true;
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
      showRouteError("Worker start failed", error);
    } finally {
      event.currentTarget.disabled = false;
    }
  });

  document.addEventListener("click", async (event) => {
    const selectButton = event.target.closest("[data-select-node]");
    if (selectButton) {
      selectNode(selectButton.dataset.selectNode);
      return;
    }
    const actionButton = event.target.closest("[data-node-action]");
    if (actionButton) {
      runSelectedAction(actionButton.dataset.nodeAction);
      return;
    }
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

  document.getElementById("event-node-filter").addEventListener("input", (event) => {
    eventFilters.node = normalize(event.target.value).trim();
    if (latestPayload) {
      renderDiagnosticsAndEvents(latestPayload);
    }
  });

  document.getElementById("event-name-filter").addEventListener("change", (event) => {
    eventFilters.event = event.target.value;
    if (latestPayload) {
      renderDiagnosticsAndEvents(latestPayload);
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
