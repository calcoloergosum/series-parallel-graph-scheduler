import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
  assertPlanGraphFile,
  isRecord,
  validatePlanGraphFileResult,
  type GraphLockDiagnostics,
  type GraphLockOwnerMetadata,
  type GraphValidationIssue,
  type PlanGraphFile
} from "./contracts.js";
import { runtimePathsFromModuleUrl } from "./runtime-paths.js";
import { errorMessage, safeFilePart, sleep } from "./shared-utils.js";

const { rootDir } = runtimePathsFromModuleUrl(import.meta.url);
export const defaultGraphPath = resolve(rootDir, "plan.graph.json");

export interface GraphLockOptions {
  lockPath?: string;
  staleMs?: number;
  retryMs?: number;
  timeoutMs?: number;
  heartbeatMs?: number;
}

export type GraphIoFaultInjectionPoint =
  | "before-atomic-temp-open"
  | "before-atomic-file-sync"
  | "before-atomic-rename"
  | "before-lock-release";

export type GraphIoFaultInjector = (point: GraphIoFaultInjectionPoint, context: { graphPath?: string; targetPath?: string; tempPath?: string; lockPath?: string }) => Promise<void> | void;

interface GraphLockMetadata {
  lockVersion: 1;
  ownerId: string;
  pid: number;
  host: string;
  createdAt: string;
  updatedAt: string;
  graphPath: string;
}

interface PartialGraphLockMetadata {
  lockVersion?: number;
  ownerId?: string;
  pid: number;
  host?: string;
  createdAt: string;
  updatedAt?: string;
  graphPath: string;
}

let graphIoFaultInjector: GraphIoFaultInjector | undefined;

export function installGraphIoFaultInjectorForTests(injector: GraphIoFaultInjector | undefined): () => void {
  const previousInjector = graphIoFaultInjector;
  graphIoFaultInjector = injector;
  return () => {
    graphIoFaultInjector = previousInjector;
  };
}

export async function readGraph(graphPath = defaultGraphPath): Promise<PlanGraphFile> {
  const content = await readFile(graphPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`Failed to parse graph file ${graphPath}: ${errorMessage(error)}`, { cause: error });
  }

  const validation = validatePlanGraphFileResult(parsed);
  if (validation.errors.length > 0) {
    throw new Error(`Invalid graph file ${graphPath}: ${formatGraphValidationIssues(validation.errors)}`);
  }

  assertPlanGraphFile(parsed);
  return parsed;
}

export async function writeGraphAtomic(graph: unknown, graphPath = defaultGraphPath): Promise<void> {
  const serialized = JSON.stringify(graph, null, 2);
  if (serialized === undefined) {
    throw new Error(`Cannot write graph file ${graphPath}: value is not JSON-serializable`);
  }
  await writeTextFileAtomic(graphPath, `${serialized}\n`);
}

