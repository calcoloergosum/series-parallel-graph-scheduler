import { dirname, resolve } from "node:path";
import type {
  CliCommand,
  DecomposeNodeResult,
  GraphSummary,
  JsonValue,
  LeaseClaimResult,
  NodeMutationResult,
  ParsedArgs,
  PlanGraphFile,
  ReconcileGraphResult,
  ReleaseExpiredLeasesResult,
  RenewLeaseResult,
  ResetNodeResult,
  ResetSubtreeResult,
  RunWorkerResult,
  SlackNotificationResult,
  VisualizerServerHandle
} from "./contracts.js";
import { numericArgumentRanges, parseNumericArgument } from "./numeric-args.js";

export interface DecomposeChildArg {
  id: string;
  title: string;
  kind?: string;
  status?: string;
  children?: string[];
}

export interface CliOutput {
  log(message: string): void;
}

export interface CliEnvironment {
  PLAN_GRAPH?: string;
}

export interface CliDispatchOptions {
  argv: readonly string[];
  env?: CliEnvironment;
  rootDir: string;
  defaultGraphFile?: string;
  output?: CliOutput;
  handlers: CliCommandHandlers;
}

export interface CliCommandHandlers {
  readGraph(graphPath: string): Promise<PlanGraphFile>;
  listReadyLeafNodes(graph: PlanGraphFile): unknown;
  summarizeGraph(graph: PlanGraphFile): GraphSummary;
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
  writeReportFile(graphPath: string, reportPath?: string, body?: string): Promise<void>;
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
  }): Promise<NodeMutationResult>;
  failNode(graphPath: string, options: {
    nodeId?: string;
    reason?: string;
    report?: string;
    session?: string;
    runId?: string;
  }): Promise<NodeMutationResult>;
  decomposeNode(graphPath: string, options: {
    nodeId?: string;
    kind?: string;
    children: DecomposeChildArg[];
    session?: string;
    runId?: string;
  }): Promise<DecomposeNodeResult>;
  buildWorkerPrompt(graphPath: string, options: {
    nodeId?: string;
    session?: string;
    runId?: string;
    templatePath?: string;
    cwd: string;
    reportPath?: string;
  }): Promise<string>;
  runWorker(graphPath: string, options: {
    session?: string;
    nodeId?: string;
    once: boolean;
    idleMs?: number;
    leaseSeconds?: number;
    templatePath?: string;
    cwd: string;
    stream: boolean;
    codexCommand?: string;
    codexArgs: string[];
  }): Promise<RunWorkerResult>;
  reconcileGraphStatus(graphPath: string): Promise<ReconcileGraphResult>;
  releaseExpiredLeases(graphPath: string): Promise<ReleaseExpiredLeasesResult>;
  createVisualizerServer(options: {
    graphPath: string;
    host: string;
    port: number;
    defaultWorkerCwd: string;
  }): Promise<VisualizerServerHandle>;
  renderPlanAfterUpdate(graphPath: string): Promise<void>;
  sendSlackNotification(graphPath: string, event: string, details?: Record<string, JsonValue | undefined>): Promise<SlackNotificationResult>;
}

export const cliCommands = [
  "ready",
  "summary",
  "claim",
  "start",
  "renew",
  "reset",
  "reset-subtree",
  "reset-reachable",
  "done",
  "block",
  "answer",
  "fail",
  "decompose",
  "prompt",
  "worker",
  "reconcile",
  "release-expired",
  "serve",
  "help"
] as const satisfies readonly CliCommand[];

const booleanFlags = new Set(["once", "quiet"]);
const repeatableValueFlags = new Set(["child", "codex-arg"]);

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const args: ParsedArgs = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      args._.push(arg);
      continue;
    }

    const equalsIndex = arg.indexOf("=");
    if (equalsIndex > 2) {
      const key = arg.slice(2, equalsIndex);
      const value = arg.slice(equalsIndex + 1);
      if (booleanFlags.has(key)) {
        throw new Error(`Boolean flag --${key} does not accept a value; received ${JSON.stringify(value)}`);
      }
      appendArg(args, key, value);
      continue;
    }

    const key = arg.slice(2);
    const next = argv[index + 1];
    if (booleanFlags.has(key)) {
      if (next && !next.startsWith("--")) {
        throw new Error(`Boolean flag --${key} does not accept a value; received ${JSON.stringify(next)}`);
      }
      appendArg(args, key, true);
      continue;
    }
    if (!next || next.startsWith("--")) {
      appendArg(args, key, true);
    } else {
      appendArg(args, key, next);
      index += 1;
    }
  }
  return args;
}

