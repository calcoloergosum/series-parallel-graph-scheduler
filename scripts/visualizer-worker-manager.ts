import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";

import { isRecord } from "./contracts.js";
import type {
  PublicWorker,
  StartWorkerOptions,
  WorkerLogEntry,
  WorkerManager,
  WorkerManagerProcess,
  WorkerManagerStatus
} from "./contracts.js";
import { defaultGraphPath } from "./graph-io.js";
import { redactGitRemote, validateGitRemote } from "./git-runtime.js";
import { numericArgumentRanges, parseNumericArgument } from "./numeric-args.js";
import { operationalEvents, redactOperationalEventDetails } from "./operational-events.js";
import { errorMessage, safeFilePart } from "./shared-utils.js";
import { validateWorkerWorkspaceRoot, validateWorkspaceRetention } from "./worker.js";

export interface CreateWorkerManagerOptions {
  graphPath?: string;
  defaultCwd?: string;
  onChange?: () => Promise<void> | void;
  schedulerScriptPath: string;
  rootDir: string;
}

type ManagedWorker = WorkerManagerProcess;

interface ValidatedStartWorkerOptions {
  count: number;
  sessionPrefix?: string;
  cwd?: string;
  codexCommand?: string;
  codexArgs?: string[];
  idleMs?: number;
  leaseSeconds?: number;
  templatePath?: string;
  nodeId?: string;
  quiet: boolean;
  once: boolean;
  isolation: "off" | "git";
  remote?: string;
  workspaceRoot?: string;
  workspaceRetention: "on-failure" | "always" | "never";
}

const workerStartLimits = {
  sessionPrefixLength: 64,
  nodeIdLength: 256,
  pathLength: 4096,
  remoteLength: 4096,
  commandLength: 4096,
  codexArgsLength: 64,
  codexArgLength: 4096
} as const;

const workerLogLimits = {
  entries: 25,
  textLength: 1000
} as const;

const retainedInactiveWorkers = 100;

export class WorkerStartValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerStartValidationError";
  }
}

