import { timingSafeEqual } from "node:crypto";
import { watch } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, dirname } from "node:path";

import { isRecord } from "./contracts.js";
import type {
  AnswerNodeResult,
  DecomposeNodeResult,
  GraphDiagnostics,
  GraphNode,
  GraphSummary,
  JsonValue,
  LeaseClaimResult,
  NodeMutationResult,
  PlanGraphFile,
  ReadyNode,
  RenewLeaseResult,
  ResetNodeResult,
  ResetSubtreeResult,
  SlackNotificationResult,
  VisualizerServerHandle
} from "./contracts.js";
import { defaultGraphPath } from "./graph-io.js";
import { NumericArgumentError, numericArgumentRanges, parseNumericArgument } from "./numeric-args.js";
import { exportOperationalEvents, operationalEvents } from "./operational-events.js";
import { errorMessage } from "./shared-utils.js";
import { renderVisualizerHtml } from "./visualizer-client.js";
import { buildVisualizerPayload } from "./visualizer-payload.js";
import {
  createWorkerManager,
  WorkerStartValidationError
} from "./visualizer-worker-manager.js";
import { buildWorkerPrompt } from "./worker.js";
import type { DecomposeChildDefinition } from "./node-mutations.js";

export interface VisualizerRuntime {
  defaultGraphPath: string;
  defaultPromptTemplatePath: string;
  schedulerCommand: string;
  schedulerScriptPath: string;
  rootDir: string;
  readGraph(graphPath: string): Promise<PlanGraphFile>;
  getNode(graph: PlanGraphFile, nodeId: string): GraphNode;
  listReadyLeafNodes(graph: PlanGraphFile): ReadyNode[];
  summarizeGraph(graph: PlanGraphFile): GraphSummary;
  defaultReportPath(nodeId: string, runId: string): string;
  diagnoseGraph(graphPath: string): Promise<GraphDiagnostics>;
  claimNode(graphPath: string, options: {
    session?: string;
    nodeId?: string;
    leaseSeconds?: number;
  }): Promise<LeaseClaimResult>;
  startNode(graphPath: string, options: {
    nodeId?: string;
    session?: string;
    runId?: string;
  }): Promise<NodeMutationResult>;
  renewNodeLease(graphPath: string, options: {
    nodeId?: string;
    session?: string;
    runId?: string;
    leaseSeconds?: number;
  }): Promise<RenewLeaseResult>;
  writeReportFile(graphPath: string, reportPath?: string, reportBody?: unknown): Promise<string | undefined>;
  completeNode(graphPath: string, options: {
    nodeId?: string;
    report?: string;
    session?: string;
    runId?: string;
  }): Promise<NodeMutationResult>;
  blockNode(graphPath: string, options: {
    nodeId?: string;
    question?: string;
    reason?: string;
    session?: string;
    runId?: string;
  }): Promise<NodeMutationResult>;
  answerNode(graphPath: string, options: {
    nodeId?: string;
    answer?: string;
    responder?: string;
  }): Promise<AnswerNodeResult>;
  failNode(graphPath: string, options: {
    nodeId?: string;
    reason?: string;
    report?: string;
    session?: string;
    runId?: string;
  }): Promise<NodeMutationResult>;
  resetNode(graphPath: string, options: {
    nodeId?: string;
    reason?: string;
  }): Promise<ResetNodeResult>;
  resetSubtree(graphPath: string, options: {
    nodeId?: string;
    reason?: string;
  }): Promise<ResetSubtreeResult>;
  resetReachable(graphPath: string, options: {
    nodeId?: string;
    reason?: string;
  }): Promise<ResetSubtreeResult>;
  decomposeNode(graphPath: string, options: {
    nodeId?: string;
    kind?: string;
    children?: DecomposeChildDefinition[];
    session?: string;
    runId?: string;
  }): Promise<DecomposeNodeResult>;
  renderPlanAfterUpdate(graphPath: string): Promise<void>;
  sendSlackNotification(
    graphPath: string,
    event: string,
    details?: Record<string, JsonValue | undefined>
  ): Promise<SlackNotificationResult>;
}

export interface CreateVisualizerServerOptions {
  graphPath?: string;
  port?: number;
  host?: string;
  defaultWorkerCwd?: string;
  writeToken?: string;
  allowUnsafeWrites?: boolean;
  runtime: VisualizerRuntime;
}

export class RequestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestValidationError";
  }
}

