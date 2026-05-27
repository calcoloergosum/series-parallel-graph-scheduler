#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runtimePathsFromModuleUrl } from "./runtime-paths.js";

export interface ComplexityFileMetric {
  path: string;
  category: ComplexityCategory;
  lines: number;
  exports: number;
  testCases: number;
  lineStatus: GuardrailStatus;
  exportStatus: GuardrailStatus;
  testStatus: GuardrailStatus;
}

export interface ComplexityReport {
  files: ComplexityFileMetric[];
  largeFiles: ComplexityFileMetric[];
  exportHotSpots: ComplexityFileMetric[];
  testSuites: ComplexityFileMetric[];
  advisoryWarnings: string[];
  urgentFailures: string[];
  docsSnapshotCurrent: boolean;
}

type ComplexityCategory = "source" | "runtime-ui" | "test" | "helper";
type GuardrailStatus = "ok" | "review" | "split" | "urgent";

interface Thresholds {
  review: number;
  split: number;
  urgent: number;
}

const { rootDir } = runtimePathsFromModuleUrl(import.meta.url);
const docsPath = join(rootDir, "docs", "technical-debt.md");
const docsStartMarker = "<!-- complexity-guardrails:start -->";
const docsEndMarker = "<!-- complexity-guardrails:end -->";
const scannedDirs = ["scripts", "tests"];
const scannedExtensions = new Set([".mjs", ".ts"]);
const thresholdsByCategory: Record<ComplexityCategory, Thresholds> = {
  source: { review: 800, split: 1200, urgent: 2500 },
  "runtime-ui": { review: 1500, split: 2000, urgent: 2500 },
  test: { review: 2500, split: 4000, urgent: 5000 },
  helper: { review: 800, split: 1200, urgent: 2500 }
};
const exportThresholds: Thresholds = { review: 25, split: 75, urgent: 200 };
const testCaseThresholds: Thresholds = { review: 40, split: 80, urgent: 140 };

export async function buildComplexityReport(): Promise<ComplexityReport> {
  const files = await collectSourceFiles();
  const metrics = await Promise.all(files.map(measureFile));
  metrics.sort((left, right) => left.path.localeCompare(right.path));

  const largeFiles = metrics
    .filter((metric) => metric.lineStatus !== "ok")
    .sort(byLinesDescending);
  const exportHotSpots = metrics
    .filter((metric) => metric.exports > 0)
    .sort((left, right) => right.exports - left.exports || left.path.localeCompare(right.path))
    .slice(0, 10);
  const testSuites = metrics
    .filter((metric) => metric.category === "test")
    .sort(byLinesDescending);
  const advisoryWarnings = [
    ...largeFiles.filter((metric) => metric.lineStatus !== "urgent").map((metric) => warningFor(metric, "lines")),
    ...metrics.filter((metric) => metric.exportStatus !== "ok" && metric.exportStatus !== "urgent").map((metric) => warningFor(metric, "exports")),
    ...metrics.filter((metric) => metric.testStatus !== "ok" && metric.testStatus !== "urgent").map((metric) => warningFor(metric, "test cases"))
  ];
  const urgentFailures = [
    ...largeFiles.filter((metric) => metric.lineStatus === "urgent").map((metric) => warningFor(metric, "lines")),
    ...metrics.filter((metric) => metric.exportStatus === "urgent").map((metric) => warningFor(metric, "exports")),
    ...metrics.filter((metric) => metric.testStatus === "urgent").map((metric) => warningFor(metric, "test cases"))
  ];
  const docsSnapshotCurrent = await isDocsSnapshotCurrent(metrics);

  if (!docsSnapshotCurrent) {
    advisoryWarnings.push("docs/technical-debt.md measured hot spots are stale; run `npm run guardrails -- --update-docs`.");
  }

  return {
    files: metrics,
    largeFiles,
    exportHotSpots,
    testSuites,
    advisoryWarnings,
    urgentFailures,
    docsSnapshotCurrent
  };
}

