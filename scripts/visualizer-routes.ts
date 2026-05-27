import { timingSafeEqual } from "node:crypto";
import { watch } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, dirname } from "node:path";

import { isRecord } from "./contracts.js";
import type {
  AnswerNodeResult,
  JsonValue,
  SlackNotificationResult,
  VisualizerServerHandle
} from "./contracts.js";
import { defaultGraphPath } from "./graph-io.js";
import { NumericArgumentError, numericArgumentRanges, parseNumericArgument } from "./numeric-args.js";
import { operationalEvents } from "./operational-events.js";
import { errorMessage } from "./shared-utils.js";
import { renderVisualizerHtml } from "./visualizer-client.js";
import { buildVisualizerPayload } from "./visualizer-payload.js";
import {
  createWorkerManager,
  WorkerStartValidationError
} from "./visualizer-worker-manager.js";

export interface VisualizerRuntime {
  defaultGraphPath: string;
  schedulerScriptPath: string;
  rootDir: string;
  answerNode(graphPath: string, options: {
    nodeId?: string;
    answer?: string;
    responder?: string;
  }): Promise<AnswerNodeResult>;
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
    return `Warning: unsafe visualizer writes are enabled on ${host}. Any reachable client can start or stop workers and mutate blocked answers without a token.`;
  }
  return `Warning: the visualizer worker manager API is intended for trusted local use. Binding to ${host} may expose worker start/stop controls to other machines unless write requests require a token.`;
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

      if (req.method === "POST" && url.pathname === "/api/answer") {
        if (!authorizeWriteRequest(req, res, requiredWriteToken)) {
          return;
        }
        const body = await readRequestJson(req);
        const result: AnswerNodeResult & { slack?: SlackNotificationResult } = {
          ...await runtime.answerNode(graphPath, {
            nodeId: stringBodyField(body, "nodeId"),
            answer: stringBodyField(body, "answer"),
            responder: optionalStringBodyField(body, "responder")
          })
        };
        await runtime.renderPlanAfterUpdate(graphPath);
        result.slack = await runtime.sendSlackNotification(graphPath, operationalEvents.answered, {
          nodeId: optionalStringBodyField(body, "nodeId"),
          answer: optionalStringBodyField(body, "answer")
        });
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
      if (res.headersSent || res.writableEnded) {
        if (!res.writableEnded) {
          res.end();
        }
        return;
      }
      const badRequest = error instanceof NumericArgumentError
        || error instanceof WorkerStartValidationError
        || error instanceof RequestValidationError;
      res.writeHead(badRequest ? 400 : 500, { "content-type": "text/plain; charset=utf-8" });
      res.end(formatVisualizerErrorResponse(error, { badRequest }));
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

function formatVisualizerErrorResponse(error: unknown, { badRequest }: { badRequest: boolean }): string {
  const message = error instanceof Error ? error.message : String(error);
  return badRequest ? message : `Unexpected visualizer error: ${message}`;
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

function stringBodyField(body: Record<string, unknown>, field: string): string {
  const value = optionalStringBodyField(body, field);
  if (!value) {
    throw new RequestValidationError(`Missing ${field}`);
  }
  return value;
}

function optionalStringBodyField(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  return value === undefined ? undefined : String(value);
}
