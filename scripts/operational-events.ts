import { redactSecretText } from "./shared-utils.js";
import type {
  GraphHistoryEntry,
  JsonObject,
  JsonValue,
  OperationalEventExportEntry,
  PlanGraphFile
} from "./contracts.js";

export const operationalEvents = {
  claimed: "claimed",
  running: "running",
  renewed: "renewed",
  done: "done",
  blocked: "blocked",
  answered: "answered",
  failed: "failed",
  reset: "reset",
  decomposed: "decomposed",
  expired: "expired",
  subtreeDone: "subtree-done",
  childReset: "child-reset",
  clonePrepared: "clone-prepared",
  branchCreated: "branch-created",
  outputRefRecorded: "output-ref-recorded",
  mergeAttempted: "merge-attempted",
  mergeConflicted: "merge-conflicted",
  parentRefPublished: "parent-ref-published",
  plannerDecisionRecorded: "planner-decision-recorded",
  plannerFailed: "planner-failed",
  plannerPreviewApplied: "planner-preview-applied",
  plannerPreviewRejected: "planner-preview-rejected",
  plannerPreviewRegenerated: "planner-preview-regenerated",
  workerStarted: "worker-started",
  workerStopped: "worker-stopped",
  lockAcquired: "lock-acquired",
  lockReleased: "lock-released",
  lockStaleReaped: "lock-stale-reaped",
  lockTimeout: "lock-timeout"
} as const;

export type OperationalEventName = typeof operationalEvents[keyof typeof operationalEvents];

export interface OperationalEventDefinition {
  name: OperationalEventName;
  producer: "graph-history" | "worker-manager" | "graph-lock";
  stableFields: readonly string[];
  description: string;
}