export function renderComplexityReport(report: ComplexityReport): string {
  const lines = [
    "# Complexity Guardrails",
    "",
    "Guardrail output is advisory unless an urgent threshold is crossed.",
    "",
    "## Large Files",
    "",
    renderFileTable(report.largeFiles, "No files currently cross review line-count thresholds."),
    "",
    "## Exported Symbol Counts",
    "",
    renderFileTable(report.exportHotSpots, "No exported symbols found.", { includeOnlyExports: true }),
    "",
    "## Test Suite Sizes",
    "",
    renderFileTable(report.testSuites, "No test suites found.", { includeOnlyTests: true }),
    "",
    "## Thresholds",
    "",
    "| Area | Review | Split candidate | Urgent |",
    "|---|---:|---:|---:|",
    `| Source modules | ${thresholdsByCategory.source.review} lines | ${thresholdsByCategory.source.split} lines | ${thresholdsByCategory.source.urgent} lines |`,
    `| Runtime/UI modules | ${thresholdsByCategory["runtime-ui"].review} lines | ${thresholdsByCategory["runtime-ui"].split} lines | ${thresholdsByCategory["runtime-ui"].urgent} lines |`,
    `| Test files | ${thresholdsByCategory.test.review} lines | ${thresholdsByCategory.test.split} lines | ${thresholdsByCategory.test.urgent} lines |`,
    `| Exported symbols per module | ${exportThresholds.review} | ${exportThresholds.split} | ${exportThresholds.urgent} |`,
    `| Test cases per suite | ${testCaseThresholds.review} | ${testCaseThresholds.split} | ${testCaseThresholds.urgent} |`,
    "",
    "## Status",
    "",
    `Docs snapshot: ${report.docsSnapshotCurrent ? "current" : "stale"}`,
    `Advisory warnings: ${report.advisoryWarnings.length}`,
    `Urgent failures: ${report.urgentFailures.length}`
  ];

  if (report.advisoryWarnings.length > 0) {
    lines.push("", "### Advisory Warnings", "");
    for (const warning of report.advisoryWarnings) {
      lines.push(`- ${warning}`);
    }
  }

  if (report.urgentFailures.length > 0) {
    lines.push("", "### Urgent Failures", "");
    for (const failure of report.urgentFailures) {
      lines.push(`- ${failure}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export function renderTechnicalDebtSnapshot(metrics: ComplexityFileMetric[]): string {
  const hotSpots = metrics
    .filter((metric) => metric.lineStatus !== "ok" || metric.exports >= exportThresholds.review || metric.testStatus !== "ok")
    .sort((left, right) => {
      const statusDelta = statusRank(right) - statusRank(left);
      return statusDelta || right.lines - left.lines || left.path.localeCompare(right.path);
    });

  return [
    docsStartMarker,
    "### Measured Hot Spots",
    "",
    "Generated by `npm run guardrails`. Update this block with `npm run guardrails -- --update-docs` when measured hot spots change.",
    "",
    renderFileTable(hotSpots, "No measured hot spots currently cross review thresholds."),
    docsEndMarker
  ].join("\n");
}

export async function updateTechnicalDebtSnapshot(metrics: ComplexityFileMetric[]): Promise<void> {
  const current = await readFile(docsPath, "utf8");
  const next = replaceTechnicalDebtSnapshot(current, renderTechnicalDebtSnapshot(metrics));
  await writeFile(docsPath, next, "utf8");
}

export function replaceTechnicalDebtSnapshot(documentText: string, snapshot: string): string {
  const start = documentText.indexOf(docsStartMarker);
  const end = documentText.indexOf(docsEndMarker);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`Missing ${docsStartMarker} block in docs/technical-debt.md`);
  }
  return `${documentText.slice(0, start)}${snapshot}${documentText.slice(end + docsEndMarker.length)}`;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const updateDocs = argv.includes("--update-docs");
  const json = argv.includes("--json");
  const report = await buildComplexityReport();

  if (updateDocs) {
    await updateTechnicalDebtSnapshot(report.files);
    report.docsSnapshotCurrent = true;
    report.advisoryWarnings = report.advisoryWarnings.filter((warning) => !warning.startsWith("docs/technical-debt.md "));
  }

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderComplexityReport(report));
  }

  if (report.urgentFailures.length > 0) {
    process.exitCode = 1;
  }
}

async function collectSourceFiles(): Promise<string[]> {
  const files: string[] = [];
  for (const dir of scannedDirs) {
    await collectFiles(join(rootDir, dir), files);
  }
  return files.sort();
}

async function collectFiles(dir: string, files: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(path, files);
    } else if (entry.isFile() && scannedExtensions.has(extname(entry.name))) {
      files.push(path);
    }
  }
}

async function measureFile(file: string): Promise<ComplexityFileMetric> {
  const text = await readFile(file, "utf8");
  const relativePath = relative(rootDir, file).split(sep).join("/");
  const category = classifyFile(relativePath);
  const lines = countLines(text);
  const exports = countExportedSymbols(text);
  const testCases = countTestCases(text);

  return {
    path: relativePath,
    category,
    lines,
    exports,
    testCases,
    lineStatus: thresholdStatus(lines, thresholdsByCategory[category]),
    exportStatus: exports > 0 ? thresholdStatus(exports, exportThresholds) : "ok",
    testStatus: category === "test" ? thresholdStatus(testCases, testCaseThresholds) : "ok"
  };
}

function classifyFile(path: string): ComplexityCategory {
  if (path.startsWith("tests/helpers/")) {
    return "helper";
  }
  if (path.startsWith("tests/")) {
    return "test";
  }
  if (path.startsWith("scripts/visualizer") || path === "scripts/render-plan.ts") {
    return "runtime-ui";
  }
  return "source";
}

function countLines(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  return text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
}

function countExportedSymbols(text: string): number {
  const withoutComments = stripComments(text);
  const declarationMatches = withoutComments.matchAll(/^\s*export\s+(?:declare\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm);
  const declarations = [...declarationMatches].length;
  const defaultExports = [...withoutComments.matchAll(/^\s*export\s+default\s+/gm)].length;
  const namedExportBlocks = [...withoutComments.matchAll(/^\s*export\s+(?:type\s+)?\{([\s\S]*?)\}\s*(?:from\s+["'][^"']+["'])?\s*;/gm)]
    .reduce((count, match) => count + countNamedExportSpecifiers(match[1] ?? ""), 0);
  const destructuredExports = [...withoutComments.matchAll(/^\s*export\s+const\s+\{([\s\S]*?)\}\s*=/gm)]
    .reduce((count, match) => count + countNamedExportSpecifiers(match[1] ?? ""), 0);
  return declarations + defaultExports + namedExportBlocks + destructuredExports;
}

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function countNamedExportSpecifiers(block: string): number {
  return block
    .split(",")
    .map((specifier) => specifier.trim())
    .filter(Boolean)
    .length;
}

function countTestCases(text: string): number {
  return [...text.matchAll(/^\s*test(?:\.(?:skip|only|todo))?\s*\(/gm)].length;
}

function thresholdStatus(value: number, thresholds: Thresholds): GuardrailStatus {
  if (value >= thresholds.urgent) {
    return "urgent";
  }
  if (value >= thresholds.split) {
    return "split";
  }
  if (value >= thresholds.review) {
    return "review";
  }
  return "ok";
}

function warningFor(metric: ComplexityFileMetric, dimension: "lines" | "exports" | "test cases"): string {
  const value = dimension === "lines" ? metric.lines : dimension === "exports" ? metric.exports : metric.testCases;
  const status = dimension === "lines" ? metric.lineStatus : dimension === "exports" ? metric.exportStatus : metric.testStatus;
  return `${metric.path}: ${value} ${dimension} (${status})`;
}

function renderFileTable(
  metrics: ComplexityFileMetric[],
  emptyText: string,
  options: { includeOnlyExports?: boolean; includeOnlyTests?: boolean } = {}
): string {
  if (metrics.length === 0) {
    return emptyText;
  }

  const lines = [
    "| File | Category | Lines | Line status | Exports | Export status | Test cases | Test status |",
    "|---|---|---:|---|---:|---|---:|---|"
  ];
  for (const metric of metrics) {
    if (options.includeOnlyExports && metric.exports === 0) {
      continue;
    }
    if (options.includeOnlyTests && metric.category !== "test") {
      continue;
    }
    lines.push(`| \`${metric.path}\` | ${metric.category} | ${metric.lines} | ${metric.lineStatus} | ${metric.exports} | ${metric.exportStatus} | ${metric.testCases} | ${metric.testStatus} |`);
  }
  return lines.join("\n");
}

async function isDocsSnapshotCurrent(metrics: ComplexityFileMetric[]): Promise<boolean> {
  const current = await readFile(docsPath, "utf8");
  return current.includes(renderTechnicalDebtSnapshot(metrics));
}

function byLinesDescending(left: ComplexityFileMetric, right: ComplexityFileMetric): number {
  return right.lines - left.lines || left.path.localeCompare(right.path);
}

function statusRank(metric: ComplexityFileMetric): number {
  return Math.max(rankStatus(metric.lineStatus), rankStatus(metric.exportStatus), rankStatus(metric.testStatus));
}

function rankStatus(status: GuardrailStatus): number {
  return ["ok", "review", "split", "urgent"].indexOf(status);
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
    console.error(error);
    process.exitCode = 1;
  });
}
