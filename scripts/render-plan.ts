#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isRecord } from "./contracts.js";
import type {
  PlanGraphFile,
  RendererCallout,
  RendererDocument,
  RendererSection,
  RendererTable
} from "./contracts.js";
import { printCliError } from "./cli-errors.js";
import { readGraph, writeTextFileAtomic } from "./graph-io.js";
import { runtimePathsFromModuleUrl } from "./runtime-paths.js";
import { classToken, escapeHtml } from "./shared-utils.js";
import { renderPlanarSvg } from "./sp-layout.js";

interface ParsedArgs {
  _: string[];
  graph?: string | boolean;
  output?: string | boolean;
  out?: string | boolean;
  [key: string]: string | boolean | string[] | undefined;
}

const { rootDir } = runtimePathsFromModuleUrl(import.meta.url);
let graph: PlanGraphFile;
let rendererDocument: RendererDocument;

export async function main(argv = process.argv.slice(2), env = process.env): Promise<void> {
  const args = parseArgs(argv);
  const inputPath = resolve(rootDir, stringArg(args.graph) || args._[0] || env.PLAN_GRAPH || "plan.graph.json");
  graph = await readGraph(inputPath);
  const documentModel = graph.document;
  const outputPath = resolve(
    dirname(inputPath),
    stringArg(args.output) || stringArg(args.out) || args._[1] || graph.scheduler?.htmlView || "plan.html"
  );

  if (!documentModel) {
    throw new Error("plan.graph.json is missing document content");
  }

  rendererDocument = documentModel;
  await writeTextFileAtomic(outputPath, renderHtml());
  console.log(`Rendered ${outputPath} from ${inputPath}`);
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { _: [] };
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

function stringArg(value: string | boolean | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function safeHref(value: unknown): string {
  const href = String(value ?? "")
    // eslint-disable-next-line no-control-regex -- Strip ASCII control characters from generated attributes.
    .replaceAll(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  // eslint-disable-next-line no-control-regex -- Strip ASCII control characters before URL scheme validation.
  const compact = href.replaceAll(/[\u0000-\u001f\u007f\s]/g, "");
  const scheme = compact.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/)?.[1]?.toLowerCase();
  if (!scheme || scheme === "http" || scheme === "https" || scheme === "mailto") {
    return href || "#";
  }
  return "#";
}

function renderRichText(value: unknown): string {
  return escapeHtml(value)
    .replaceAll("&lt;code&gt;", "<code>")
    .replaceAll("&lt;/code&gt;", "</code>");
}

function textOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function textOrFallback(value: unknown, fallback: string): string {
  const text = textOrEmpty(value).trim();
  return text || fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => textOrEmpty(item)) : [];
}

function planTitle(): string {
  return textOrFallback(graph.title, "Series-Parallel Plan");
}

function renderNav(nav: RendererDocument["nav"]): string {
  if (!Array.isArray(nav) || nav.length === 0) {
    return "";
  }

  const links = nav
    .filter(isRecord)
    .map((item) => {
      const label = textOrFallback(item.label, "Link");
      return `<a href="${escapeHtml(safeHref(item.href))}">${escapeHtml(label)}</a>`;
    })
    .join(" / ");
  if (!links) {
    return "";
  }
  return `  <p>${links}</p>\n`;
}

function renderMeta(meta: RendererDocument["meta"]): string {
  if (!Array.isArray(meta) || meta.length === 0) {
    return "";
  }

  const items = meta
    .filter(isRecord)
    .map((item) => `    <div>\n      <strong>${escapeHtml(textOrFallback(item.label, "Metadata"))}</strong>\n      ${escapeHtml(textOrEmpty(item.value))}\n    </div>`)
    .join("\n");
  if (!items) {
    return "";
  }
  return `  <div class="meta">\n${items}\n  </div>\n`;
}

function renderParagraphs(paragraphs: unknown): string {
  if (!Array.isArray(paragraphs)) {
    return "";
  }

  return paragraphs.map((paragraph) => `  <p>\n    ${escapeHtml(paragraph)}\n  </p>\n`).join("\n");
}

function renderTable(table: RendererTable | undefined, headingId: string): string {
  if (!isRecord(table)) {
    return "";
  }

  const rows = Array.isArray(table.rows) ? table.rows.filter(Array.isArray) : [];
  const providedColumns = stringArray(table.columns);
  const columnCount = Math.max(providedColumns.length, ...rows.map((row) => row.length), 0);
  if (columnCount === 0) {
    return "";
  }

  const heading = textOrFallback(table.heading, "Table");
  const columns = Array.from({ length: columnCount }, (_, index) => providedColumns[index] || `Column ${index + 1}`);
  const headers = columns.map((column) => `          <th scope="col">${escapeHtml(column)}</th>`).join("\n");
  const bodyRows = rows
    .map((row) => {
      const cells = Array.from({ length: columnCount }, (_, index) => `          <td>${renderRichText(row[index] ?? "")}</td>`).join("\n");
      return `        <tr>\n${cells}\n        </tr>`;
    })
    .join("\n");

  return `  <h2 id="${headingId}">${escapeHtml(heading)}</h2>
  <div class="table-viewport">
    <table aria-labelledby="${headingId}">
      <thead>
        <tr>
${headers}
        </tr>
      </thead>
      <tbody>
${bodyRows}
      </tbody>
    </table>
  </div>\n`;
}

function renderSection(section: RendererSection): string {
  if (!isRecord(section)) {
    return "";
  }
  const paragraphs = renderParagraphs(section.paragraphs);
  const flowText = textOrEmpty(section.flow);
  const flow = flowText ? `  <div class="flow">${escapeHtml(flowText)}</div>\n` : "";
  return `  <h2>${escapeHtml(textOrFallback(section.heading, "Section"))}</h2>\n${paragraphs}${flow}`;
}

function renderGraphFigure(): string {
  return `  <section class="graph-section" aria-labelledby="graph-heading">
    <h2 id="graph-heading">Planar Graph View</h2>
    <figure class="graph-figure" aria-labelledby="graph-heading graph-caption">
      <div class="graph-viewport" role="region" aria-label="Scrollable planar graph diagram" tabindex="0">
${renderPlanarSvg(graph)}
      </div>
      <figcaption id="graph-caption">Series-parallel dependency graph for ${escapeHtml(planTitle())}.</figcaption>
    </figure>
  </section>\n`;
}

function renderCallout(callout: RendererCallout): string {
  if (!isRecord(callout)) {
    return "";
  }
  const className = escapeHtml(classToken(callout.type, "callout"));
  const strongText = textOrEmpty(callout.strong);
  const strong = strongText ? `\n    <strong>${escapeHtml(strongText)}</strong>\n    ` : "";
  return `  <div class="${className}">${strong}${renderRichText(callout.bodyHtml)}\n  </div>\n`;
}

function renderBody(): string {
  const parts: string[] = [];
  parts.push(renderNav(rendererDocument.nav));
  parts.push(`  <h1>${escapeHtml(planTitle())}</h1>\n`);
  parts.push(renderMeta(rendererDocument.meta));
  parts.push(renderParagraphs(rendererDocument.intro));
  parts.push(renderGraphFigure());
  parts.push(renderTable(rendererDocument.notation, "notation-heading"));
  for (const section of Array.isArray(rendererDocument.sections) ? rendererDocument.sections : []) {
    parts.push(renderSection(section));
  }
  parts.push(renderTable(rendererDocument.gates, "gates-heading"));
  for (const callout of Array.isArray(rendererDocument.callouts) ? rendererDocument.callouts : []) {
    parts.push(renderCallout(callout));
  }
  return parts.join("\n");
}

function renderHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(textOrFallback(rendererDocument.pageTitle, planTitle()))}</title>
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
      font-size: 14px;
    }

    th, td {
      border: 1px solid var(--line);
      padding: 10px 12px;
      vertical-align: top;
      text-align: left;
      overflow-wrap: anywhere;
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

    .graph-figure {
      margin: 0;
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
      width: auto;
      max-width: none;
      height: auto;
      color: var(--ink);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    figcaption {
      margin-top: 8px;
      color: var(--muted);
      font-size: 13px;
    }

    .table-viewport {
      overflow-x: auto;
      margin: 18px 0 24px;
    }

    .table-viewport table {
      min-width: 100%;
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

      .sp-graph {
        min-width: 760px;
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