export function appendArg(args: ParsedArgs, key: string, value: boolean | string): void {
  if (Object.hasOwn(args, key)) {
    const current = args[key];
    args[key] = Array.isArray(current) ? [...current, value] : [current, value];
  } else {
    args[key] = value;
  }
}

export function parseChildrenArgs(args: ParsedArgs): DecomposeChildArg[] {
  if (args.child !== undefined && args["child-json"] !== undefined) {
    throw new Error("Use either --child or --child-json, not both");
  }

  const childJson = optionString(args, "child-json");
  if (childJson !== undefined) {
    let children: unknown;
    try {
      children = JSON.parse(childJson) as unknown;
    } catch (error) {
      throw new Error(`Invalid --child-json JSON: ${errorMessage(error)}`, { cause: error });
    }
    if (!Array.isArray(children)) {
      throw new Error("--child-json must be a JSON array");
    }
    if (children.length === 0) {
      throw new Error("--child-json must include at least one child");
    }
    return children.map((child, index) => parseChildJson(child, index));
  }

  const rawChildren = argValues(args.child);
  return rawChildren.map((value, childIndex) => {
    if (value === true) {
      throw new Error("Missing --child value. Use ID=Title or ID:Title");
    }
    const text = String(value);
    const separator = text.includes("=") ? "=" : ":";
    const index = text.indexOf(separator);
    if (index < 0) {
      throw new Error(`Invalid --child value: ${text}. Use ID=Title or ID:Title`);
    }
    const id = text.slice(0, index).trim();
    const title = text.slice(index + 1).trim();
    validateChildId(id, `--child #${childIndex + 1}`);
    validateChildTitle(title, `--child #${childIndex + 1}`);
    return {
      id,
      title
    };
  });
}

export function parseCodexArgs(args: ParsedArgs, codexCommand?: string): string[] {
  if (args["codex-arg"] === undefined) {
    return ["exec"];
  }
  const codexArgs = argValues(args["codex-arg"]).map((value) => {
    if (value === true) {
      throw new Error("Missing --codex-arg value. Use --codex-arg=value for values that start with '-'.");
    }
    return String(value);
  });
  if (!codexCommand && codexArgs[0]?.startsWith("-")) {
    return ["exec", ...codexArgs];
  }
  return codexArgs;
}

export function shouldStreamWorkerOutput(args: ParsedArgs): boolean {
  return !booleanArg(args, "quiet");
}

export function resolveCliGraphPath(rootDir: string, args: ParsedArgs, env: CliEnvironment = {}, defaultGraphFile = "plan.graph.json"): string {
  return resolve(rootDir, optionString(args, "graph") || env.PLAN_GRAPH || defaultGraphFile);
}

