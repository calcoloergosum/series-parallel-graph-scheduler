#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { knownNodeKinds, knownNodeStatuses } from "./contracts.js";
import { runtimePathsFromModuleUrl } from "./runtime-paths.js";

const timestampPattern = String.raw`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$`;

export function buildPlanGraphJsonSchema(): Record<string, unknown> {
  return {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://series-parallel-graph-scheduler.local/schemas/plan-graph.schema.json",
    title: "Series-Parallel Graph Scheduler Plan Graph",
    description: "Editor schema for scheduler graph files. Runtime-only graph invariants are listed under x-spg-validatorInvariants.",
    type: "object",
    required: ["graph"],
    additionalProperties: true,
    properties: {
      "$schema": { type: "string" },
      graphVersion: { type: "number" },
      title: { type: "string" },
      description: { type: "string" },
      statusModel: {
        type: "array",
        items: { type: "string" }
      },
      scheduler: { "$ref": "#/$defs/schedulerConfig" },
      document: { type: "object", additionalProperties: true },
      graph: { "$ref": "#/$defs/graphBody" }
    },
    "$defs": {
      graphBody: {
        type: "object",
        required: ["root", "nodes"],
        additionalProperties: true,
        properties: {
          root: { type: "string", minLength: 1 },
          nodes: {
            type: "object",
            additionalProperties: { "$ref": "#/$defs/node" }
          }
        }
      },
      schedulerConfig: {
        type: "object",
        additionalProperties: true,
        properties: {
          stateFile: { type: "string" },
          htmlView: { type: "string" },
          reportsDir: { type: "string" },
          leaseSeconds: { type: "number" },
          remote: { type: "string" }
        }
      },
      node: {
        type: "object",
        additionalProperties: true,
        properties: {
          title: { type: "string" },
          kind: {
            type: "string",
            "x-spg-knownValues": knownNodeKinds
          },
          status: {
            type: "string",
            "x-spg-knownValues": knownNodeStatuses
          },
          children: {
            type: "array",
            uniqueItems: true,
            items: { type: "string" }
          },
          description: { type: "string" },
          deliverables: {
            type: "array",
            items: { type: "string" }
          },
          acceptanceCriteria: {
            type: "array",
            items: { type: "string" }
          },
          goal: {
            oneOf: [
              { type: "string" },
              { "$ref": "#/$defs/goalMetadata" }
            ]
          },
          planner: { "$ref": "#/$defs/plannerMetadata" },
          contextRefs: {
            type: "array",
            items: { "$ref": "#/$defs/contextRef" }
          },
          resultSummary: { "$ref": "#/$defs/resultSummary" },
          outputContract: { "$ref": "#/$defs/outputContract" },
          lease: { "$ref": "#/$defs/lease" },
          history: {
            type: "array",
            items: { "$ref": "#/$defs/historyEntry" }
          },
          startedAt: { "$ref": "#/$defs/timestamp" },
          completedAt: { "$ref": "#/$defs/timestamp" },
          blockedAt: { "$ref": "#/$defs/timestamp" },
          blockedReason: { type: "string" },
          question: { type: "string" },
          answer: { type: "string" },
          answeredAt: { "$ref": "#/$defs/timestamp" },
          answeredBy: { type: "string" },
          failedAt: { "$ref": "#/$defs/timestamp" },
          failureReason: { type: "string" },
          expiredAt: { "$ref": "#/$defs/timestamp" },
          report: { type: "string" },
          baseRef: { "$ref": "#/$defs/namedRef" },
          workRef: { "$ref": "#/$defs/namedRef" },
          outputRef: { "$ref": "#/$defs/namedRef" },
          integrationRef: { "$ref": "#/$defs/integrationRef" },
          gitFootprint: { "$ref": "#/$defs/gitFootprint" },
          gitFootprintWarning: { type: "string" },
          workspace: { "$ref": "#/$defs/workspace" }
        },
        allOf: [
          {
            if: {
              properties: { kind: { const: "series" } },
              required: ["kind"]
            },
            then: {
              required: ["children"],
              properties: {
                children: { minItems: 1 }
              }
            }
          },
          {
            if: {
              properties: { kind: { const: "parallel" } },
              required: ["kind"]
            },
            then: {
              required: ["children"],
              properties: {
                children: { minItems: 1 }
              }
            }
          }
        ],
        examples: [
          {
            title: "Implement task",
            kind: "task",
            status: "pending"
          },
          {
            title: "Ordered phase",
            kind: "series",
            status: "pending",
            children: ["FIRST_TASK", "SECOND_TASK"]
          },
          {
            title: "Independent branches",
            kind: "parallel",
            status: "pending",
            children: ["WEB_BRANCH", "API_BRANCH"]
          },
          {
            title: "Integration checkpoint",
            kind: "gate",
            status: "pending"
          }
        ]
      },
      lease: {
        type: "object",
        required: ["session", "runId", "claimedAt", "expiresAt"],
        additionalProperties: true,
        properties: {
          session: { type: "string", minLength: 1 },
          runId: { type: "string", minLength: 1 },
          claimedAt: { "$ref": "#/$defs/timestamp" },
          expiresAt: { "$ref": "#/$defs/timestamp" },
          renewedAt: { "$ref": "#/$defs/timestamp" }
        }
      },
      historyEntry: {
        type: "object",
        required: ["at"],
        additionalProperties: true,
        properties: {
          at: { "$ref": "#/$defs/timestamp" },
          event: { type: "string" }
        }
      },
      timestamp: {
        type: "string",
        format: "date-time",
        pattern: timestampPattern
      },
      namedRef: {
        type: "object",
        required: ["name"],
        additionalProperties: true,
        properties: {
          name: { type: "string" },
          commit: { type: "string" },
          source: { type: "string" },
          runId: { type: "string" },
          session: { type: "string" },
          report: { type: "string" },
          resolvedAt: { "$ref": "#/$defs/timestamp" },
          createdAt: { "$ref": "#/$defs/timestamp" },
          producedAt: { "$ref": "#/$defs/timestamp" },
          diffStat: { "$ref": "#/$defs/gitDiffStat" },
          files: {
            type: "array",
            items: { "$ref": "#/$defs/gitFileFootprint" }
          },
          collectedAt: { "$ref": "#/$defs/timestamp" }
        }
      },
      gitFootprint: {
        type: "object",
        additionalProperties: true,
        properties: {
          baseRef: { "$ref": "#/$defs/gitFootprintRef" },
          headRef: { "$ref": "#/$defs/gitFootprintRef" },
          branch: { type: "string" },
          commit: { type: "string" },
          diffStat: { "$ref": "#/$defs/gitDiffStat" },
          files: {
            type: "array",
            items: { "$ref": "#/$defs/gitFileFootprint" }
          },
          collectedAt: { "$ref": "#/$defs/timestamp" }
        }
      },
      gitFootprintRef: {
        type: "object",
        additionalProperties: true,
        properties: {
          name: { type: "string" },
          commit: { type: "string" }
        }
      },
      gitDiffStat: {
        type: "object",
        anyOf: [
          { required: ["filesChanged", "insertions", "deletions", "totalChanges"] },
          { required: ["filesChanged", "additions", "deletions", "totalChanges"] }
        ],
        additionalProperties: true,
        properties: {
          filesChanged: { type: "number" },
          insertions: { type: "number" },
          additions: { type: "number" },
          deletions: { type: "number" },
          totalChanges: { type: "number" },
          binaryFiles: { type: "number" }
        }
      },
      gitFileFootprint: {
        type: "object",
        anyOf: [
          { required: ["path", "insertions", "deletions", "totalChanges"] },
          { required: ["path", "additions", "deletions", "totalChanges"] }
        ],
        additionalProperties: true,
        properties: {
          path: { type: "string" },
          oldPath: { type: "string" },
          changeType: { type: "string" },
          insertions: { type: ["number", "null"] },
          additions: { type: ["number", "null"] },
          deletions: { type: ["number", "null"] },
          totalChanges: { type: ["number", "null"] },
          binary: { type: "boolean" }
        }
      },
      goalMetadata: {
        type: "object",
        required: ["text"],
        additionalProperties: true,
        properties: {
          text: { type: "string" },
          source: { type: "string" },
          createdAt: { "$ref": "#/$defs/timestamp" }
        }
      },
      plannerMetadata: {
        type: "object",
        additionalProperties: true,
        properties: {
          name: { type: "string" },
          model: { type: "string" },
          version: { type: "string" },
          promptRef: { type: "string" },
          requestId: { type: "string" },
          plannedAt: { "$ref": "#/$defs/timestamp" }
        }
      },
      contextRef: {
        type: "object",
        required: ["ref"],
        additionalProperties: true,
        properties: {
          type: { type: "string" },
          ref: { type: "string" },
          title: { type: "string" },
          nodeId: { type: "string" }
        }
      },
      resultSummary: {
        type: "object",
        required: ["summary"],
        additionalProperties: true,
        properties: {
          status: { type: "string" },
          summary: { type: "string" },
          artifacts: {
            type: "array",
            items: { type: "string" }
          },
          completedAt: { "$ref": "#/$defs/timestamp" }
        }
      },
      outputContract: {
        type: "object",
        additionalProperties: true,
        properties: {
          format: { type: "string" },
          requiredArtifacts: {
            type: "array",
            items: { type: "string" }
          },
          acceptanceCriteria: {
            type: "array",
            items: { type: "string" }
          },
          schemaRef: { type: "string" }
        }
      },
      integrationRef: {
        type: "object",
        required: ["name"],
        additionalProperties: true,
        properties: {
          name: { type: "string" },
          kind: { type: "string" },
          status: { type: "string" },
          inputRefs: {
            type: "array",
            items: {
              type: "object",
              required: ["nodeId", "outputRef"],
              additionalProperties: true,
              properties: {
                nodeId: { type: "string" },
                outputRef: { type: "string" }
              }
            }
          },
          publishedOutputRef: { type: "string" }
        }
      },
      workspace: {
        type: "object",
        required: ["cloneCwd"],
        additionalProperties: true,
        properties: {
          remote: { type: "string" },
          bareRepo: { type: "string" },
          cloneCwd: { type: "string" },
          runId: { type: "string" },
          session: { type: "string" },
          preparedAt: { "$ref": "#/$defs/timestamp" },
          retained: { type: "boolean" }
        }
      }
    },
    "x-spg-nodeExamples": {
      task: {
        "TASK_ID": {
          title: "Implement task",
          kind: "task",
          status: "pending"
        }
      },
      series: {
        "SERIES_ID": {
          title: "Ordered phase",
          kind: "series",
          status: "pending",
          children: ["FIRST_TASK", "SECOND_TASK"]
        }
      },
      parallel: {
        "PARALLEL_ID": {
          title: "Independent branches",
          kind: "parallel",
          status: "pending",
          children: ["WEB_BRANCH", "API_BRANCH"]
        }
      },
      gate: {
        "GATE_ID": {
          title: "Integration checkpoint",
          kind: "gate",
          status: "pending"
        }
      }
    },
    "x-spg-validatorInvariants": {
      source: "scripts/contracts.ts validatePlanGraphFileResult",
      fatal: [
        { id: "json-parse", representableInJsonSchema: false, reason: "JSON Schema runs after JSON parsing." },
        { id: "graph-object", representableInJsonSchema: true },
        { id: "graph-body", representableInJsonSchema: true },
        { id: "root-string", representableInJsonSchema: true },
        { id: "root-in-nodes", representableInJsonSchema: false, reason: "Requires comparing graph.root with keys in graph.nodes." },
        { id: "nodes-map", representableInJsonSchema: true },
        { id: "node-object", representableInJsonSchema: true },
        { id: "children-array", representableInJsonSchema: true },
        { id: "child-id-string", representableInJsonSchema: true },
        { id: "child-exists", representableInJsonSchema: false, reason: "Requires checking every child id against sibling object keys." },
        { id: "no-duplicate-child", representableInJsonSchema: true },
        { id: "acyclic", representableInJsonSchema: false, reason: "Requires graph traversal over arbitrary node-map references." },
        { id: "non-empty-series", representableInJsonSchema: true },
        { id: "non-empty-parallel", representableInJsonSchema: true },
        { id: "lease-shape", representableInJsonSchema: true },
        { id: "timestamp-shape", representableInJsonSchema: true },
        { id: "history-shape", representableInJsonSchema: true }
      ],
      warnings: [
        "unknown-kind",
        "unknown-status",
        "task-with-children",
        "gate-with-children",
        "lease-status-compatibility",
        "unreachable-node"
      ]
    }
  };
}

export async function writePlanGraphJsonSchema(schemaPath = defaultSchemaPath()): Promise<void> {
  await mkdir(dirname(schemaPath), { recursive: true });
  await writeFile(schemaPath, `${JSON.stringify(buildPlanGraphJsonSchema(), null, 2)}\n`, "utf8");
}

export function defaultSchemaPath(): string {
  const { rootDir } = runtimePathsFromModuleUrl(import.meta.url);
  return join(rootDir, "schemas", "plan-graph.schema.json");
}

export async function main(): Promise<void> {
  await writePlanGraphJsonSchema(process.argv[2] || defaultSchemaPath());
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
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
