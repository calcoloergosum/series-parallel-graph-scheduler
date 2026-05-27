import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { validatePlanGraphFile, type GraphValidationIssue, type PlanGraphFile } from "./contracts.js";
import { runtimePathsFromModuleUrl } from "./runtime-paths.js";

const { rootDir } = runtimePathsFromModuleUrl(import.meta.url);
export const defaultGraphPath = resolve(rootDir, "plan.graph.json");

export interface GraphLockOptions {
  lockPath?: string;
  staleMs?: number;
  retryMs?: number;
  timeoutMs?: number;
}

interface GraphLockMetadata {
  pid: number;
  createdAt: string;
  graphPath: string;
  host?: string;
}

export async function readGraph(graphPath = defaultGraphPath): Promise<PlanGraphFile> {
  const content = await readFile(graphPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch (error) {
    throw new Error(`Failed to parse graph file ${graphPath}: ${errorMessage(error)}`, { cause: error });
  }

  const issues = validatePlanGraphFile(parsed);
  if (issues.length > 0) {
    throw new Error(`Invalid graph file ${graphPath}: ${formatGraphValidationIssues(issues)}`);
  }

  return parsed as PlanGraphFile;
}

export async function writeGraphAtomic(graph: unknown, graphPath = defaultGraphPath): Promise<void> {
  const tempPath = `${graphPath}.${process.pid}.${Date.now()}.tmp`;
  const content = `${JSON.stringify(graph, null, 2)}\n`;
  await writeFile(tempPath, content, "utf8");
  await rename(tempPath, graphPath);
}

export async function withGraphLock<T>(
  graphPath: string,
  fn: () => Promise<T> | T,
  options: GraphLockOptions = {}
): Promise<T> {
  const lockPath = options.lockPath || `${graphPath}.lock`;
  const staleMs = options.staleMs ?? 10 * 60 * 1000;
  const retryMs = options.retryMs ?? 100;
  const timeoutMs = options.timeoutMs ?? 5000;
  const startedAt = Date.now();

  while (true) {
    let lockMetadata: GraphLockMetadata | undefined;
    try {
      await mkdir(lockPath);
      try {
        await writeLockMetadata(lockPath, graphPath);
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
            await rm(lockPath, { recursive: true, force: true });
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
        throw new Error(`Timed out waiting for graph lock: ${lockPath}${formatLockMetadata(lockMetadata)}`);
      }

      await sleep(retryMs);
    }
  }

  try {
    return await fn();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
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
  await mkdir(dirname(resolvedPath), { recursive: true });
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

export function defaultReportPath(nodeId: string, runId: string): string {
  return `reports/${safeFilePart(nodeId)}-${safeFilePart(runId)}.md`;
}

function safeFilePart(value: unknown): string {
  return String(value || "run").replaceAll(/[^a-zA-Z0-9._-]/g, "_");
}

async function writeLockMetadata(lockPath: string, graphPath: string): Promise<void> {
  const metadata: GraphLockMetadata = {
    pid: process.pid,
    createdAt: new Date().toISOString(),
    graphPath
  };
  const host = localHostname();
  if (host) {
    metadata.host = host;
  }
  await writeFile(lockMetadataPath(lockPath), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

async function readLockMetadata(lockPath: string): Promise<GraphLockMetadata | undefined> {
  try {
    const metadata = JSON.parse(await readFile(lockMetadataPath(lockPath), "utf8")) as Partial<GraphLockMetadata>;
    if (
      typeof metadata.pid !== "number" ||
      typeof metadata.createdAt !== "string" ||
      typeof metadata.graphPath !== "string"
    ) {
      return undefined;
    }
    return {
      pid: metadata.pid,
      createdAt: metadata.createdAt,
      graphPath: metadata.graphPath,
      ...(typeof metadata.host === "string" ? { host: metadata.host } : {})
    };
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") {
      return undefined;
    }
    return undefined;
  }
}

function lockMetadataPath(lockPath: string): string {
  return join(lockPath, "metadata.json");
}

function formatLockMetadata(metadata: GraphLockMetadata | undefined): string {
  if (!metadata) {
    return "";
  }

  const host = metadata.host ? `, host=${metadata.host}` : "";
  return ` (owner pid=${metadata.pid}, createdAt=${metadata.createdAt}, graphPath=${metadata.graphPath}${host})`;
}

function localHostname(): string | undefined {
  try {
    return hostname();
  } catch {
    return undefined;
  }
}

function nodeErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function formatGraphValidationIssues(issues: GraphValidationIssue[]): string {
  return issues.map((issue) => `${issue.path} ${issue.message}`).join("; ");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