export function createWorkerManager({
  graphPath = defaultGraphPath,
  defaultCwd,
  onChange,
  schedulerScriptPath,
  rootDir
}: CreateWorkerManagerOptions): WorkerManager {
  const workers = new Map<string, ManagedWorker>();
  let counter = 0;

  function nextWorkerId(): string {
    counter += 1;
    return `worker-${Date.now()}-${counter}`;
  }

  function nextSession(prefix?: string): string {
    const base = safeFilePart(prefix || "codex");
    let index = 1;
    const existing = new Set([...workers.values()].map((worker) => worker.session));
    while (existing.has(`${base}-${String(index).padStart(2, "0")}`)) {
      index += 1;
    }
    return `${base}-${String(index).padStart(2, "0")}`;
  }

  function appendLog(worker: ManagedWorker, stream: WorkerLogEntry["stream"], chunk: Buffer | string): void {
    const rawText = String(chunk);
    const redacted = redactOperationalEventDetails({ text: rawText }).text;
    const fullText = typeof redacted === "string" ? redacted : rawText;
    const truncated = fullText.length > workerLogLimits.textLength;
    const entry: WorkerLogEntry = {
      at: new Date().toISOString(),
      stream,
      text: truncated ? fullText.slice(-workerLogLimits.textLength) : fullText
    };
    if (truncated) {
      entry.truncated = true;
      entry.originalLength = fullText.length;
      entry.originalBytes = Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(chunk);
    }
    worker.logTail.push(entry);
    if (worker.logTail.length > workerLogLimits.entries) {
      worker.logTail.splice(0, worker.logTail.length - workerLogLimits.entries);
    }
  }

  function finishWorker(worker: ManagedWorker): void {
    worker.finishedAt = new Date().toISOString();
    worker.durationMs = durationMs(worker);
    delete worker.child;
    pruneWorkers();
  }

  function pruneWorkers(): void {
    const inactive = [...workers.values()]
      .filter((worker) => worker.status !== "running" && worker.status !== "stopping")
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
    const removeCount = inactive.length - retainedInactiveWorkers;
    for (const worker of removeCount > 0 ? inactive.slice(0, removeCount) : []) {
      workers.delete(worker.id);
    }
  }

  function exitFailureReason(worker: ManagedWorker, code: number | null, signal: NodeJS.Signals | null): string | undefined {
    if (worker.status === "stopping") {
      return undefined;
    }
    if (code !== null && code !== 0) {
      return `Exited with code ${code}`;
    }
    if (signal) {
      return `Terminated by ${signal}`;
    }
    return undefined;
  }

  function notify(): void {
    Promise.resolve(onChange?.()).catch(() => {});
  }

  function startWorkers(options: StartWorkerOptions = {}): PublicWorker[] {
    const validated = validateStartWorkerOptions(options);
    const workspaceRoot = validateManagedWorkerWorkspaceRoot(graphPath, validated.workspaceRoot, rootDir);
    const started: PublicWorker[] = [];
    for (let index = 0; index < validated.count; index += 1) {
      const id = nextWorkerId();
      const session = nextSession(validated.sessionPrefix);
      const cwd = resolve(validated.cwd || defaultCwd || dirname(graphPath));
      const workerArgs = [
        schedulerScriptPath,
        "worker",
        "--graph",
        graphPath,
        "--session",
        session
      ];
      if (validated.isolation === "git") {
        workerArgs.push("--isolation", "git");
        if (validated.remote) {
          workerArgs.push("--remote", validated.remote);
        }
        workerArgs.push("--workspace-root", workspaceRoot);
        workerArgs.push("--workspace-retention", validated.workspaceRetention);
      } else {
        workerArgs.push("--cwd", cwd);
      }

      if (validated.once) {
        workerArgs.push("--once");
      }
      if (validated.quiet) {
        workerArgs.push("--quiet");
      }
      if (validated.nodeId) {
        workerArgs.push("--node", validated.nodeId);
      }
      if (validated.idleMs !== undefined) {
        workerArgs.push("--idle-ms", String(validated.idleMs));
      }
      if (validated.leaseSeconds !== undefined) {
        workerArgs.push("--lease", String(validated.leaseSeconds));
      }
      if (validated.templatePath) {
        workerArgs.push("--template", validated.templatePath);
      }
      if (validated.codexCommand) {
        workerArgs.push("--codex-command", validated.codexCommand);
      }

      const codexArgs = validated.codexArgs && validated.codexArgs.length > 0
        ? validated.codexArgs
        : ["exec"];
      for (const arg of codexArgs) {
        workerArgs.push("--codex-arg", arg);
      }

      const child = spawn(process.execPath, workerArgs, {
        cwd: rootDir,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"]
      });
      const worker: ManagedWorker = {
        id,
        session,
        pid: child.pid,
        status: "running",
        cwd: validated.isolation === "git" ? workspaceRoot : cwd,
        isolation: validated.isolation,
        remote: validated.remote ? redactGitRemote(validated.remote) : undefined,
        workspaceRoot: validated.isolation === "git" ? workspaceRoot : undefined,
        workspaceRetention: validated.isolation === "git" ? validated.workspaceRetention : undefined,
        startedAt: new Date().toISOString(),
        command: process.execPath,
        args: workerArgs,
        child,
        logTail: []
      };
      workers.set(id, worker);
      appendLog(worker, "event", JSON.stringify({
        event: operationalEvents.workerStarted,
        workerId: id,
        session,
        pid: child.pid,
        cwd
      }));
      started.push(publicWorker(worker));

      child.stdout?.on("data", (chunk: Buffer) => {
        appendLog(worker, "stdout", chunk);
        notify();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        appendLog(worker, "stderr", chunk);
        notify();
      });
      child.on("error", (error) => {
        worker.status = "error";
        worker.error = error.message;
        worker.recentFailureReason = error.message;
        appendLog(worker, "event", JSON.stringify({
          event: operationalEvents.workerStopped,
          workerId: worker.id,
          session: worker.session,
          error: error.message
        }));
        finishWorker(worker);
        notify();
      });
      child.on("exit", (code, signal) => {
        const reason = worker.recentFailureReason || exitFailureReason(worker, code, signal);
        worker.status = reason ? "error" : "exited";
        worker.exitCode = code;
        worker.signal = signal;
        if (reason) {
          worker.recentFailureReason = reason;
          worker.error ||= reason;
        }
        appendLog(worker, "event", JSON.stringify({
          event: operationalEvents.workerStopped,
          workerId: worker.id,
          session: worker.session,
          exitCode: code,
          signal
        }));
        finishWorker(worker);
        notify();
      });
    }

    notify();
    return started;
  }

  function stopWorker(id: string): PublicWorker {
    const worker = workers.get(id);
    if (!worker) {
      throw new Error(`Unknown worker: ${id}`);
    }
    if (worker.child && worker.status === "running") {
      worker.status = "stopping";
      worker.stoppingAt = new Date().toISOString();
      appendLog(worker, "event", JSON.stringify({
        event: operationalEvents.workerStopped,
        workerId: worker.id,
        session: worker.session,
        signal: "SIGTERM"
      }));
      worker.child.kill("SIGTERM");
    }
    notify();
    return publicWorker(worker);
  }

  function stopAll(): PublicWorker[] {
    const stopped: PublicWorker[] = [];
    for (const worker of workers.values()) {
      if (worker.child && worker.status === "running") {
        worker.status = "stopping";
        worker.stoppingAt = new Date().toISOString();
        appendLog(worker, "event", JSON.stringify({
          event: operationalEvents.workerStopped,
          workerId: worker.id,
          session: worker.session,
          signal: "SIGTERM"
        }));
        worker.child.kill("SIGTERM");
      }
      stopped.push(publicWorker(worker));
    }
    notify();
    return stopped;
  }

  function status(): WorkerManagerStatus {
    pruneWorkers();
    const snapshots = [...workers.values()]
      .map(publicWorker)
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
    const counts = countWorkerStatuses(snapshots);
    return {
      defaults: {
        cwd: defaultCwd || dirname(graphPath),
        sessionPrefix: "codex",
        codexCommand: "codex",
        isolation: "off",
        workspaceRoot: "runs/workspaces",
        workspaceRetention: "on-failure"
      },
      running: counts.running,
      stopping: counts.stopping,
      exited: counts.exited,
      error: counts.error,
      retainedWorkers: snapshots.length,
      totalStarted: counter,
      recentFailureReason: [...snapshots].reverse().find((worker) => worker.recentFailureReason)?.recentFailureReason,
      workers: snapshots
    };
  }

  return { startWorkers, stopWorker, stopAll, status };
}

