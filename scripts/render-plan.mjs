#!/usr/bin/env node
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderPlanarSvg } from "./sp-layout.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, "..");
const args = parseArgs(process.argv.slice(2));
const inputPath = resolve(rootDir, args.graph || args._[0] || process.env.PLAN_GRAPH || "plan.graph.json");

const graph = JSON.parse(await readFile(inputPath, "utf8"));
const documentModel = graph.document;
const outputPath = resolve(dirname(inputPath), args.output || args.out || args._[1] || graph.scheduler?.htmlView || "plan.html");

if (!documentModel) {
  throw new Error("plan.graph.json is missing document content");
}

function parseArgs(argv) {
  const parsed = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      parsed._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderRichText(value) {
  return escapeHtml(value)
    .replaceAll("&lt;code&gt;", "<code>")
    .replaceAll("&lt;/code&gt;", "</code>");
}

function renderNav(nav) {
  if (!Array.isArray(nav) || nav.length === 0) {
    return "";
  }

  const links = nav
    .map((item) => `<a href="${escapeHtml(item.href)}">${escapeHtml(item.label)}</a>`)
    .join(" / ");
  return `  <p>${links}</p>\n`;
}

function renderMeta(meta) {
  if (!Array.isArray(meta) || meta.length === 0) {
    return "";
  }

  const items = meta
    .map((item) => `    <div>\n      <strong>${escapeHtml(item.label)}</strong>\n      ${escapeHtml(item.value)}\n    </div>`)
    .join("\n");
  return `  <div class="meta">\n${items}\n  </div>\n`;
}

function renderParagraphs(paragraphs) {
  if (!Array.isArray(paragraphs)) {
    return "";
  }

  return paragraphs.map((paragraph) => `  <p>\n    ${escapeHtml(paragraph)}\n  </p>\n`).join("\n");
}

function renderTable(table) {
  if (!table) {
    return "";
  }

  const headers = table.columns.map((column) => `        <th>${escapeHtml(column)}</th>`).join("\n");
  const rows = table.rows
    .map((row) => {
      const cells = row.map((cell) => `        <td>${renderRichText(cell)}</td>`).join("\n");
      return `      <tr>\n${cells}\n      </tr>`;
    })
    .join("\n");

  return `  <h2>${escapeHtml(table.heading)}</h2>\n  <table>\n    <thead>\n      <tr>\n${headers}\n      </tr>\n    </thead>\n    <tbody>\n${rows}\n    </tbody>\n  </table>\n`;
}

function renderSection(section) {
  const paragraphs = renderParagraphs(section.paragraphs);
  const flow = section.flow ? `  <div class="flow">${escapeHtml(section.flow)}</div>\n` : "";
  return `  <h2>${escapeHtml(section.heading)}</h2>\n${paragraphs}${flow}`;
}

function renderGraphFigure() {
  return `  <section class="graph-section" aria-labelledby="graph-heading">
    <h2 id="graph-heading">Planar Graph View</h2>
    <div class="graph-viewport">
${renderPlanarSvg(graph)}
    </div>
  </section>\n`;
}

function renderCallout(callout) {
  const className = escapeHtml(callout.type || "callout");
  const strong = callout.strong ? `\n    <strong>${escapeHtml(callout.strong)}</strong>\n    ` : "";
  return `  <div class="${className}">${strong}${renderRichText(callout.bodyHtml)}\n  </div>\n`;
}

function renderBody() {
  const parts = [];
  parts.push(renderNav(documentModel.nav));
  parts.push(`  <h1>${escapeHtml(graph.title)}</h1>\n`);
  parts.push(renderMeta(documentModel.meta));
  parts.push(renderParagraphs(documentModel.intro));
  parts.push(renderGraphFigure());
  parts.push(renderTable(documentModel.notation));
  for (const section of documentModel.sections || []) {
    parts.push(renderSection(section));
  }
  parts.push(renderTable(documentModel.gates));
  for (const callout of documentModel.callouts || []) {
    parts.push(renderCallout(callout));
  }
  return parts.join("\n");
}

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(documentModel.pageTitle || graph.title)}</title>
  <style>
    :root {
      --bg: #f7f8fa;
      --paper: #ffffff;
      --ink: #17202a;
      --muted: #586471;
      --line: #d8dee6;
      --accent: #0f6f68;
      --accent-2: #7b4d11;
      --soft: #eef7f6;
      --soft-2: #fff5e6;
      --code: #f0f3f6;
      --done: #137a46;
      --running: #075db3;
      --blocked: #a15c00;
      --failed: #a32121;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.55;
    }

    main {
      width: min(1120px, calc(100% - 40px));
      margin: 40px auto;
      background: var(--paper);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 44px;
      box-shadow: 0 12px 34px rgba(20, 30, 42, 0.08);
    }

    h1, h2, h3 {
      line-height: 1.2;
      margin: 0 0 14px;
    }

    h1 {
      font-size: 34px;
      letter-spacing: 0;
    }

    h2 {
      margin-top: 38px;
      padding-top: 24px;
      border-top: 1px solid var(--line);
      font-size: 24px;
    }

    h3 {
      margin-top: 24px;
      font-size: 18px;
      color: #1f3741;
    }

    p {
      margin: 0 0 14px;
    }

    ul, ol {
      margin: 0 0 18px 24px;
      padding: 0;
    }

    li {
      margin: 6px 0;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      margin: 18px 0 24px;
      font-size: 14px;
    }

    th, td {
      border: 1px solid var(--line);
      padding: 10px 12px;
      vertical-align: top;
      text-align: left;
    }

    th {
      background: #eef1f4;
      font-weight: 700;
    }

    code {
      background: var(--code);
      padding: 2px 5px;
      border-radius: 4px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 0.94em;
    }

    a {
      color: var(--accent);
      font-weight: 700;
    }

    .meta {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
      margin: 24px 0 30px;
    }

    .meta div,
    .callout {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 14px 16px;
      background: #fbfcfd;
    }

    .meta strong {
      display: block;
      font-size: 12px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
      margin-bottom: 4px;
    }

    .callout {
      border-left: 4px solid var(--accent);
      background: var(--soft);
      margin: 18px 0 24px;
    }

    .warning {
      border-left-color: var(--accent-2);
      background: var(--soft-2);
    }

    .flow {
      padding: 14px 16px;
      border: 1px dashed #9aa7b3;
      border-radius: 8px;
      background: #fbfcfd;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      white-space: pre-wrap;
      overflow-x: auto;
      margin: 16px 0 24px;
    }

    .graph-section {
      margin: 24px 0 30px;
    }

    .graph-section h2 {
      margin-top: 34px;
    }

    .graph-viewport {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fbfcfd;
      overflow: auto;
      padding: 12px;
    }

    .sp-graph {
      display: block;
      min-width: 1080px;
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

    @media (max-width: 760px) {
      main {
        width: calc(100% - 24px);
        margin: 12px auto;
        padding: 24px 18px;
      }

      .meta {
        grid-template-columns: 1fr;
      }

      table {
        display: block;
        overflow-x: auto;
      }
    }
  </style>
</head>
<body>
<main>
${renderBody()}</main>
</body>
</html>
`;

const tempOutputPath = `${outputPath}.${process.pid}.${Date.now()}.tmp`;
await writeFile(tempOutputPath, html, "utf8");
await rename(tempOutputPath, outputPath);
console.log(`Rendered ${outputPath} from ${inputPath}`);
