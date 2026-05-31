import { lstat, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isRecord, validatePlanGraphFileResult } from "./contracts.js";
import type {
  CliCommand,
  DecomposeNodeResult,
  GraphDiagnostics,
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
import { buildGoalGraph } from "./goal-graph.js";
import { numericArgumentRanges, parseNumericArgument } from "./numeric-args.js";
import { exportOperationalEvents, operationalEvents } from "./operational-events.js";
import { errorMessage, safeFilePart } from "./shared-utils.js";

export { buildGoalGraph } from "./goal-graph.js";

export interface DecomposeChildArg {
  id: string;
  title: string;
  kind?: string;
  status?: string;
  children?: string[];
  [metadata: string]: unknown;
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
  writeGraphFile(graphPath: string, graph: PlanGraphFile): Promise<void>;
  listReadyLeafNodes(graph: PlanGraphFile): unknown;
  summarizeGraph(graph: PlanGraphFile): GraphSummary;
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
    isolation?: string;
    remote?: string;
    workspaceRoot?: string;
    workspaceRetention?: string;
    once: boolean;
    idleMs?: number;
    timeoutMs?: number;
    leaseSeconds?: number;
    templatePath?: string;
    cwd?: string;
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
    writeToken?: string;
    allowUnsafeWrites?: boolean;
  }): Promise<VisualizerServerHandle>;
  renderPlanAfterUpdate(graphPath: string): Promise<void>;
  sendSlackNotification(graphPath: string, event: string, details?: Record<string, JsonValue | undefined>): Promise<SlackNotificationResult>;
}