export function validateStartWorkerOptions(options: unknown): ValidatedStartWorkerOptions {
  if (!isRecord(options)) {
    throw new WorkerStartValidationError("Worker start request body must be a JSON object");
  }

  const countValue = numericStartField(options, "count", "--count");
  const idleMsValue = numericStartField(options, "idleMs", "--idle-ms");
  const leaseSecondsValue = numericStartField(options, "leaseSeconds", "--lease");
  const isolation = validateStartIsolation(options.isolation);
  const remote = optionalBoundedString(options, "remote", workerStartLimits.remoteLength);
  if (remote !== undefined) {
    validateManagedRemote(remote);
  }

  return {
    count: parseNumericArgument(countValue, { flag: "--count", ...numericArgumentRanges.workerCount, defaultValue: 1 })!,
    idleMs: parseNumericArgument(idleMsValue, { flag: "--idle-ms", ...numericArgumentRanges.idleMs }),
    leaseSeconds: parseNumericArgument(leaseSecondsValue, { flag: "--lease", ...numericArgumentRanges.leaseSeconds }),
    sessionPrefix: optionalBoundedString(options, "sessionPrefix", workerStartLimits.sessionPrefixLength),
    cwd: optionalBoundedString(options, "cwd", workerStartLimits.pathLength),
    codexCommand: optionalBoundedString(options, "codexCommand", workerStartLimits.commandLength),
    codexArgs: optionalStringArray(options, "codexArgs", {
      maxLength: workerStartLimits.codexArgsLength,
      maxItemLength: workerStartLimits.codexArgLength
    }),
    templatePath: optionalBoundedString(options, "templatePath", workerStartLimits.pathLength),
    nodeId: optionalBoundedString(options, "nodeId", workerStartLimits.nodeIdLength),
    quiet: optionalBoolean(options, "quiet"),
    once: optionalBoolean(options, "once"),
    isolation,
    remote,
    workspaceRoot: optionalBoundedString(options, "workspaceRoot", workerStartLimits.pathLength),
    workspaceRetention: validateManagedWorkspaceRetention(options.workspaceRetention)
  };
}

function validateStartIsolation(value: unknown): "off" | "git" {
  if (value === undefined || value === null || value === "") {
    return "off";
  }
  if (typeof value !== "string") {
    throw new WorkerStartValidationError("Invalid isolation: expected off or git");
  }
  const normalized = value.trim();
  if (normalized === "off" || normalized === "git") {
    return normalized;
  }
  throw new WorkerStartValidationError(`Invalid isolation: expected off or git; received ${JSON.stringify(value)}`);
}

