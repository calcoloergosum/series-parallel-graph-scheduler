import type { JsonValue, SlackNotificationResult } from "./contracts.js";
import { readGraph } from "./graph-io.js";
import { summarizeGraph } from "./graph-traversal.js";
import { redactSecretText } from "./shared-utils.js";

export type SlackNotificationDetails = Record<string, JsonValue | undefined>;

const defaultSlackTimeoutMs = 5000;
const maxFailureReasonLength = 200;
const chatDetailKeys = ["report"] as const;

export async function sendSlackNotification(
  graphPath: string,
  event: string,
  details: SlackNotificationDetails = {}
): Promise<SlackNotificationResult> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    return { skipped: true, reason: "SLACK_WEBHOOK_URL is not set" };
  }

  try {
    const text = await buildSlackNotificationText(graphPath, event, details);
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(slackTimeoutMs())
    });

    if (!response.ok) {
      return { failed: true, reason: `Slack notification failed: HTTP ${response.status}` };
    }

    return { sent: true };
  } catch (error) {
    return { failed: true, reason: notificationFailureReason(error) };
  }
}

export async function buildSlackNotificationText(
  graphPath: string,
  event: string,
  details: SlackNotificationDetails = {}
): Promise<string> {
  const graph = await readGraph(graphPath);
  const nodeId = detailText(details, "nodeId");
  const node = nodeId ? graph.graph.nodes[nodeId] : undefined;
  const summary = summarizeGraph(graph);
  const lines = [
    `*${slackText(event.toUpperCase())}* ${nodeId ? slackText(nodeId) : ""} ${node?.title ? `- ${slackText(node.title)}` : ""}`.trim(),
    `graph v${slackText(summary.graphVersion)}; ${Object.entries(summary.counts).map(([status, count]) => `${slackText(status)}=${count}`).join(", ")}`
  ];

  for (const key of chatDetailKeys) {
    const value = detailText(details, key);
    if (value) {
      lines.push(`${key}: ${slackText(value)}`);
    }
  }

  return lines.join("\n");
}

function detailText(details: SlackNotificationDetails, key: string): string | undefined {
  const value = details[key];
  return value ? String(value) : undefined;
}

function slackText(value: unknown): string {
  return redactSecretText(String(value))
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll(/[\r\n\t]+/g, " ")
    .replaceAll(/([*_~`])/g, "\\$1");
}

function slackTimeoutMs(): number {
  const raw = process.env.SPG_SLACK_TIMEOUT_MS;
  if (!raw) {
    return defaultSlackTimeoutMs;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return defaultSlackTimeoutMs;
  }
  return parsed;
}

function notificationFailureReason(error: unknown): string {
  if (isAbortError(error)) {
    return `Slack notification failed: timed out after ${slackTimeoutMs()}ms`;
  }
  if (error instanceof Error && error.message) {
    return truncateFailureReason(`Slack notification failed: ${error.message}`);
  }
  return "Slack notification failed";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function truncateFailureReason(reason: string): string {
  const normalized = reason.replaceAll(/[\r\n\t]+/g, " ");
  if (normalized.length <= maxFailureReasonLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxFailureReasonLength - 3)}...`;
}