export const cliCommands = [
  "plan",
  "ready",
  "summary",
  "diagnostics",
  "events",
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

const booleanFlags = new Set(["help", "once", "quiet", "unsafe-visualizer-write", "dry-run", "plan-only", "then-run"]);
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
      children = JSON.parse(childJson);
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
  node scripts/plan-scheduler.mjs <command> [flags]
  node scripts/plan-scheduler.mjs plan --goal "..."
  node scripts/plan-scheduler.mjs help
  node scripts/plan-scheduler.mjs --help

Graph selection:
  --graph PATH              Optional for every command. Default: PLAN_GRAPH, then plan.graph.json.

Commands:
  plan
    Required: --goal TEXT
    Optional: --graph PATH (output graph path), --title TEXT, --dry-run, --plan-only, --then-run, worker flags when --then-run is set
    Example: node scripts/plan-scheduler.mjs plan --goal "Ship a searchable audit log" --graph runs/goals/audit-log/plan.graph.json
    Example: node scripts/plan-scheduler.mjs plan --goal "Ship a searchable audit log" --then-run --session codex-A --once

  ready
    Required: none
    Optional: --graph PATH
    Example: node scripts/plan-scheduler.mjs ready --graph plan.graph.json

  summary
    Required: none
    Optional: --graph PATH
    Example: node scripts/plan-scheduler.mjs summary --graph plan.graph.json

  diagnostics
    Required: none
    Optional: --graph PATH
    Example: node scripts/plan-scheduler.mjs diagnostics --graph plan.graph.json

  events
    Required: none
    Optional: --graph PATH, --limit COUNT (default: 50), --node ID, --event NAME
    Example: node scripts/plan-scheduler.mjs events --graph plan.graph.json --limit 20

  claim
    Required: none
    Optional: --graph PATH, --session NAME (default: codex), --node ID, --lease SECONDS (default: graph scheduler.leaseSeconds, then 1800)
    Example: node scripts/plan-scheduler.mjs claim --session codex-A --lease 1800

  start
    Required: --node ID
    Optional: --graph PATH, --session NAME, --run RUN_ID
    Example: node scripts/plan-scheduler.mjs start --node KICKOFF --session codex-A

  renew
    Required: --node ID
    Optional: --graph PATH, --session NAME, --run RUN_ID, --lease SECONDS (default: graph scheduler.leaseSeconds, then 1800)
    Example: node scripts/plan-scheduler.mjs renew --node KICKOFF --session codex-A --lease 1800

  reset
    Required: --node ID
    Optional: --graph PATH, --reason TEXT
    Example: node scripts/plan-scheduler.mjs reset --node KICKOFF --reason "retry with fresh context"

  reset-subtree
    Required: --node ID
    Optional: --graph PATH, --reason TEXT
    Example: node scripts/plan-scheduler.mjs reset-subtree --node PHASE_2 --reason "rerun phase 2"

  reset-reachable
    Required: --node ID
    Optional: --graph PATH, --reason TEXT
    Example: node scripts/plan-scheduler.mjs reset-reachable --node TS3 --reason "rerun from TS3"

  done
    Required: --node ID
    Optional: --graph PATH, --session NAME, --run RUN_ID, --report PATH, --report-body TEXT
    Example: node scripts/plan-scheduler.mjs done --node KICKOFF --session codex-A --report reports/KICKOFF.md

  block
    Required: --node ID
    Optional: --graph PATH, --session NAME, --run RUN_ID, --question TEXT, --reason TEXT
    Example: node scripts/plan-scheduler.mjs block --node WEB1 --session codex-A --question "Need operator decision"

  answer
    Required: --node ID, --answer TEXT
    Optional: --graph PATH, --responder NAME
    Example: node scripts/plan-scheduler.mjs answer --node WEB1 --answer "Proceed with option A." --responder jason

  fail
    Required: --node ID
    Optional: --graph PATH, --session NAME, --run RUN_ID, --reason TEXT, --report PATH
    Example: node scripts/plan-scheduler.mjs fail --node WEB1 --session codex-A --reason "Tests failed"

  decompose
    Required: --node ID and --child ID=Title repeated, or --child-json JSON
    Optional: --graph PATH, --session NAME, --run RUN_ID, --kind series|parallel (default: series)
    Example: node scripts/plan-scheduler.mjs decompose --node WEB1 --session codex-A --kind series --child WEB1a="Draft shell" --child WEB1b="Review shell"

  prompt
    Required: --node ID
    Optional: --graph PATH, --session NAME, --run RUN_ID, --template PATH (default: prompts/codex-worker-task.md), --cwd PATH (default: graph directory), --report PATH
    Example: node scripts/plan-scheduler.mjs prompt --node WEB1 --session codex-A

  worker
    Required: none
    Optional: --graph PATH, --session NAME (default: codex-worker), --node ID, --once, --quiet, --cwd PATH (default: graph directory), --template PATH (default: prompts/codex-worker-task.md), --idle-ms MS (default: 5000), --timeout-ms MS, --lease SECONDS, --codex-command PATH (default: codex), --codex-arg ARG repeated (default: exec), --isolation off|git (default: off), --remote URL (default: scheduler.remote), --workspace-root PATH (default: runs/workspaces), --workspace-retention on-failure|always|never (default: on-failure)
    Example: node scripts/plan-scheduler.mjs worker --graph plan.graph.json --session codex-A --once

  reconcile
    Required: none
    Optional: --graph PATH
    Example: node scripts/plan-scheduler.mjs reconcile --graph plan.graph.json

  release-expired
    Required: none
    Optional: --graph PATH
    Example: node scripts/plan-scheduler.mjs release-expired --graph plan.graph.json

  serve
    Required: none
    Optional: --graph PATH, --port PORT (default: 8787), --host HOST (default: 127.0.0.1), --cwd PATH (default: graph directory), --visualizer-write-token TOKEN, --unsafe-visualizer-write
    Example: node scripts/plan-scheduler.mjs serve --host 127.0.0.1 --port 8787

Flag types:
  Boolean flags take no value: --help, --dry-run, --plan-only, --then-run, --once, --quiet, --unsafe-visualizer-write.
  Repeatable flags: --child ID=Title or ID:Title; --codex-arg ARG. Use --codex-arg=--flag when the value starts with "-".
  Numeric flags are integers: --lease 1..86400 seconds, --idle-ms 1..86400000, --timeout-ms 1..86400000, --port 0..65535, --limit 1..10000.
  Path flags: --graph selects the graph; for plan only, --graph is the output graph path. --report stays inside the graph directory; --template resolves from the graph directory; --cwd controls worker process cwd.
  Isolation flags: --isolation git requires scheduler.remote unless --remote URL is supplied; --workspace-root selects isolated clone placement; --workspace-retention controls clone cleanup.

Environment:
  PLAN_GRAPH                Default graph path when --graph is omitted.
  SLACK_WEBHOOK_URL         Enables notifications for done, block, answer, fail, and decompose.
  SPG_SLACK_TIMEOUT_MS      Slack notification timeout in milliseconds. Default: 5000.
  SPG_DEBUG=1               Include stack traces in CLI errors.
  SPG_GRAPH_LOCK_TIMEOUT_MS Graph lock wait timeout in milliseconds. Default: 5000.
  SPG_GIT_CACHE_LOCK_TIMEOUT_MS Git cache lock wait timeout in milliseconds. Default: 60000.`;
}

export async function dispatchCliCommand(options: CliDispatchOptions): Promise<void> {
  const args = parseArgs(options.argv);
  const command = args._[0];
  const output = options.output || console;
  const handlers = options.handlers;

  if (!command || command === "help" || booleanArg(args, "help")) {
    output.log(renderCliHelp());
    return;
  }

  if (command === "plan") {
    const goal = requiredTrimmedOptionString(args, "goal", "plan");
    const graphPath = resolvePlanGraphOutputPath(options.rootDir, args, goal);
    const graph = buildGoalGraph(goal, { title: optionString(args, "title") });
    const planOnly = booleanArg(args, "plan-only");
    const thenRun = booleanArg(args, "then-run");
    if (planOnly && thenRun) {
      throw new Error("Use either --plan-only or --then-run, not both");
    }
    if (booleanArg(args, "dry-run") && thenRun) {
      throw new Error("Cannot combine --dry-run with --then-run");
    }
    const validation = validatePlanGraphFileResult(graph);
    if (validation.errors.length > 0) {
      throw new Error(`Generated graph failed validation: ${formatGraphValidationIssues(validation.errors)}`);
    }
    const summary = handlers.summarizeGraph(graph);
    const result = {
      graphPath,
      mode: thenRun ? "plan-then-run" : "plan-only",
      dryRun: booleanArg(args, "dry-run"),
      written: false,
      rootId: summary.root,
      nodeCount: summary.totalNodes,
      nextCommands: buildPlanNextCommands(graphPath, optionString(args, "session")),
      validation: {
        valid: true,
        errors: validation.errors,
        warnings: validation.warnings
      },
      summary,
      graph,
      execution: undefined as RunWorkerResult | { failed: true; error: string } | undefined
    };
    if (result.dryRun) {
      await validateSafeGraphOutputPath(graphPath);
    } else {
      await ensureSafeGraphOutputPath(graphPath);
      await handlers.writeGraphFile(graphPath, graph);
      result.written = true;
    }
    if (thenRun) {
      try {
        result.execution = await handlers.runWorker(graphPath, {
          ...buildWorkerOptionsFromArgs(args),
          stream: false
        });
      } catch (error) {
        result.execution = { failed: true, error: errorMessage(error) };
        printJson(output, result);
        throw error;
      }
    }
    printJson(output, result);
    return;
  }

  const graphPath = resolveCliGraphPath(options.rootDir, args, options.env, options.defaultGraphFile);

  switch (command) {
    case "ready":
      printJson(output, handlers.listReadyLeafNodes(await handlers.readGraph(graphPath)));
      return;
    case "summary":
      printJson(output, handlers.summarizeGraph(await handlers.readGraph(graphPath)));
      return;
    case "diagnostics":
      printJson(output, await handlers.diagnoseGraph(graphPath));
      return;
    case "events":
      printJson(output, exportOperationalEvents(await handlers.readGraph(graphPath), {
        limit: numberArg(args, "limit", { ...numericArgumentRanges.eventLimit, defaultValue: 50 }),
        nodeId: optionString(args, "node"),
        event: optionString(args, "event")
      }));
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
      printJson(output, await withSlack(result, handlers.sendSlackNotification(graphPath, operationalEvents.done, {
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
      printJson(output, await withSlack(result, handlers.sendSlackNotification(graphPath, operationalEvents.blocked, {
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
      printJson(output, await withSlack(result, handlers.sendSlackNotification(graphPath, operationalEvents.answered, {
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
      printJson(output, await withSlack(result, handlers.sendSlackNotification(graphPath, operationalEvents.failed, {
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
      printJson(output, await withSlack(result, handlers.sendSlackNotification(graphPath, operationalEvents.decomposed, { nodeId })));
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
      const result = await handlers.runWorker(graphPath, buildWorkerOptionsFromArgs(args));
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
        defaultWorkerCwd: cwdArg ? resolve(cwdArg) : dirname(graphPath),
        writeToken: optionString(args, "visualizer-write-token"),
        allowUnsafeWrites: booleanArg(args, "unsafe-visualizer-write")
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
  if (!isRecord(child)) {
    throw new Error(`${location} must be an object`);
  }
  if (typeof child.id !== "string" || typeof child.title !== "string") {
    throw new Error(`${location} must include string id and title`);
  }
  const id = child.id.trim();
  const title = child.title.trim();
  validateChildId(id, location);
  validateChildTitle(title, location);
  const { id: _rawId, title: _rawTitle, kind, status, children, ...metadata } = child;
  const result: DecomposeChildArg = { ...metadata, id, title };
  if (typeof kind === "string") {
    result.kind = kind;
  }
  if (typeof status === "string") {
    result.status = status;
  }
  if (Array.isArray(children)) {
    result.children = children.map((childId, childIndex) => {
      if (typeof childId !== "string") {
        throw new Error(`${location}.children[${childIndex}] must be a string`);
      }
      const normalizedChildId = childId.trim();
      if (!normalizedChildId) {
        throw new Error(`${location}.children[${childIndex}] cannot be empty`);
      }
      validateChildId(normalizedChildId, `${location}.children[${childIndex}]`);
      return normalizedChildId;
    });
  }
  return result;
}

export function resolvePlanGraphOutputPath(rootDir: string, args: ParsedArgs, goal: string): string {
  const explicitGraphPath = optionString(args, "graph");
  if (explicitGraphPath !== undefined) {
    return resolve(rootDir, explicitGraphPath);
  }
  return resolve(rootDir, "runs", "goals", `${goalTimestamp()}-${goalSlug(goal)}`, "plan.graph.json");
}

async function ensureSafeGraphOutputPath(graphPath: string): Promise<void> {
  const parentDir = dirname(graphPath);
  await ensureSafeOutputDirectory(parentDir);
  await ensureGraphOutputTargetAvailable(graphPath);
}

async function validateSafeGraphOutputPath(graphPath: string): Promise<void> {
  await validateSafeOutputDirectoryAncestors(dirname(graphPath));
  await ensureGraphOutputTargetAvailable(graphPath);
}

async function ensureGraphOutputTargetAvailable(graphPath: string): Promise<void> {
  try {
    const targetStat = await lstat(graphPath);
    if (targetStat.isSymbolicLink()) {
      throw new Error(`Unsafe graph output path: target is a symbolic link: ${graphPath}`);
    }
    throw new Error(`Refusing to overwrite existing graph file: ${graphPath}`);
  } catch (error) {
    if (nodeErrorCode(error) !== "ENOENT") {
      throw error;
    }
  }
}

async function validateSafeOutputDirectoryAncestors(targetDir: string): Promise<void> {
  for (const currentPath of outputPathSegments(targetDir)) {
    try {
      const currentStat = await lstat(currentPath);
      if (currentStat.isSymbolicLink()) {
        throw new Error(`Unsafe graph output path: parent is a symbolic link: ${currentPath}`);
      }
      if (!currentStat.isDirectory()) {
        throw new Error(`Unsafe graph output path: parent is not a directory: ${currentPath}`);
      }
    } catch (error) {
      if (nodeErrorCode(error) === "ENOENT") {
        return;
      }
      throw error;
    }
  }
}

async function ensureSafeOutputDirectory(targetDir: string): Promise<void> {
  for (const currentPath of outputPathSegments(targetDir)) {
    try {
      const currentStat = await lstat(currentPath);
      if (currentStat.isSymbolicLink()) {
        throw new Error(`Unsafe graph output path: parent is a symbolic link: ${currentPath}`);
      }
      if (!currentStat.isDirectory()) {
        throw new Error(`Unsafe graph output path: parent is not a directory: ${currentPath}`);
      }
    } catch (error) {
      if (nodeErrorCode(error) !== "ENOENT") {
        throw error;
      }
      await mkdir(currentPath);
    }
  }
}

function outputPathSegments(targetDir: string): string[] {
  const resolvedDir = resolve(targetDir);
  const root = isAbsolute(resolvedDir) ? resolve("/") : "";
  let currentPath = root;
  const segments: string[] = [];
  for (const segment of relative(root, resolvedDir).split(/[\\/]+/).filter(Boolean)) {
    currentPath = currentPath ? join(currentPath, segment) : segment;
    segments.push(currentPath);
  }
  return segments;
}

function goalTimestamp(): string {
  return new Date().toISOString().replaceAll(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function goalSlug(goal: string): string {
  const normalized = goal.trim().toLowerCase().replaceAll(/[^a-z0-9._-]+/g, "-").replaceAll(/-+/g, "-").replaceAll(/^-|-$/g, "");
  const safe = safeFilePart(normalized).replaceAll(/^\.|\.$/g, "").slice(0, 80);
  return safe || "goal";
}

function buildWorkerOptionsFromArgs(args: ParsedArgs): Parameters<CliCommandHandlers["runWorker"]>[1] {
  const cwdArg = optionString(args, "cwd");
  const isolationArg = optionString(args, "isolation");
  if (cwdArg && isolationArg?.trim() === "git") {
    throw new Error("Cannot combine --cwd with --isolation git; use --workspace-root to choose isolated clone placement.");
  }
  return {
    session: optionString(args, "session"),
    nodeId: optionString(args, "node"),
    isolation: isolationArg,
    remote: optionString(args, "remote"),
    workspaceRoot: optionString(args, "workspace-root"),
    workspaceRetention: optionString(args, "workspace-retention"),
    once: booleanArg(args, "once"),
    idleMs: numberArg(args, "idle-ms", numericArgumentRanges.idleMs),
    timeoutMs: numberArg(args, "timeout-ms", numericArgumentRanges.timeoutMs),
    leaseSeconds: numberArg(args, "lease", numericArgumentRanges.leaseSeconds),
    templatePath: optionString(args, "template"),
    cwd: cwdArg ? resolve(cwdArg) : undefined,
    stream: shouldStreamWorkerOutput(args),
    codexCommand: optionString(args, "codex-command"),
    codexArgs: parseCodexArgs(args, optionString(args, "codex-command"))
  };
}

function buildPlanNextCommands(graphPath: string, session?: string): Record<string, string> {
  const graphArg = shellQuote(graphPath);
  const sessionArg = shellQuote(session || "codex-worker");
  return {
    summary: `node scripts/plan-scheduler.mjs summary --graph ${graphArg}`,
    ready: `node scripts/plan-scheduler.mjs ready --graph ${graphArg}`,
    run: `node scripts/plan-scheduler.mjs worker --graph ${graphArg} --session ${sessionArg}`,
    serve: `node scripts/plan-scheduler.mjs serve --graph ${graphArg}`
  };
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function formatGraphValidationIssues(issues: { path: string; message: string }[]): string {
  return issues.map((issue) => `${issue.path} ${issue.message}`).join("; ");
}

function nodeErrorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
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

function requiredTrimmedOptionString(args: ParsedArgs, key: string, command: string): string {
  return requiredOptionString(args, key, command).trim();
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
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) || id.includes("..")) {
    throw new Error(`${location} id contains unsafe characters: ${id}`);
  }
}

function validateChildTitle(title: string, location: string): void {
  if (!title) {
    throw new Error(`${location} title cannot be empty`);
  }
}

function printJson(output: CliOutput, value: unknown): void {
  output.log(JSON.stringify(value, null, 2));
}

async function withSlack<T extends object>(result: T, slack: Promise<SlackNotificationResult>): Promise<T & { slack: SlackNotificationResult }> {
  return { ...result, slack: await slack };
}