export const operationalEventTaxonomy = [
  {
    name: operationalEvents.claimed,
    producer: "graph-history",
    stableFields: ["at", "event", "previousStatus", "status", "session", "runId", "leaseExpiresAt"],
    description: "A worker claimed a ready leaf and created a lease."
  },
  {
    name: operationalEvents.running,
    producer: "graph-history",
    stableFields: ["at", "event", "previousStatus", "status", "session", "runId", "startedAt"],
    description: "A claimed leaf entered worker execution."
  },
  {
    name: operationalEvents.renewed,
    producer: "graph-history",
    stableFields: ["at", "event", "status", "session", "runId", "renewedAt", "leaseExpiresAt"],
    description: "A worker extended an owned lease."
  },
  {
    name: operationalEvents.done,
    producer: "graph-history",
    stableFields: ["at", "event", "previousStatus", "status", "session", "runId", "completedAt", "report", "clearedFields", "diffStatCollected", "diffStat"],
    description: "A worker completed a leaf."
  },
  {
    name: operationalEvents.blocked,
    producer: "graph-history",
    stableFields: ["at", "event", "previousStatus", "status", "session", "runId", "blockedAt", "blockedReason", "question"],
    description: "A worker paused a leaf for operator input."
  },
  {
    name: operationalEvents.answered,
    producer: "graph-history",
    stableFields: ["at", "event", "previousStatus", "status", "answer", "responder", "answeredAt", "clearedFields"],
    description: "An operator answered a blocked leaf and returned it to pending."
  },
  {
    name: operationalEvents.failed,
    producer: "graph-history",
    stableFields: ["at", "event", "previousStatus", "status", "session", "runId", "failedAt", "failureReason", "report", "clearedFields"],
    description: "A worker marked a leaf failed."
  },
  {
    name: operationalEvents.reset,
    producer: "graph-history",
    stableFields: ["at", "event", "previousStatus", "status", "resetScope", "reason", "rootId", "clearedFields"],
    description: "An operator reset one node, a subtree, or execution-reachable work."
  },
  {
    name: operationalEvents.decomposed,
    producer: "graph-history",
    stableFields: ["at", "event", "previousStatus", "status", "previousKind", "kind", "childIds", "session", "runId", "clearedFields"],
    description: "A worker replaced a leaf with a child graph."
  },
  {
    name: operationalEvents.expired,
    producer: "graph-history",
    stableFields: ["at", "event", "previousStatus", "status", "session", "runId", "leaseExpiresAt", "expiredAt", "clearedFields"],
    description: "The scheduler released an expired claimed or running lease."
  },
  {
    name: operationalEvents.subtreeDone,
    producer: "graph-history",
    stableFields: ["at", "event", "previousStatus", "status", "completedAt", "childIds"],
    description: "Reconciliation marked an internal subtree done."
  },
  {
    name: operationalEvents.childReset,
    producer: "graph-history",
    stableFields: ["at", "event", "previousStatus", "status", "childId", "clearedFields"],
    description: "A reset reopened a completed or unresolved composition ancestor."
  },
  {
    name: operationalEvents.clonePrepared,
    producer: "graph-history",
    stableFields: ["at", "event", "session", "runId", "remote", "bareRepo", "cloneCwd", "baseRef"],
    description: "An isolated worker prepared a local clone from the bare repository cache."
  },
  {
    name: operationalEvents.branchCreated,
    producer: "graph-history",
    stableFields: ["at", "event", "session", "runId", "cloneCwd", "baseRef", "workRef"],
    description: "An isolated worker created or checked out the per-run work branch."
  },
  {
    name: operationalEvents.outputRefRecorded,
    producer: "graph-history",
    stableFields: ["at", "event", "session", "runId", "workRef", "outputRef", "commit", "report", "diffStatCollected", "diffStat"],
    description: "An isolated worker recorded the output ref produced by a completed run."
  },
  {
    name: operationalEvents.mergeAttempted,
    producer: "graph-history",
    stableFields: ["at", "event", "parentId", "integrationRef", "baseRef", "childId", "childOutputRef", "childOrderIndex"],
    description: "A parallel parent buffer attempted to merge a child output ref."
  },
  {
    name: operationalEvents.mergeConflicted,
    producer: "graph-history",
    stableFields: ["at", "event", "parentId", "integrationRef", "baseRef", "childId", "childOutputRef", "childOrderIndex", "conflictedPaths", "result"],
    description: "A parallel parent buffer merge encountered conflicts and left the parent unresolved."
  },
  {
    name: operationalEvents.parentRefPublished,
    producer: "graph-history",
    stableFields: ["at", "event", "parentId", "kind", "integrationRef", "outputRef", "commit", "result", "diffStatCollected", "diffStat"],
    description: "A composition parent published the output ref used by downstream isolated work."
  },
  {
    name: operationalEvents.plannerDecisionRecorded,
    producer: "graph-history",
    stableFields: ["at", "event", "previousStatus", "status", "session", "runId", "requestId", "decision", "decisionStatus", "attemptCount", "maxAttempts", "childIds", "reason"],
    description: "Worker planner preflight recorded a durable node decision or attempt outcome."
  },
  {
    name: operationalEvents.plannerFailed,
    producer: "graph-history",
    stableFields: ["at", "event", "previousStatus", "status", "session", "runId", "requestId", "failurePolicy", "reason", "report"],
    description: "Worker planner preflight failed validation or runtime execution and was converted to a controlled blocked or failed node."
  },
  {
    name: operationalEvents.plannerPreviewApplied,
    producer: "graph-history",
    stableFields: ["at", "event", "previousStatus", "status", "session", "runId", "requestId", "proposedKind", "childIds", "report"],
    description: "An operator approved and applied a stored planner decomposition preview through the guarded decompose mutation path."
  },
  {
    name: operationalEvents.plannerPreviewRejected,
    producer: "graph-history",
    stableFields: ["at", "event", "previousStatus", "status", "session", "runId", "requestId", "proposedKind", "childIds", "reason", "report"],
    description: "A planner preview was held for approval or explicitly rejected without inserting child nodes."
  },
  {
    name: operationalEvents.plannerPreviewRegenerated,
    producer: "graph-history",
    stableFields: ["at", "event", "previousStatus", "status", "session", "runId", "previousRequestId", "requestId", "proposedKind", "childIds", "reason", "report"],
    description: "A valid planner preview replaced older pending preview metadata on the same node."
  },
  {
    name: operationalEvents.workerStarted,
    producer: "worker-manager",
    stableFields: ["at", "event", "workerId", "session", "pid", "cwd"],
    description: "The visualizer worker manager spawned a worker process."
  },
  {
    name: operationalEvents.workerStopped,
    producer: "worker-manager",
    stableFields: ["at", "event", "workerId", "session", "signal", "exitCode"],
    description: "The visualizer worker manager stopped or observed worker process exit."
  },
  {
    name: operationalEvents.lockAcquired,
    producer: "graph-lock",
    stableFields: ["at", "event", "graphPath", "lockPath", "ownerId", "pid", "host"],
    description: "A graph mutation acquired the filesystem lock."
  },
  {
    name: operationalEvents.lockReleased,
    producer: "graph-lock",
    stableFields: ["at", "event", "graphPath", "lockPath", "ownerId"],
    description: "A graph mutation released the filesystem lock."
  },
  {
    name: operationalEvents.lockStaleReaped,
    producer: "graph-lock",
    stableFields: ["at", "event", "graphPath", "lockPath", "ownerId"],
    description: "A stale graph lock was removed before retrying acquisition."
  },
  {
    name: operationalEvents.lockTimeout,
    producer: "graph-lock",
    stableFields: ["at", "event", "graphPath", "lockPath", "ownerId", "timeoutMs", "staleMs"],
    description: "A graph lock wait timed out."
  }
] as const satisfies readonly OperationalEventDefinition[];

