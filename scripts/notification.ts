import type { JsonValue, SlackNotificationResult } from "./contracts.js";
import { readGraph } from "./graph-io.js";
import { summarizeGraph } from "./graph-traversal.js";

export type SlackNotificationDetails = Record<string, JsonValue | undefined>;

export async function sendSlackNotification(
  graphPath: string,
  event: string,
  details: SlackNotificationDetails = {}
): Promise<SlackNotificationResult> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    return { skipped: true, reason: "SLACK_WEBHOOK_URL is not set" };
  }

  const text = await buildSlackNotificationText(graphPath, event, details);
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text })
  });

  if (!response.ok) {
    throw new Error(`Slack notification failed: HTTP ${response.status} ${await response.text()}`);
  }

  return { sent: true };
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
    `*${event.toUpperCase()}* ${nodeId || ""} ${node?.title ? `- ${node.title}` : ""}`.trim(),
    `graph v${summary.graphVersion}; ${Object.entries(summary.counts).map(([status, count]) => `${status}=${count}`).join(", ")}`
  ];

  for (const key of ["question", "answer", "reason", "report"] as const) {
    const value = detailText(details, key);
    if (value) {
      lines.push(`${key}: ${value}`);
    }
  }

  return lines.join("\n");
}

function detailText(details: SlackNotificationDetails, key: string): string | undefined {
  const value = details[key];
  return value ? String(value) : undefined;
}