export function renderCliHelp(): string {
  return `Usage:
  node scripts/plan-scheduler.mjs ready [--graph plan.graph.json]
  node scripts/plan-scheduler.mjs summary [--graph plan.graph.json]
  node scripts/plan-scheduler.mjs claim [--session codex-A] [--node A1]
  node scripts/plan-scheduler.mjs start --node A1 [--session codex-A] [--run run_id]
  node scripts/plan-scheduler.mjs renew --node A1 [--session codex-A] [--run run_id] [--lease 1800]
  node scripts/plan-scheduler.mjs reset --node A1 [--reason "retry"]
  node scripts/plan-scheduler.mjs reset-subtree --node A1 [--reason "retry subtree"]
  node scripts/plan-scheduler.mjs reset-reachable --node A1 [--reason "retry downstream"]
  node scripts/plan-scheduler.mjs done --node A1 [--session codex-A] [--run run_id] [--report reports/A1.md] [--report-body "..."]
  node scripts/plan-scheduler.mjs block --node A1 [--session codex-A] [--run run_id] --question "Need operator decision"
  node scripts/plan-scheduler.mjs answer --node A1 --answer "Operator decision" [--responder jason]
  node scripts/plan-scheduler.mjs fail --node A1 [--session codex-A] [--run run_id] --reason "..."
  node scripts/plan-scheduler.mjs decompose --node A1 [--session codex-A] [--run run_id] --kind series --child A1a="First step" --child A1b="Second step"
  node scripts/plan-scheduler.mjs prompt --node A1 [--session codex-A] [--run run_id] [--template prompts/codex-worker-task.md]
  node scripts/plan-scheduler.mjs worker --session codex-A [--graph plan.graph.json] [--once] [--quiet] [--cwd /path/to/workspace] [--template prompts/codex-worker-task.md]
  node scripts/plan-scheduler.mjs reconcile [--graph plan.graph.json]
  node scripts/plan-scheduler.mjs release-expired
  node scripts/plan-scheduler.mjs serve [--port 8787] [--host 127.0.0.1] [--cwd /path/to/workspace]`;
}

