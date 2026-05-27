#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  schedulerTransitionTable,
  type SchedulerTransitionRule
} from "./node-mutations.js";

export const transitionReferenceStartMarker = "<!-- BEGIN GENERATED: scheduler-transition-table -->";
export const transitionReferenceEndMarker = "<!-- END GENERATED: scheduler-transition-table -->";

export type SchedulerTransitionTable = Record<string, SchedulerTransitionRule>;

export function renderSchedulerTransitionReference(
  table: SchedulerTransitionTable = schedulerTransitionTable
): string {
  const rows = Object.entries(table)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([command, rule]) => [
      code(command),
      rule.actor,
      markdownCell(rule.scope),
      allowedFromCell(rule),
      code(rule.to),
      markdownCell(rule.lease),
      code(rule.implementation)
    ]);

  const tableLines = [
    transitionReferenceStartMarker,
    "This section is generated from `schedulerTransitionTable` in `scripts/node-mutations.ts`.",
    "",
    "| Command | Actor | Scope | Allowed statuses | Target status | Lease requirement | Implementation |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map((row) => `| ${row.join(" | ")} |`),
    transitionReferenceEndMarker
  ];

  return `${tableLines.join("\n")}\n`;
}

export function replaceSchedulerTransitionReference(documentText: string): string {
  const start = documentText.indexOf(transitionReferenceStartMarker);
  const end = documentText.indexOf(transitionReferenceEndMarker);
  if (start === -1 || end === -1 || end < start) {
    throw new Error("Missing generated scheduler transition table markers");
  }

  const replacement = renderSchedulerTransitionReference().trimEnd();
  return `${documentText.slice(0, start)}${replacement}${documentText.slice(end + transitionReferenceEndMarker.length)}`;
}

export async function checkSchedulerTransitionReference(docsPath: string): Promise<void> {
  const current = await readFile(docsPath, "utf8");
  const expected = replaceSchedulerTransitionReference(current);
  if (current !== expected) {
    throw new Error(`Scheduler transition reference is stale: ${docsPath}`);
  }
}

export async function writeSchedulerTransitionReference(docsPath: string): Promise<void> {
  const current = await readFile(docsPath, "utf8");
  await writeFile(docsPath, replaceSchedulerTransitionReference(current));
}

function code(value: string): string {
  return `\`${value}\``;
}

function markdownCell(value: string): string {
  return value.replaceAll("|", "\\|");
}

function allowedFromCell(rule: SchedulerTransitionRule): string {
  const knownStatuses = rule.allowedFrom.map(code).join(", ");
  if (!rule.additionalAllowedFrom) {
    return knownStatuses;
  }
  return `${knownStatuses}; ${markdownCell(rule.additionalAllowedFrom)}`;
}

function defaultDocsPath(): string {
  return resolve(fileURLToPath(new URL("../..", import.meta.url)), "docs", "mutation-ownership.md");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const docsPath = args.find((arg) => !arg.startsWith("--")) || defaultDocsPath();

  if (args.includes("--write")) {
    await writeSchedulerTransitionReference(docsPath);
    return;
  }

  await checkSchedulerTransitionReference(docsPath);
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