function validateManagedRemote(remote: string): void {
  try {
    validateGitRemote(remote);
  } catch (error) {
    throw new WorkerStartValidationError(errorMessage(error));
  }
}

function validateManagedWorkspaceRetention(value: unknown): "on-failure" | "always" | "never" {
  try {
    return validateWorkspaceRetention(value);
  } catch (error) {
    throw new WorkerStartValidationError(errorMessage(error).replace(/^Invalid --workspace-retention:/, "Invalid workspaceRetention:"));
  }
}

function validateManagedWorkerWorkspaceRoot(graphPath: string, workspaceRoot: string | undefined, rootDir: string): string {
  try {
    return validateWorkerWorkspaceRoot(graphPath, workspaceRoot, rootDir);
  } catch (error) {
    throw new WorkerStartValidationError(errorMessage(error).replace(/^Invalid --workspace-root:/, "Invalid workspaceRoot:"));
  }
}

function numericStartField(
  body: Record<string, unknown>,
  field: string,
  flag: string
): string | number | undefined {
  const value = body[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" && typeof value !== "number") {
    throw new WorkerStartValidationError(`Invalid ${flag}: expected number or numeric string`);
  }
  return value;
}

function optionalBoundedString(body: Record<string, unknown>, field: string, maxLength: number): string | undefined {
  const value = body[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new WorkerStartValidationError(`Invalid ${field}: expected string`);
  }
  if (!value.trim()) {
    throw new WorkerStartValidationError(`Invalid ${field}: expected non-empty string`);
  }
  if (value.length > maxLength) {
    throw new WorkerStartValidationError(`Invalid ${field}: expected string length <= ${maxLength}`);
  }
  if (value.includes("\0")) {
    throw new WorkerStartValidationError(`Invalid ${field}: null bytes are not allowed`);
  }
  return value;
}

function optionalStringArray(
  body: Record<string, unknown>,
  field: string,
  { maxLength, maxItemLength }: { maxLength: number; maxItemLength: number }
): string[] | undefined {
  const value = body[field];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new WorkerStartValidationError(`Invalid ${field}: expected string array`);
  }
  if (value.length > maxLength) {
    throw new WorkerStartValidationError(`Invalid ${field}: expected at most ${maxLength} entries`);
  }
  return value.map((item, index) => {
    if (typeof item !== "string") {
      throw new WorkerStartValidationError(`Invalid ${field}[${index}]: expected string`);
    }
    if (item.length > maxItemLength) {
      throw new WorkerStartValidationError(`Invalid ${field}[${index}]: expected string length <= ${maxItemLength}`);
    }
    if (item.includes("\0")) {
      throw new WorkerStartValidationError(`Invalid ${field}[${index}]: null bytes are not allowed`);
    }
    return item;
  });
}

function optionalBoolean(body: Record<string, unknown>, field: string): boolean {
  const value = body[field];
  if (value === undefined) {
    return false;
  }
  if (typeof value !== "boolean") {
    throw new WorkerStartValidationError(`Invalid ${field}: expected boolean`);
  }
  return value;
}

function publicWorker(worker: ManagedWorker): PublicWorker {
  return {
    id: worker.id,
    session: worker.session,
    pid: worker.pid,
    status: worker.status,
    cwd: worker.cwd,
    isolation: worker.isolation,
    remote: worker.remote,
    workspaceRoot: worker.workspaceRoot,
    workspaceRetention: worker.workspaceRetention,
    startedAt: worker.startedAt,
    finishedAt: worker.finishedAt,
    stoppingAt: worker.stoppingAt,
    durationMs: durationMs(worker),
    exitCode: worker.exitCode,
    signal: worker.signal,
    error: worker.error,
    recentFailureReason: worker.recentFailureReason,
    logTail: worker.logTail
  };
}

function durationMs(worker: ManagedWorker): number {
  const end = worker.finishedAt ? Date.parse(worker.finishedAt) : Date.now();
  return Math.max(0, end - Date.parse(worker.startedAt));
}

function countWorkerStatuses(workers: PublicWorker[]): Pick<WorkerManagerStatus, "running" | "stopping" | "exited" | "error"> {
  return {
    running: workers.filter((worker) => worker.status === "running").length,
    stopping: workers.filter((worker) => worker.status === "stopping").length,
    exited: workers.filter((worker) => worker.status === "exited").length,
    error: workers.filter((worker) => worker.status === "error").length
  };
}