export async function dispatchCliCommand(options: CliDispatchOptions): Promise<void> {
  const args = parseArgs(options.argv);
  const command = args._[0];
  const output = options.output || console;
  const graphPath = resolveCliGraphPath(options.rootDir, args, options.env, options.defaultGraphFile);
  const handlers = options.handlers;

  if (!command || command === "help") {
    output.log(renderCliHelp());
    return;
  }

  switch (command) {
    case "ready":
      printJson(output, handlers.listReadyLeafNodes(await handlers.readGraph(graphPath)));
      return;
    case "summary":
      printJson(output, handlers.summarizeGraph(await handlers.readGraph(graphPath)));
      return;
    case "claim": {
      const result = await handlers.claimNode(graphPath, {
        session: optionString(args, "session"),
        nodeId: optionString(args, "node"),
        leaseSeconds: numberArg(args, "lease", numericArgumentRanges.leaseSeconds)
      });
      await handlers.renderPlanAfterUpdate(graphPath);
      printJson(output, result);
      return;
    }
    case "start": {
      const result = await handlers.startNode(graphPath, {
        nodeId: requiredOptionString(args, "node", "start"),
        session: optionString(args, "session"),
        runId: optionString(args, "run")
      });
      await handlers.renderPlanAfterUpdate(graphPath);
      printJson(output, result);
      return;
    }
    case "renew": {
      const result = await handlers.renewNodeLease(graphPath, {
        nodeId: requiredOptionString(args, "node", "renew"),
        session: optionString(args, "session"),
        runId: optionString(args, "run"),
        leaseSeconds: numberArg(args, "lease", numericArgumentRanges.leaseSeconds)
      });
      await handlers.renderPlanAfterUpdate(graphPath);
      printJson(output, result);
      return;
    }
    case "reset": {
      const result = await handlers.resetNode(graphPath, { nodeId: requiredOptionString(args, "node", "reset"), reason: optionString(args, "reason") });
      await handlers.renderPlanAfterUpdate(graphPath);
      printJson(output, result);
      return;
    }
    case "reset-subtree": {
      const result = await handlers.resetSubtree(graphPath, { nodeId: requiredOptionString(args, "node", "reset-subtree"), reason: optionString(args, "reason") });
      await handlers.renderPlanAfterUpdate(graphPath);
      printJson(output, result);
      return;
    }
    case "reset-reachable": {
      const result = await handlers.resetReachable(graphPath, { nodeId: requiredOptionString(args, "node", "reset-reachable"), reason: optionString(args, "reason") });
      await handlers.renderPlanAfterUpdate(graphPath);
      printJson(output, result);
      return;
    }
    case "done": {
      const nodeId = requiredOptionString(args, "node", "done");
      await handlers.writeReportFile(graphPath, optionString(args, "report"), optionString(args, "report-body"));
      const result = await handlers.completeNode(graphPath, {
        nodeId,
        report: optionString(args, "report"),
        session: optionString(args, "session"),
        runId: optionString(args, "run")
      });
      await handlers.renderPlanAfterUpdate(graphPath);
      printJson(output, await withSlack(result, handlers.sendSlackNotification(graphPath, "done", {
        nodeId,
        report: optionString(args, "report")
      })));
      return;
    }
    case "block": {
      const nodeId = requiredOptionString(args, "node", "block");
      const result = await handlers.blockNode(graphPath, {
        nodeId,
        question: optionString(args, "question"),
        reason: optionString(args, "reason"),
        session: optionString(args, "session"),
        runId: optionString(args, "run")
      });
      await handlers.renderPlanAfterUpdate(graphPath);
      printJson(output, await withSlack(result, handlers.sendSlackNotification(graphPath, "blocked", {
        nodeId,
        question: optionString(args, "question"),
        reason: optionString(args, "reason")
      })));
      return;
    }
    case "answer": {
      const nodeId = requiredOptionString(args, "node", "answer");
      const answer = requiredOptionString(args, "answer", "answer");
      const result = await handlers.answerNode(graphPath, {
        nodeId,
        answer,
        responder: optionString(args, "responder")
      });
      await handlers.renderPlanAfterUpdate(graphPath);
      printJson(output, await withSlack(result, handlers.sendSlackNotification(graphPath, "answered", {
        nodeId,
        answer
      })));
      return;
    }
    case "fail": {
      const nodeId = requiredOptionString(args, "node", "fail");
      const result = await handlers.failNode(graphPath, {
        nodeId,
        reason: optionString(args, "reason"),
        report: optionString(args, "report"),
        session: optionString(args, "session"),
        runId: optionString(args, "run")
      });
      await handlers.renderPlanAfterUpdate(graphPath);
      printJson(output, await withSlack(result, handlers.sendSlackNotification(graphPath, "failed", {
        nodeId,
        reason: optionString(args, "reason"),
        report: optionString(args, "report")
      })));
      return;
    }
    case "decompose": {
      const nodeId = requiredOptionString(args, "node", "decompose");
      const result = await handlers.decomposeNode(graphPath, {
        nodeId,
        kind: optionString(args, "kind"),
        children: parseChildrenArgs(args),
        session: optionString(args, "session"),
        runId: optionString(args, "run")
      });
      await handlers.renderPlanAfterUpdate(graphPath);
      printJson(output, await withSlack(result, handlers.sendSlackNotification(graphPath, "decomposed", { nodeId })));
      return;
    }
    case "prompt": {
      const prompt = await handlers.buildWorkerPrompt(graphPath, {
        nodeId: requiredOptionString(args, "node", "prompt"),
        session: optionString(args, "session"),
        runId: optionString(args, "run"),
        templatePath: optionString(args, "template"),
        cwd: optionString(args, "cwd") || dirname(graphPath),
        reportPath: optionString(args, "report")
      });
      output.log(prompt);
      return;
    }
    case "worker": {
      const cwdArg = optionString(args, "cwd");
      const cwd = cwdArg ? resolve(cwdArg) : dirname(graphPath);
      const result = await handlers.runWorker(graphPath, {
        session: optionString(args, "session"),
        nodeId: optionString(args, "node"),
        once: booleanArg(args, "once"),
        idleMs: numberArg(args, "idle-ms", numericArgumentRanges.idleMs),
        leaseSeconds: numberArg(args, "lease", numericArgumentRanges.leaseSeconds),
        templatePath: optionString(args, "template"),
        cwd,
        stream: shouldStreamWorkerOutput(args),
        codexCommand: optionString(args, "codex-command"),
        codexArgs: parseCodexArgs(args, optionString(args, "codex-command"))
      });
      printJson(output, result);
      return;
    }
    case "reconcile": {
      const result = await handlers.reconcileGraphStatus(graphPath);
      await handlers.renderPlanAfterUpdate(graphPath);
      printJson(output, result);
      return;
    }
    case "release-expired": {
      const result = await handlers.releaseExpiredLeases(graphPath);
      await handlers.renderPlanAfterUpdate(graphPath);
      printJson(output, result);
      return;
    }
    case "serve": {
      const cwdArg = optionString(args, "cwd");
      const visualizer = await handlers.createVisualizerServer({
        graphPath,
        host: optionString(args, "host") || "127.0.0.1",
        port: numberArg(args, "port", numericArgumentRanges.port) ?? 8787,
        defaultWorkerCwd: cwdArg ? resolve(cwdArg) : dirname(graphPath)
      });
      if (visualizer.securityWarning) {
        output.log(visualizer.securityWarning);
      }
      output.log(`Plan scheduler visualizer: ${visualizer.url}`);
      return;
    }
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

function parseChildJson(child: unknown, index: number): DecomposeChildArg {
  const location = `--child-json[${index}]`;
  if (!child || typeof child !== "object") {
    throw new Error(`${location} must be an object`);
  }
  const entry = child as Record<string, unknown>;
  if (typeof entry.id !== "string" || typeof entry.title !== "string") {
    throw new Error(`${location} must include string id and title`);
  }
  const id = entry.id.trim();
  const title = entry.title.trim();
  validateChildId(id, location);
  validateChildTitle(title, location);
  const result: DecomposeChildArg = { id, title };
  if (typeof entry.kind === "string") {
    result.kind = entry.kind;
  }
  if (typeof entry.status === "string") {
    result.status = entry.status;
  }
  if (Array.isArray(entry.children)) {
    result.children = entry.children.map((childId, childIndex) => {
      if (typeof childId !== "string") {
        throw new Error(`${location}.children[${childIndex}] must be a string`);
      }
      const normalizedChildId = childId.trim();
      if (!normalizedChildId) {
        throw new Error(`${location}.children[${childIndex}] cannot be empty`);
      }
      return normalizedChildId;
    });
  }
  return result;
}

function argValues(value: ParsedArgs[string]): (boolean | string)[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function optionString(args: ParsedArgs, key: string): string | undefined {
  const values = argValues(args[key]);
  if (values.length === 0) {
    return undefined;
  }
  if (!repeatableValueFlags.has(key) && values.length > 1) {
    throw new Error(`Option --${key} can only be provided once`);
  }
  const raw = values[values.length - 1];
  if (raw === true) {
    throw new Error(`Missing --${key} value`);
  }
  return String(raw);
}

function requiredOptionString(args: ParsedArgs, key: string, command: string): string {
  const value = optionString(args, key);
  if (value === undefined || value.trim() === "") {
    throw new Error(`${command} requires --${key}`);
  }
  return value;
}

function booleanArg(args: ParsedArgs, key: string): boolean {
  const values = argValues(args[key]);
  if (values.length === 0) {
    return false;
  }
  if (values.length > 1) {
    throw new Error(`Option --${key} can only be provided once`);
  }
  if (values[0] !== true) {
    throw new Error(`Boolean flag --${key} does not accept a value; received ${JSON.stringify(String(values[0]))}`);
  }
  return true;
}

function numberArg(
  args: ParsedArgs,
  key: string,
  options: Omit<Parameters<typeof parseNumericArgument>[1], "flag">
): number | undefined {
  const values = argValues(args[key]);
  if (values.length > 1) {
    throw new Error(`Option --${key} can only be provided once`);
  }
  return parseNumericArgument(args[key], { flag: `--${key}`, ...options });
}

function validateChildId(id: string, location: string): void {
  if (!id) {
    throw new Error(`${location} id cannot be empty`);
  }
}

function validateChildTitle(title: string, location: string): void {
  if (!title) {
    throw new Error(`${location} title cannot be empty`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function printJson(output: CliOutput, value: unknown): void {
  output.log(JSON.stringify(value, null, 2));
}

async function withSlack<T extends object>(result: T, slack: Promise<SlackNotificationResult>): Promise<T & { slack: SlackNotificationResult }> {
  return { ...result, slack: await slack };
}