export function isLocalVisualizerHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "localhost"
    || normalized === "127.0.0.1"
    || normalized === "::1"
    || normalized === "[::1]";
}

export function visualizerHostSecurityWarning(host: string, allowUnsafeWrites = false): string | undefined {
  if (isLocalVisualizerHost(host)) {
    return undefined;
  }
  if (allowUnsafeWrites) {
    return `Warning: unsafe visualizer writes are enabled on ${host}. Any reachable client can start or stop workers and mutate graph nodes without a token.`;
  }
  return `Warning: the visualizer write API is intended for trusted local use. Binding to ${host} may expose worker start/stop controls and node mutation routes to other machines unless write requests require a token.`;
}

export async function createVisualizerServer({
  graphPath = defaultGraphPath,
  port = 8787,
  host = "127.0.0.1",
  defaultWorkerCwd,
  writeToken,
  allowUnsafeWrites = false,
  runtime
}: CreateVisualizerServerOptions): Promise<VisualizerServerHandle> {
  const clients = new Set<ServerResponse>();
  const listenPort = parseNumericArgument(port, { flag: "--port", ...numericArgumentRanges.port, defaultValue: 8787 })!;
  const securityWarning = visualizerHostSecurityWarning(host, allowUnsafeWrites);
  const requiredWriteToken = normalizeWriteToken(writeToken);
  validateVisualizerWriteProtection(host, requiredWriteToken, allowUnsafeWrites);

  async function send(client: ServerResponse): Promise<void> {
    const data = JSON.stringify(await buildVisualizerPayload(graphPath, workerManager));
    client.write(`data: ${data}\n\n`);
  }

  async function broadcast(): Promise<void> {
    for (const client of clients) {
      try {
        await send(client);
      } catch {
        clients.delete(client);
      }
    }
  }

  const workerManager = createWorkerManager({
    graphPath,
    defaultCwd: defaultWorkerCwd || dirname(graphPath),
    schedulerScriptPath: runtime.schedulerScriptPath,
    rootDir: runtime.rootDir,
    onChange: broadcast
  });

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${host}:${listenPort}`);

      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(renderVisualizerHtml());
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/graph") {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify(await buildVisualizerPayload(graphPath, workerManager)));
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/summary") {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify(runtime.summarizeGraph(await runtime.readGraph(graphPath))));
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/ready") {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify(runtime.listReadyLeafNodes(await runtime.readGraph(graphPath))));
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/diagnostics") {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify(await runtime.diagnoseGraph(graphPath)));
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/events") {
        const limit = numericQueryParam(url, "limit", { ...numericArgumentRanges.eventLimit, defaultValue: 50 });
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify(exportOperationalEvents(await runtime.readGraph(graphPath), {
          limit,
          nodeId: queryStringParam(url, "node"),
          event: queryStringParam(url, "event")
        })));
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/prompt") {
        const prompt = await buildWorkerPrompt(graphPath, {
          nodeId: requiredQueryStringParam(url, "node", "prompt"),
          session: queryStringParam(url, "session"),
          runId: queryStringParam(url, "run"),
          templatePath: queryStringParam(url, "template"),
          cwd: queryStringParam(url, "cwd") || dirname(graphPath),
          reportPath: queryStringParam(url, "report")
        }, runtime);
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
        res.end(prompt);
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/workers") {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify(workerManager.status()));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/workers/start") {
        if (!authorizeWriteRequest(req, res, requiredWriteToken)) {
          return;
        }
        const started = workerManager.startWorkers(await readRequestJson(req));
        await broadcast();
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ started, workerManager: workerManager.status() }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/workers/stop") {
        if (!authorizeWriteRequest(req, res, requiredWriteToken)) {
          return;
        }
        const body = await readRequestJson(req);
        const worker = workerManager.stopWorker(stringBodyField(body, "id"));
        await broadcast();
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ worker, workerManager: workerManager.status() }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/workers/stop-all") {
        if (!authorizeWriteRequest(req, res, requiredWriteToken)) {
          return;
        }
        const stopped = workerManager.stopAll();
        await broadcast();
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ stopped, workerManager: workerManager.status() }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/node/claim") {
        if (!authorizeWriteRequest(req, res, requiredWriteToken)) {
          return;
        }
        const body = await readRequestJson(req);
        const result = await runtime.claimNode(graphPath, {
          session: optionalStringBodyField(body, "session"),
          nodeId: optionalStringBodyField(body, "nodeId"),
          leaseSeconds: numericBodyField(body, "leaseSeconds", numericArgumentRanges.leaseSeconds)
            ?? numericBodyField(body, "lease", numericArgumentRanges.leaseSeconds)
        });
        await runtime.renderPlanAfterUpdate(graphPath);
        await broadcast();
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify(result));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/node/start") {
        if (!authorizeWriteRequest(req, res, requiredWriteToken)) {
          return;
        }
        const body = await readRequestJson(req);
        const result = await runtime.startNode(graphPath, {
          nodeId: stringBodyField(body, "nodeId"),
          session: optionalStringBodyField(body, "session"),
          runId: optionalRunIdBodyField(body)
        });
        await runtime.renderPlanAfterUpdate(graphPath);
        await broadcast();
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify(result));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/node/renew") {
        if (!authorizeWriteRequest(req, res, requiredWriteToken)) {
          return;
        }
        const body = await readRequestJson(req);
        const result = await runtime.renewNodeLease(graphPath, {
          nodeId: stringBodyField(body, "nodeId"),
          session: optionalStringBodyField(body, "session"),
          runId: optionalRunIdBodyField(body),
          leaseSeconds: numericBodyField(body, "leaseSeconds", numericArgumentRanges.leaseSeconds)
            ?? numericBodyField(body, "lease", numericArgumentRanges.leaseSeconds)
        });
        await runtime.renderPlanAfterUpdate(graphPath);
        await broadcast();
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify(result));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/node/done") {
        if (!authorizeWriteRequest(req, res, requiredWriteToken)) {
          return;
        }
        const body = await readRequestJson(req);
        const nodeId = stringBodyField(body, "nodeId");
        const report = optionalStringBodyField(body, "report");
        await runtime.writeReportFile(graphPath, report, optionalBodyField(body, "reportBody") ?? optionalBodyField(body, "report-body"));
        const result: NodeMutationResult & { slack?: SlackNotificationResult } = {
          ...await runtime.completeNode(graphPath, {
            nodeId,
            report,
            session: optionalStringBodyField(body, "session"),
            runId: optionalRunIdBodyField(body)
          })
        };
        await runtime.renderPlanAfterUpdate(graphPath);
        result.slack = await runtime.sendSlackNotification(graphPath, operationalEvents.done, { nodeId, report });
        await broadcast();
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify(result));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/node/block") {
        if (!authorizeWriteRequest(req, res, requiredWriteToken)) {
          return;
        }
        const body = await readRequestJson(req);
        const nodeId = stringBodyField(body, "nodeId");
        const question = optionalStringBodyField(body, "question");
        const reason = optionalStringBodyField(body, "reason");
        const result: NodeMutationResult & { slack?: SlackNotificationResult } = {
          ...await runtime.blockNode(graphPath, {
            nodeId,
            question,
            reason,
            session: optionalStringBodyField(body, "session"),
            runId: optionalRunIdBodyField(body)
          })
        };
        await runtime.renderPlanAfterUpdate(graphPath);
        result.slack = await runtime.sendSlackNotification(graphPath, operationalEvents.blocked, { nodeId, question, reason });
        await broadcast();
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify(result));
        return;
      }

      if (req.method === "POST" && (url.pathname === "/api/node/answer" || url.pathname === "/api/answer")) {
        if (!authorizeWriteRequest(req, res, requiredWriteToken)) {
          return;
        }
        const body = await readRequestJson(req);
        const nodeId = stringBodyField(body, "nodeId");
        const answer = stringBodyField(body, "answer");
        const result: AnswerNodeResult & { slack?: SlackNotificationResult } = {
          ...await runtime.answerNode(graphPath, {
            nodeId,
            answer,
            responder: optionalStringBodyField(body, "responder")
          })
        };
        await runtime.renderPlanAfterUpdate(graphPath);
        result.slack = await runtime.sendSlackNotification(graphPath, operationalEvents.answered, { nodeId, answer });
        await broadcast();
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify(result));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/node/fail") {
        if (!authorizeWriteRequest(req, res, requiredWriteToken)) {
          return;
        }
        const body = await readRequestJson(req);
        const nodeId = stringBodyField(body, "nodeId");
        const reason = optionalStringBodyField(body, "reason");
        const report = optionalStringBodyField(body, "report");
        const result: NodeMutationResult & { slack?: SlackNotificationResult } = {
          ...await runtime.failNode(graphPath, {
            nodeId,
            reason,
            report,
            session: optionalStringBodyField(body, "session"),
            runId: optionalRunIdBodyField(body)
          })
        };
        await runtime.renderPlanAfterUpdate(graphPath);
        result.slack = await runtime.sendSlackNotification(graphPath, operationalEvents.failed, { nodeId, reason, report });
        await broadcast();
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify(result));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/node/reset") {
        if (!authorizeWriteRequest(req, res, requiredWriteToken)) {
          return;
        }
        const body = await readRequestJson(req);
        const result = await runtime.resetNode(graphPath, {
          nodeId: stringBodyField(body, "nodeId"),
          reason: optionalStringBodyField(body, "reason")
        });
        await runtime.renderPlanAfterUpdate(graphPath);
        await broadcast();
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify(result));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/node/reset-subtree") {
        if (!authorizeWriteRequest(req, res, requiredWriteToken)) {
          return;
        }
        const body = await readRequestJson(req);
        const result = await runtime.resetSubtree(graphPath, {
          nodeId: stringBodyField(body, "nodeId"),
          reason: optionalStringBodyField(body, "reason")
        });
        await runtime.renderPlanAfterUpdate(graphPath);
        await broadcast();
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify(result));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/node/reset-reachable") {
        if (!authorizeWriteRequest(req, res, requiredWriteToken)) {
          return;
        }
        const body = await readRequestJson(req);
        const result = await runtime.resetReachable(graphPath, {
          nodeId: stringBodyField(body, "nodeId"),
          reason: optionalStringBodyField(body, "reason")
        });
        await runtime.renderPlanAfterUpdate(graphPath);
        await broadcast();
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify(result));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/node/decompose") {
        if (!authorizeWriteRequest(req, res, requiredWriteToken)) {
          return;
        }
        const body = await readRequestJson(req);
        const nodeId = stringBodyField(body, "nodeId");
        const result: DecomposeNodeResult & { slack?: SlackNotificationResult } = {
          ...await runtime.decomposeNode(graphPath, {
            nodeId,
            kind: optionalStringBodyField(body, "kind"),
            children: childDefinitionsBodyField(body, "children"),
            session: optionalStringBodyField(body, "session"),
            runId: optionalRunIdBodyField(body)
          })
        };
        await runtime.renderPlanAfterUpdate(graphPath);
        result.slack = await runtime.sendSlackNotification(graphPath, operationalEvents.decomposed, { nodeId });
        await broadcast();
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify(result));
        return;
      }

      if (req.method === "GET" && url.pathname === "/events") {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          connection: "keep-alive"
        });
        clients.add(res);
        await send(res);
        req.on("close", () => clients.delete(res));
        return;
      }

      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
    } catch (error) {
      const badRequest = error instanceof NumericArgumentError
        || error instanceof WorkerStartValidationError
        || error instanceof RequestValidationError;
      res.writeHead(badRequest ? 400 : 500, { "content-type": "text/plain; charset=utf-8" });
      res.end(error instanceof Error ? (badRequest ? error.message : error.stack || error.message) : String(error));
    }
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(listenPort, host, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });

  const graphDir = dirname(graphPath);
  const graphFileName = basename(graphPath);
  const watcher = watch(graphDir, async (_event, filename) => {
    if (filename && String(filename) !== graphFileName) {
      return;
    }
    await broadcast();
  });

  const address: AddressInfo | string | null = server.address();
  const actualPort = typeof address === "object" && address ? address.port : listenPort;

  return {
    server,
    url: `http://${host}:${actualPort}`,
    securityWarning,
    close: async () => {
      workerManager.stopAll();
      watcher?.close();
      for (const client of clients) {
        client.end();
      }
      server.closeAllConnections?.();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  };
}