export function redactOperationalEventDetails(details: Record<string, unknown>): Record<string, unknown> {
  return redactOperationalValue(details) as Record<string, unknown>;
}

export interface ExportOperationalEventsOptions {
  limit?: number;
  nodeId?: string;
  event?: string;
}

interface IndexedHistoryEntry {
  nodeId: string;
  historyIndex: number;
  entry: GraphHistoryEntry;
}

const topLevelExportFields = new Set(["at", "event", "status", "session", "runId"]);
const unsafePublicPlannerTextFields = new Set([
  "prompt",
  "rawtext",
  "rawprompt",
  "rawplannertext",
  "rawplanneroutput",
  "plannerprompt",
  "plannerrawtext"
]);
const redactedPlannerText = "[REDACTED: planner text]";

export function exportOperationalEvents(
  graph: PlanGraphFile,
  { limit = 50, nodeId, event }: ExportOperationalEventsOptions = {}
): OperationalEventExportEntry[] {
  const events: IndexedHistoryEntry[] = [];
  for (const [currentNodeId, node] of Object.entries(graph.graph?.nodes || {})) {
    if (nodeId && currentNodeId !== nodeId) {
      continue;
    }
    if (!Array.isArray(node.history)) {
      continue;
    }
    node.history.forEach((entry, historyIndex) => {
      if (event && entry.event !== event) {
        return;
      }
      events.push({
        nodeId: currentNodeId,
        historyIndex,
        entry
      });
    });
  }

  return events
    .sort(compareRecentHistoryEntries)
    .slice(0, limit)
    .map(formatOperationalEventExportEntry);
}

function redactOperationalValue(value: unknown, key?: string): unknown {
  if (key && unsafePublicPlannerTextFields.has(key.toLowerCase())) {
    return redactedPlannerText;
  }
  if (typeof value === "string") {
    return redactOperationalText(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactOperationalValue(entry));
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [
      childKey,
      redactOperationalValue(childValue, childKey)
    ])
  );
}

function redactOperationalText(value: string): string {
  return redactSecretText(value);
}

function compareRecentHistoryEntries(left: IndexedHistoryEntry, right: IndexedHistoryEntry): number {
  const byTime = String(right.entry.at || "").localeCompare(String(left.entry.at || ""));
  if (byTime !== 0) {
    return byTime;
  }
  return right.nodeId.localeCompare(left.nodeId) || right.historyIndex - left.historyIndex;
}

function formatOperationalEventExportEntry({ nodeId, entry }: IndexedHistoryEntry): OperationalEventExportEntry {
  const redactedEntry = omitUndefined(redactOperationalEventDetails(entry) as Record<string, unknown>);
  const timestamps = eventTimestamps(redactedEntry);
  const details = eventDetails(redactedEntry, timestamps);
  return omitUndefined({
    at: stringValue(redactedEntry.at) || "",
    event: stringValue(redactedEntry.event) || "",
    nodeId,
    status: stringValue(redactedEntry.status),
    session: stringValue(redactedEntry.session),
    runId: stringValue(redactedEntry.runId),
    timestamps,
    details: omitUndefined(details)
  }) as OperationalEventExportEntry;
}

function eventTimestamps(entry: Record<string, unknown>): JsonObject {
  const timestamps: JsonObject = {};
  for (const [key, value] of Object.entries(entry)) {
    if (isTimestampField(key) && typeof value === "string") {
      timestamps[key] = value;
    }
  }
  return timestamps;
}

function eventDetails(entry: Record<string, unknown>, timestamps: JsonObject): JsonObject {
  const details: JsonObject = {};
  for (const [key, value] of Object.entries(entry)) {
    if (topLevelExportFields.has(key) || Object.hasOwn(timestamps, key)) {
      continue;
    }
    details[key] = jsonValue(value);
  }
  return omitUndefined(details);
}

function isTimestampField(key: string): boolean {
  return key === "at" || key.endsWith("At") || key.endsWith("ExpiresAt");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function jsonValue(value: unknown): JsonValue | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => jsonValue(entry) ?? null);
  }
  if (typeof value === "object") {
    return omitUndefined(Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, jsonValue(entry)])
    ));
  }
  return String(value);
}

function omitUndefined<T extends Record<string, unknown>>(details: T): T {
  return Object.fromEntries(Object.entries(details).filter(([, value]) => value !== undefined)) as T;
}