export async function writeTextFileAtomic(targetPath: string, content: string): Promise<void> {
  const targetDir = dirname(targetPath);
  const tempPath = join(targetDir, `.${basename(targetPath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let shouldCleanupTemp = false;

  try {
    await injectGraphIoFault("before-atomic-temp-open", { targetPath, tempPath });
    handle = await open(tempPath, "wx");
    shouldCleanupTemp = true;
    await handle.writeFile(content, "utf8");
    await injectGraphIoFault("before-atomic-file-sync", { targetPath, tempPath });
    await handle.sync();
    await handle.close();
    handle = undefined;
    await injectGraphIoFault("before-atomic-rename", { targetPath, tempPath });
    await rename(tempPath, targetPath);
    shouldCleanupTemp = false;
    await syncDirectoryBestEffort(targetDir);
  } catch (error) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // Preserve the original write failure.
      }
    }
    if (shouldCleanupTemp) {
      try {
        await rm(tempPath, { force: true });
      } catch {
        // Temp-file cleanup is best-effort; callers still receive the write failure.
      }
    }
    throw error;
  }
}

export async function withGraphLock<T>(
  graphPath: string,
  fn: () => Promise<T> | T,
  options: GraphLockOptions = {}
): Promise<T> {
  const lockPath = options.lockPath || `${graphPath}.lock`;
  const staleMs = options.staleMs ?? 10 * 60 * 1000;
  const retryMs = options.retryMs ?? envInteger("SPG_GRAPH_LOCK_RETRY_MS") ?? 100;
  const timeoutMs = options.timeoutMs ?? envInteger("SPG_GRAPH_LOCK_TIMEOUT_MS") ?? 5000;
  const heartbeatMs = options.heartbeatMs ?? Math.max(100, Math.min(5000, Math.floor(staleMs / 3)));
  const startedAt = Date.now();
  const acquiredMetadata = createLockMetadata(graphPath);

  while (true) {
    let lockMetadata: PartialGraphLockMetadata | undefined;
    try {
      await mkdir(lockPath);
      try {
        await writeLockMetadata(lockPath, acquiredMetadata);
      } catch (metadataError) {
        await rm(lockPath, { recursive: true, force: true });
        throw metadataError;
      }
      break;
    } catch (error) {
      if (nodeErrorCode(error) !== "EEXIST") {
        throw error;
      }

      try {
        lockMetadata = await readLockMetadata(lockPath);
        const lockStat = await stat(lockPath);
        if (Date.now() - lockStat.mtimeMs > staleMs) {
          try {
            await reapStaleLock(lockPath, staleMs, lockMetadata);
          } catch (removeError) {
            throw new Error(
              `Failed to remove stale graph lock: ${lockPath}${formatLockMetadata(lockMetadata)}`,
              { cause: removeError }
            );
          }
          continue;
        }
      } catch (statError) {
        if (nodeErrorCode(statError) !== "ENOENT") {
          throw statError;
        }
      }

      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(
          `Timed out waiting for graph lock: ${lockPath}${formatLockMetadata(lockMetadata)} ` +
          `(timeoutMs=${timeoutMs}, staleMs=${staleMs}). ` +
          `Next steps: wait for the owner process to finish, run diagnostics --graph ${graphPath}, or inspect ${lockMetadataPath(lockPath)} before removing a stale lock directory.`
        );
      }

      await sleep(retryMs);
    }
  }

  const heartbeat = startLockHeartbeat(lockPath, acquiredMetadata, heartbeatMs);
  try {
    return await fn();
  } finally {
    heartbeat.stop();
    await injectGraphIoFault("before-lock-release", { graphPath, lockPath });
    await releaseOwnedLock(lockPath, acquiredMetadata.ownerId);
  }
}

export async function inspectGraphLock(
  graphPath: string,
  options: Pick<GraphLockOptions, "lockPath" | "staleMs"> = {}
): Promise<GraphLockDiagnostics> {
  const lockPath = options.lockPath || `${graphPath}.lock`;
  const staleMs = options.staleMs ?? 10 * 60 * 1000;
  try {
    const lockStat = await stat(lockPath);
    const ageMs = Math.max(0, Date.now() - lockStat.mtimeMs);
    const owner = normalizeLockOwner(await readLockMetadata(lockPath));
    const stale = ageMs > staleMs;
    return {
      path: lockPath,
      exists: true,
      staleMs,
      ageMs,
      stale,
      ...(owner ? { owner } : {}),
      nextSteps: stale
        ? [
          "Verify the owner pid/host is no longer active.",
          "Rerun the scheduler command so stale-lock reaping can proceed, or remove the lock directory only after confirming it is stale."
        ]
        : [
          "Wait for the owning scheduler, renderer, or worker process to finish.",
          "If the process is gone, wait until the stale threshold passes or inspect the lock metadata before manual cleanup."
        ]
    };
  } catch (error) {
    if (nodeErrorCode(error) !== "ENOENT") {
      throw error;
    }
    return {
      path: lockPath,
      exists: false,
      staleMs,
      stale: false,
      nextSteps: ["No graph lock is present."]
    };
  }
}

export async function writeReportFile(
  graphPath: string,
  reportPath: string | undefined,
  reportBody: unknown
): Promise<string | undefined> {
  if (!reportPath || reportBody === undefined) {
    return undefined;
  }

  const resolvedPath = resolveGraphRelativePath(graphPath, reportPath);
  await ensureContainedDirectory(dirname(graphPath), dirname(resolvedPath), reportPath);
  await ensureContainedFileTarget(resolvedPath, reportPath);
  await writeFile(resolvedPath, `${String(reportBody).replace(/\s*$/, "")}\n`, "utf8");
  return resolvedPath;
}

export function resolveGraphRelativePath(graphPath: string, targetPath: string): string {
  const baseDir = dirname(graphPath);
  const resolvedPath = isAbsolute(targetPath) ? resolve(targetPath) : resolve(baseDir, targetPath);
  const pathFromBase = relative(baseDir, resolvedPath);
  if (pathFromBase.startsWith("..") || isAbsolute(pathFromBase)) {
    throw new Error(`Path escapes graph directory: ${targetPath}`);
  }
  return resolvedPath;
}

async function ensureContainedDirectory(baseDir: string, targetDir: string, originalPath: string): Promise<void> {
  const pathFromBase = relative(baseDir, targetDir);
  if (!pathFromBase) {
    return;
  }

  let currentPath = baseDir;
  for (const segment of pathFromBase.split(/[\\/]+/).filter(Boolean)) {
    currentPath = join(currentPath, segment);
    try {
      const currentStat = await lstat(currentPath);
      if (currentStat.isSymbolicLink()) {
        throw new Error(`Path escapes graph directory through symbolic link: ${originalPath}`);
      }
      if (!currentStat.isDirectory()) {
        throw new Error(`Report path parent is not a directory: ${originalPath}`);
      }
    } catch (error) {
      if (nodeErrorCode(error) !== "ENOENT") {
        throw error;
      }
      await mkdir(currentPath);
    }
  }
}

async function ensureContainedFileTarget(resolvedPath: string, originalPath: string): Promise<void> {
  try {
    const targetStat = await lstat(resolvedPath);
    if (targetStat.isSymbolicLink()) {
      throw new Error(`Path escapes graph directory through symbolic link: ${originalPath}`);
    }
    if (!targetStat.isFile()) {
      throw new Error(`Report path target is not a file: ${originalPath}`);
    }
  } catch (error) {
    if (nodeErrorCode(error) !== "ENOENT") {
      throw error;
    }
  }
}

export function defaultReportPath(nodeId: string, runId: string): string {
  return `reports/${safeFilePart(nodeId)}-${safeFilePart(runId)}.md`;
}

function createLockMetadata(graphPath: string): GraphLockMetadata {
  const now = new Date().toISOString();
  return {
    lockVersion: 1,
    ownerId: randomUUID(),
    pid: process.pid,
    host: localHostname(),
    createdAt: now,
    updatedAt: now,
    graphPath
  };
}

async function writeLockMetadata(lockPath: string, metadata: GraphLockMetadata): Promise<void> {
  const tempPath = join(lockPath, `metadata.${metadata.ownerId}.${Date.now()}.tmp`);
  await writeFile(tempPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  await rename(tempPath, lockMetadataPath(lockPath));
}

async function readLockMetadata(lockPath: string): Promise<PartialGraphLockMetadata | undefined> {
  try {
    const metadata: unknown = JSON.parse(await readFile(lockMetadataPath(lockPath), "utf8"));
    if (!isRecord(metadata)) {
      return undefined;
    }
    if (
      typeof metadata.pid !== "number" ||
      typeof metadata.createdAt !== "string" ||
      typeof metadata.graphPath !== "string"
    ) {
      return undefined;
    }
    return {
      ...(metadata.lockVersion === 1 ? { lockVersion: metadata.lockVersion } : {}),
      ...(typeof metadata.ownerId === "string" ? { ownerId: metadata.ownerId } : {}),
      pid: metadata.pid,
      ...(typeof metadata.host === "string" ? { host: metadata.host } : {}),
      createdAt: metadata.createdAt,
      ...(typeof metadata.updatedAt === "string" ? { updatedAt: metadata.updatedAt } : {}),
      graphPath: metadata.graphPath
    };
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") {
      return undefined;
    }
    return undefined;
  }
}

async function reapStaleLock(
  lockPath: string,
  staleMs: number,
  observedMetadata: PartialGraphLockMetadata | undefined
): Promise<void> {
  const reaperLockPath = `${lockPath}.reaper`;
  try {
    await mkdir(reaperLockPath);
  } catch (error) {
    if (nodeErrorCode(error) === "EEXIST") {
      return;
    }
    throw error;
  }

  try {
    const currentMetadata = await readLockMetadata(lockPath);
    const lockStat = await stat(lockPath);
    if (Date.now() - lockStat.mtimeMs <= staleMs || !sameObservedOwner(observedMetadata, currentMetadata)) {
      return;
    }

    const quarantinePath = `${lockPath}.reap.${process.pid}.${Date.now()}.${randomUUID()}`;
    await rename(lockPath, quarantinePath);
    await rm(quarantinePath, { recursive: true, force: true });
  } catch (error) {
    if (nodeErrorCode(error) !== "ENOENT") {
      throw error;
    }
  } finally {
    await rm(reaperLockPath, { recursive: true, force: true });
  }
}

function sameObservedOwner(
  observed: PartialGraphLockMetadata | undefined,
  current: PartialGraphLockMetadata | undefined
): boolean {
  if (!observed || !current) {
    return observed === current;
  }
  if (observed.ownerId || current.ownerId) {
    return observed.ownerId === current.ownerId;
  }
  return observed.pid === current.pid &&
    observed.host === current.host &&
    observed.createdAt === current.createdAt &&
    observed.graphPath === current.graphPath;
}

function startLockHeartbeat(lockPath: string, metadata: GraphLockMetadata, heartbeatMs: number): { stop: () => void } {
  if (!Number.isFinite(heartbeatMs) || heartbeatMs <= 0) {
    return { stop: () => undefined };
  }

  let stopped = false;
  let refreshing = false;
  const refresh = async () => {
    if (stopped || refreshing) {
      return;
    }
    refreshing = true;
    try {
      const currentMetadata = await readLockMetadata(lockPath);
      if (currentMetadata?.ownerId !== metadata.ownerId) {
        stopped = true;
        return;
      }
      metadata.updatedAt = new Date().toISOString();
      await writeLockMetadata(lockPath, metadata);
      const now = new Date();
      await utimes(lockPath, now, now);
    } catch {
      // Heartbeat refresh is best-effort; waiters still fail with bounded diagnostics.
    } finally {
      refreshing = false;
    }
  };

  const interval = setInterval(() => {
    void refresh();
  }, heartbeatMs);
  interval.unref?.();

  return {
    stop: () => {
      stopped = true;
      clearInterval(interval);
    }
  };
}

async function releaseOwnedLock(lockPath: string, ownerId: string): Promise<void> {
  const metadata = await readLockMetadata(lockPath);
  if (metadata?.ownerId !== ownerId) {
    return;
  }
  await rm(lockPath, { recursive: true, force: true });
}

function lockMetadataPath(lockPath: string): string {
  return join(lockPath, "metadata.json");
}

async function injectGraphIoFault(
  point: GraphIoFaultInjectionPoint,
  context: { graphPath?: string; targetPath?: string; tempPath?: string; lockPath?: string }
): Promise<void> {
  await graphIoFaultInjector?.(point, context);
}

async function syncDirectoryBestEffort(targetDir: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(targetDir, "r");
    await handle.sync();
  } catch {
    // Directory fsync is not available on every supported local filesystem.
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // Nothing useful can be done for a best-effort directory sync close.
      }
    }
  }
}

function formatLockMetadata(metadata: PartialGraphLockMetadata | undefined): string {
  if (!metadata) {
    return "";
  }

  const parts = [
    `pid=${metadata.pid}`,
    ...(metadata.host ? [`host=${metadata.host}`] : []),
    `createdAt=${metadata.createdAt}`,
    ...(metadata.updatedAt ? [`updatedAt=${metadata.updatedAt}`] : []),
    `graphPath=${metadata.graphPath}`,
    ...(metadata.lockVersion ? [`lockVersion=${metadata.lockVersion}`] : []),
    ...(metadata.ownerId ? [`ownerId=${metadata.ownerId}`] : [])
  ];
  return ` (owner ${parts.join(", ")})`;
}

function normalizeLockOwner(metadata: PartialGraphLockMetadata | undefined): GraphLockOwnerMetadata | undefined {
  if (!metadata) {
    return undefined;
  }
  return {
    ...(metadata.lockVersion ? { lockVersion: metadata.lockVersion } : {}),
    ...(metadata.ownerId ? { ownerId: metadata.ownerId } : {}),
    pid: metadata.pid,
    ...(metadata.host ? { host: metadata.host } : {}),
    createdAt: metadata.createdAt,
    ...(metadata.updatedAt ? { updatedAt: metadata.updatedAt } : {}),
    graphPath: metadata.graphPath
  };
}

function localHostname(): string {
  try {
    return hostname();
  } catch {
    return "unknown";
  }
}

function nodeErrorCode(error: unknown): string | undefined {
  return isRecord(error) && "code" in error
    ? String(error.code)
    : undefined;
}

function envInteger(name: string): number | undefined {
  const value = process.env[name];
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function formatGraphValidationIssues(issues: GraphValidationIssue[]): string {
  return issues.map((issue) => `${issue.path} ${issue.message}`).join("; ");
}