export async function readRequestJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 64 * 1024) {
      throw new RequestValidationError("Request body is too large");
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new RequestValidationError(`Invalid JSON request body: ${errorMessage(error)}`);
  }
  if (!isRecord(parsed)) {
    throw new RequestValidationError("Request body must be a JSON object");
  }
  return parsed;
}

function normalizeWriteToken(token: string | undefined): string | undefined {
  if (token === undefined) {
    return undefined;
  }
  const normalized = token.trim();
  if (!normalized) {
    throw new Error("--visualizer-write-token must not be empty");
  }
  return normalized;
}

function validateVisualizerWriteProtection(host: string, writeToken: string | undefined, allowUnsafeWrites: boolean): void {
  if (isLocalVisualizerHost(host) || writeToken || allowUnsafeWrites) {
    return;
  }
  throw new Error(
    `Refusing to bind visualizer write endpoints to ${host} without protection. `
    + "Use --visualizer-write-token <token> or --unsafe-visualizer-write."
  );
}

function authorizeWriteRequest(
  req: IncomingMessage,
  res: ServerResponse,
  requiredWriteToken: string | undefined
): boolean {
  if (!requiredWriteToken) {
    return true;
  }
  const providedToken = requestWriteToken(req);
  if (providedToken && constantTimeStringEqual(providedToken, requiredWriteToken)) {
    return true;
  }
  res.writeHead(403, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  res.end("Forbidden: missing or invalid visualizer write token");
  return false;
}

function requestWriteToken(req: IncomingMessage): string | undefined {
  const headerToken = singleHeaderValue(req.headers["x-spg-visualizer-token"]);
  if (headerToken) {
    return headerToken;
  }
  const authorization = singleHeaderValue(req.headers.authorization);
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

function singleHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function constantTimeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function queryStringParam(url: URL, key: string): string | undefined {
  const values = url.searchParams.getAll(key);
  if (values.length === 0) {
    return undefined;
  }
  if (values.length > 1) {
    throw new RequestValidationError(`Query parameter ${key} can only be provided once`);
  }
  return values[0];
}

function requiredQueryStringParam(url: URL, key: string, command: string): string {
  const value = queryStringParam(url, key);
  if (value === undefined || value.trim() === "") {
    throw new RequestValidationError(`${command} requires ${key}`);
  }
  return value;
}

function numericQueryParam(
  url: URL,
  key: string,
  options: Omit<Parameters<typeof parseNumericArgument>[1], "flag">
): number | undefined {
  const values = url.searchParams.getAll(key);
  if (values.length > 1) {
    throw new RequestValidationError(`Query parameter ${key} can only be provided once`);
  }
  return parseNumericArgument(values.length === 0 ? undefined : values[0], { flag: `--${key}`, ...options });
}

function stringBodyField(body: Record<string, unknown>, field: string): string {
  const value = optionalStringBodyField(body, field);
  if (!value) {
    throw new RequestValidationError(`Missing ${field}`);
  }
  return value;
}

function numericBodyField(
  body: Record<string, unknown>,
  field: string,
  options: Omit<Parameters<typeof parseNumericArgument>[1], "flag">
): number | undefined {
  const value = body[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" && typeof value !== "number") {
    throw new RequestValidationError(`${field} must be a number`);
  }
  return parseNumericArgument(String(value), { flag: field, ...options });
}

function optionalBodyField(body: Record<string, unknown>, field: string): unknown {
  return body[field];
}

function optionalStringBodyField(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  return value === undefined ? undefined : String(value);
}

function optionalRunIdBodyField(body: Record<string, unknown>): string | undefined {
  return optionalStringBodyField(body, "runId") ?? optionalStringBodyField(body, "run");
}

function childDefinitionsBodyField(body: Record<string, unknown>, field: string): DecomposeChildDefinition[] {
  const value = body[field];
  if (!Array.isArray(value)) {
    throw new RequestValidationError(`Missing ${field}`);
  }
  return value.map((child, index) => {
    if (!isRecord(child)) {
      throw new RequestValidationError(`${field}[${index}] must be an object`);
    }
    const id = requiredChildString(child, "id", field, index);
    const title = requiredChildString(child, "title", field, index);
    const normalized: DecomposeChildDefinition = { ...child, id, title };
    if (child.kind !== undefined) {
      normalized.kind = childString(child, "kind", field, index);
    }
    if (child.status !== undefined) {
      normalized.status = childString(child, "status", field, index);
    }
    if (child.children !== undefined) {
      if (!Array.isArray(child.children) || !child.children.every((item) => typeof item === "string")) {
        throw new RequestValidationError(`${field}[${index}].children must be an array of strings`);
      }
      normalized.children = child.children;
    }
    return normalized;
  });
}

function requiredChildString(
  child: Record<string, unknown>,
  key: string,
  field: string,
  index: number
): string {
  const value = childString(child, key, field, index);
  if (!value) {
    throw new RequestValidationError(`Missing ${field}[${index}].${key}`);
  }
  return value;
}

function childString(child: Record<string, unknown>, key: string, field: string, index: number): string {
  const value = child[key];
  if (typeof value !== "string") {
    throw new RequestValidationError(`${field}[${index}].${key} must be a string`);
  }
  return value;
}
