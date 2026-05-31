import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { redactOperationalEventDetails } from "./operational-events.js";
import type {
  GitDiffStatMetadata,
  GitFileChangeType,
  GitFileFootprintMetadata,
  NodeGitFootprintMetadata
} from "./contracts.js";

const execFileAsync = promisify(execFile);
const defaultBareRepositoryRelativePath = "runs/git/cache/repo.git";
const defaultGitCacheLockTimeoutMs = 60 * 1000;
const defaultGitCacheLockStaleMs = 10 * 60 * 1000;
const gitOutputLimit = 1200;

export interface GitCommand {
  gitPath?: string;
  args: string[];
  cwd?: string;
  allowedExitCodes?: number[];
  failurePrefix?: string;
  redactions?: Record<string, string>;
}

export interface GitCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type GitRunner = (command: GitCommand) => Promise<GitCommandResult>;

export interface PrepareBareRepositoryOptions {
  remote?: unknown;
  bareRepoPath: string;
  git?: GitRunner;
  lockPath?: string;
  lockTimeoutMs?: number;
  lockStaleMs?: number;
}

export interface PrepareBareRepositoryResult {
  remote: string;
  redactedRemote: string;
  bareRepoPath: string;
  created: boolean;
}

export interface CreateRunCloneOptions {
  bareRepoPath: string;
  cloneCwd: string;
  git?: GitRunner;
}

export interface CreateRunCloneResult {
  bareRepoPath: string;
  cloneCwd: string;
}

export interface CreateWorkBranchOptions {
  cloneCwd: string;
  nodeId: string;
  runId: string;
  baseRef: string;
  bareRepoPath?: string;
  git?: GitRunner;
}

export interface CreateWorkBranchResult {
  cloneCwd: string;
  baseRef: string;
  workRef: string;
  branchName: string;
  commit: string;
}

export interface PublishOutputRefOptions {
  cloneCwd: string;
  workRef: string;
  outputRef?: string;
  git?: GitRunner;
}

export interface PublishOutputRefResult {
  workRef: string;
  outputRef: string;
  commit: string;
  autoCommitted?: boolean;
}

export interface CollectGitDiffStatOptions {
  cloneCwd?: string;
  bareRepoPath?: string;
  baseRef: string;
  headRef: string;
  baseRefName?: string;
  headRefName?: string;
  git?: GitRunner;
  collectedAt?: string;
}

export type CollectGitDiffStatResult =
  | {
      ok: true;
      footprint: NodeGitFootprintMetadata;
      diffStat: GitDiffStatMetadata;
      files: GitFileFootprintMetadata[];
    }
  | {
      ok: false;
      warning: string;
    };

export class GitRuntimeError extends Error {
  readonly args?: string[];
  readonly cwd?: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
  readonly summary?: string;

  constructor(
    message: string,
    {
      args,
      cwd,
      stdout,
      stderr,
      exitCode,
      summary
    }: {
      args?: string[];
      cwd?: string;
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      summary?: string;
    } = {}
  ) {
    super(message);
    this.name = "GitRuntimeError";
    this.args = args;
    this.cwd = cwd;
    this.stdout = stdout;
    this.stderr = stderr;
    this.exitCode = exitCode;
    this.summary = summary;
  }
}

export async function prepareBareRepository({
  remote,
  bareRepoPath,
  git = runGitCommand,
  lockPath = join(dirname(bareRepoPath), ".repo.git.lock"),
  lockTimeoutMs,
  lockStaleMs
}: PrepareBareRepositoryOptions): Promise<PrepareBareRepositoryResult> {
  const resolvedRemote = validateGitRemote(remote);
  const redactedRemote = redactGitText(resolvedRemote);
  const redactions = { [resolvedRemote]: redactedRemote };

  await mkdir(dirname(bareRepoPath), { recursive: true });
  return withGitCacheLock(lockPath, async () => {
    if (!existsSync(bareRepoPath)) {
      const tempBareRepoPath = join(dirname(bareRepoPath), `.repo.git.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
      try {
        await git({
          args: ["clone", "--bare", resolvedRemote, tempBareRepoPath],
          failurePrefix: `Worker isolation remote fetch failed for ${redactedRemote}:`,
          redactions
        });
        if (existsSync(tempBareRepoPath)) {
          await rename(tempBareRepoPath, bareRepoPath);
        }
      } catch (error) {
        await rm(tempBareRepoPath, { recursive: true, force: true });
        throw error;
      }
      return { remote: resolvedRemote, redactedRemote, bareRepoPath, created: true };
    }

    const bare = await git({
      args: ["--git-dir", bareRepoPath, "rev-parse", "--is-bare-repository"],
      failurePrefix: `Worker isolation bare repository invalid for ${bareRepoPath}:`
    });
    if (bare.stdout.trim() !== "true") {
      throw new GitRuntimeError(`Worker isolation bare repository invalid for ${bareRepoPath}: not a bare repository`, {
        stdout: bare.stdout,
        stderr: bare.stderr
      });
    }

    const origin = await git({
      args: ["--git-dir", bareRepoPath, "config", "--get", "remote.origin.url"],
      failurePrefix: `Worker isolation bare repository invalid for ${bareRepoPath}:`
    });
    if (origin.stdout.trim() !== resolvedRemote) {
      throw new GitRuntimeError(
        `Worker isolation bare repository origin mismatch for ${bareRepoPath}: expected ${redactedRemote}, found ${redactGitText(origin.stdout.trim())}`
      );
    }

    await git({
      args: ["--git-dir", bareRepoPath, "fetch", "--prune", "origin", "+refs/heads/*:refs/remotes/origin/*"],
      failurePrefix: `Worker isolation remote fetch failed for ${redactedRemote}:`,
      redactions
    });
    await git({
      args: ["--git-dir", bareRepoPath, "fetch", "origin", "+refs/heads/*:refs/heads/*"],
      failurePrefix: `Worker isolation remote fetch failed for ${redactedRemote}:`,
      redactions
    });
    return { remote: resolvedRemote, redactedRemote, bareRepoPath, created: false };
  }, { timeoutMs: lockTimeoutMs, staleMs: lockStaleMs });
}

export async function createRunClone({
  bareRepoPath,
  cloneCwd,
  git = runGitCommand
}: CreateRunCloneOptions): Promise<CreateRunCloneResult> {
  await mkdir(dirname(cloneCwd), { recursive: true });
  try {
    await mkdir(cloneCwd);
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
    if (code === "EEXIST") {
      throw new GitRuntimeError(`Worker isolation clone failed for ${cloneCwd} from ${bareRepoPath}: workspace collision`);
    }
    throw error;
  }

  await git({
    args: ["clone", bareRepoPath, cloneCwd],
    failurePrefix: `Worker isolation clone failed for ${cloneCwd} from ${bareRepoPath}:`
  });
  return { bareRepoPath, cloneCwd };
}

export async function createWorkBranch({
  cloneCwd,
  nodeId,
  runId,
  baseRef,
  bareRepoPath,
  git = runGitCommand
}: CreateWorkBranchOptions): Promise<CreateWorkBranchResult> {
  const branchName = buildNodeWorkBranchName(nodeId, runId);
  const workRef = `refs/heads/${branchName}`;
  if (await gitRefExists({ cloneCwd, ref: workRef, git })) {
    throw new GitRuntimeError(`Worker isolation branch collision for ${workRef} in ${cloneCwd}`);
  }
  if (bareRepoPath && await gitRefExists({ bareRepoPath, ref: workRef, git })) {
    throw new GitRuntimeError(`Worker isolation branch collision for ${workRef} in ${bareRepoPath}`);
  }

  const checkoutBaseRef = await resolveCloneCheckoutRef({ cloneCwd, baseRef, git });
  await git({
    args: ["-C", cloneCwd, "checkout", "-b", branchName, checkoutBaseRef],
    failurePrefix: `Worker isolation branch creation failed for ${workRef}:`
  });
  const commit = await revParseCommit({ cloneCwd, ref: workRef, git });
  return { cloneCwd, baseRef, workRef, branchName, commit };
}

export async function publishOutputRef({
  cloneCwd,
  workRef,
  outputRef = workRef,
  git = runGitCommand
}: PublishOutputRefOptions): Promise<PublishOutputRefResult> {
  const autoCommitted = await commitDirtyWorkspace({ cloneCwd, workRef, git });
  const commit = await revParseCommit({ cloneCwd, ref: workRef, git });
  await git({
    args: ["-C", cloneCwd, "push", "origin", `${workRef}:${outputRef}`],
    failurePrefix: `Worker isolation output ref publication failed for ${outputRef}:`
  });
  return { workRef, outputRef, commit, ...(autoCommitted ? { autoCommitted } : {}) };
}

export async function collectGitDiffStat({
  cloneCwd,
  bareRepoPath,
  baseRef,
  headRef,
  baseRefName,
  headRefName,
  git = runGitCommand,
  collectedAt = new Date().toISOString()
}: CollectGitDiffStatOptions): Promise<CollectGitDiffStatResult> {
  const repoArgs = gitRepositoryArgs({ cloneCwd, bareRepoPath });
  const [base, head] = await Promise.all([
    resolveDiffCommit({ repoArgs, ref: baseRef, label: "base", git }),
    resolveDiffCommit({ repoArgs, ref: headRef, label: "head", git })
  ]);
  if (base.warning) {
    return { ok: false, warning: base.warning };
  }
  if (head.warning) {
    return { ok: false, warning: head.warning };
  }
  if (!base.commit || !head.commit) {
    return { ok: false, warning: `Git diffstat omitted: unresolved refs for ${baseRef}..${headRef}` };
  }
  const baseCommit = base.commit;
  const headCommit = head.commit;

  const numstat = await git({
    args: [...repoArgs, "diff", "--numstat", "-z", "-M", baseCommit, headCommit, "--"],
    failurePrefix: `Git diffstat collection failed for ${baseRef}..${headRef}:`
  });
  const nameStatus = await git({
    args: [...repoArgs, "diff", "--name-status", "-z", "-M", baseCommit, headCommit, "--"],
    failurePrefix: `Git diffstat file status collection failed for ${baseRef}..${headRef}:`
  });
  const statusEntries = parseGitNameStatusZ(nameStatus.stdout);
  const files = parseGitNumstatZ(numstat.stdout).map((entry, index) => {
    const status = statusEntries[index];
    const changeType = status && samePathIdentity(entry, status) ? status.changeType : undefined;
    return {
      path: entry.path,
      ...(entry.oldPath ? { oldPath: entry.oldPath } : {}),
      ...(changeType ? { changeType } : {}),
      additions: entry.additions,
      deletions: entry.deletions,
      totalChanges: entry.totalChanges,
      ...(entry.binary ? { binary: true } : {})
    };
  });
  const additions = files.reduce((sum, file) => sum + (file.additions ?? 0), 0);
  const deletions = files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
  const binaryFiles = files.filter((file) => file.binary).length;
  const diffStat: GitDiffStatMetadata = {
    filesChanged: files.length,
    additions,
    deletions,
    totalChanges: additions + deletions,
    ...(binaryFiles > 0 ? { binaryFiles } : {})
  };
  const footprint: NodeGitFootprintMetadata = {
    baseRef: { name: baseRefName || baseRef, commit: baseCommit },
    headRef: { name: headRefName || headRef, commit: headCommit },
    branch: displayBranchName(headRefName || headRef),
    commit: headCommit,
    diffStat,
    files,
    collectedAt
  };

  return { ok: true, footprint, diffStat, files };
}

export function buildNodeWorkBranchName(nodeId: string, runId: string): string {
  return `spg/node/${safeGitRefToken(nodeId)}/${safeGitRefToken(runId)}`;
}

export function defaultIsolationBareRepositoryPath(): string {
  return defaultBareRepositoryRelativePath;
}

export function defaultBareRepositoryPath(graphPath: string): string {
  return join(dirname(resolve(graphPath)), defaultBareRepositoryRelativePath);
}

export function redactGitRemote(remote: string): string {
  return redactGitText(remote);
}

export async function runGitCommand({
  gitPath = "git",
  args,
  cwd,
  allowedExitCodes = [0],
  failurePrefix = "Git command failed:",
  redactions = {}
}: GitCommand): Promise<GitCommandResult> {
  try {
    const result = await execFileAsync(gitPath, args, {
      cwd,
      maxBuffer: 1024 * 1024,
      shell: false
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    const exitCode = readErrorExitCode(error);
    const stdout = readErrorText(error, "stdout");
    const stderr = readErrorText(error, "stderr");
    if (exitCode !== undefined && allowedExitCodes.includes(exitCode)) {
      return { stdout, stderr, exitCode };
    }
    throw formatGitCommandError({
      failurePrefix,
      args,
      cwd,
      stdout,
      stderr,
      exitCode,
      redactions
    });
  }
}

async function gitRefExists({
  cloneCwd,
  bareRepoPath,
  ref,
  git
}: {
  cloneCwd?: string;
  bareRepoPath?: string;
  ref: string;
  git: GitRunner;
}): Promise<boolean> {
  const args = cloneCwd
    ? ["-C", cloneCwd, "show-ref", "--verify", "--quiet", ref]
    : ["--git-dir", bareRepoPath || "", "show-ref", "--verify", "--quiet", ref];
  const result = await git({ args, allowedExitCodes: [0, 1] });
  return result.exitCode === 0;
}

function gitRepositoryArgs({ cloneCwd, bareRepoPath }: { cloneCwd?: string; bareRepoPath?: string }): string[] {
  if (cloneCwd) {
    return ["-C", cloneCwd];
  }
  if (bareRepoPath) {
    return ["--git-dir", bareRepoPath];
  }
  throw new GitRuntimeError("Git diffstat collection requires cloneCwd or bareRepoPath");
}

async function resolveDiffCommit({
  repoArgs,
  ref,
  label,
  git
}: {
  repoArgs: string[];
  ref: string;
  label: "base" | "head";
  git: GitRunner;
}): Promise<{ commit: string; warning?: undefined } | { warning: string; commit?: undefined }> {
  const result = await git({
    args: [...repoArgs, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
    allowedExitCodes: [0, 1, 128],
    failurePrefix: `Git diffstat ${label} ref resolution failed for ${ref}:`
  });
  const commit = result.stdout.trim();
  if (result.exitCode === 0 && commit) {
    return { commit };
  }
  return { warning: `Git diffstat omitted: missing ${label} ref ${ref}` };
}

interface ParsedNumstatEntry {
  path: string;
  oldPath?: string;
  additions: number | null;
  deletions: number | null;
  totalChanges: number | null;
  binary?: boolean;
}

interface ParsedNameStatusEntry {
  path: string;
  oldPath?: string;
  changeType: GitFileChangeType;
}

function parseGitNumstatZ(output: string): ParsedNumstatEntry[] {
  const tokens = splitGitZOutput(output);
  const entries: ParsedNumstatEntry[] = [];
  for (let index = 0; index < tokens.length;) {
    const statToken = tokens[index++];
    const parsed = /^([^\t]+)\t([^\t]+)\t([\s\S]*)$/.exec(statToken);
    if (!parsed) {
      continue;
    }
    const [, additionsRaw, deletionsRaw, pathPart] = parsed;
    const binary = additionsRaw === "-" || deletionsRaw === "-";
    const additions = binary ? null : Number(additionsRaw);
    const deletions = binary ? null : Number(deletionsRaw);
    const pathInfo = pathPart === ""
      ? { oldPath: tokens[index++], path: tokens[index++] }
      : { path: pathPart };
    entries.push({
      ...pathInfo,
      additions,
      deletions,
      totalChanges: additions === null || deletions === null ? null : additions + deletions,
      ...(binary ? { binary } : {})
    });
  }
  return entries;
}

function parseGitNameStatusZ(output: string): ParsedNameStatusEntry[] {
  const tokens = splitGitZOutput(output);
  const entries: ParsedNameStatusEntry[] = [];
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++];
    const changeType = gitStatusToChangeType(status);
    if (status.startsWith("R") || status.startsWith("C")) {
      entries.push({ oldPath: tokens[index++], path: tokens[index++], changeType });
    } else {
      entries.push({ path: tokens[index++], changeType });
    }
  }
  return entries;
}

function splitGitZOutput(output: string): string[] {
  if (!output) {
    return [];
  }
  const tokens = output.split("\0");
  if (tokens.at(-1) === "") {
    tokens.pop();
  }
  return tokens;
}

function gitStatusToChangeType(status: string): GitFileChangeType {
  const code = status.charAt(0);
  switch (code) {
    case "A":
      return "added";
    case "M":
      return "modified";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "T":
      return "typechange";
    case "U":
      return "unmerged";
    default:
      return "unknown";
  }
}

function samePathIdentity(left: { path: string; oldPath?: string }, right: { path: string; oldPath?: string }): boolean {
  return left.path === right.path && left.oldPath === right.oldPath;
}

function displayBranchName(ref: string): string {
  const headPrefix = "refs/heads/";
  return ref.startsWith(headPrefix) ? ref.slice(headPrefix.length) : ref;
}

async function resolveCloneCheckoutRef({
  cloneCwd,
  baseRef,
  git
}: {
  cloneCwd: string;
  baseRef: string;
  git: GitRunner;
}): Promise<string> {
  if (await gitRefExists({ cloneCwd, ref: baseRef, git })) {
    return baseRef;
  }

  const remoteHeadRef = remoteTrackingRefForHead(baseRef);
  if (remoteHeadRef && await gitRefExists({ cloneCwd, ref: remoteHeadRef, git })) {
    return remoteHeadRef;
  }

  return baseRef;
}

function remoteTrackingRefForHead(ref: string): string | undefined {
  const prefix = "refs/heads/";
  return ref.startsWith(prefix) ? `refs/remotes/origin/${ref.slice(prefix.length)}` : undefined;
}

async function revParseCommit({ cloneCwd, ref, git }: { cloneCwd: string; ref: string; git: GitRunner }): Promise<string> {
  const result = await git({
    args: ["-C", cloneCwd, "rev-parse", `${ref}^{commit}`],
    failurePrefix: `Worker isolation ref resolution failed for ${ref}:`
  });
  return result.stdout.trim();
}

async function commitDirtyWorkspace({
  cloneCwd,
  workRef,
  git
}: {
  cloneCwd: string;
  workRef: string;
  git: GitRunner;
}): Promise<boolean> {
  const status = await git({
    args: ["-C", cloneCwd, "status", "--porcelain=v1", "--untracked-files=all"],
    failurePrefix: `Worker isolation workspace status failed for ${workRef}:`
  });
  if (!status.stdout.trim()) {
    return false;
  }

  await git({
    args: ["-C", cloneCwd, "add", "-A"],
    failurePrefix: `Worker isolation workspace staging failed for ${workRef}:`
  });
  await git({
    args: [
      "-C",
      cloneCwd,
      "-c",
      "user.name=Series Parallel Graph Scheduler",
      "-c",
      "user.email=spg-scheduler@example.invalid",
      "commit",
      "-m",
      `spg worker output ${workRef}`
    ],
    failurePrefix: `Worker isolation workspace commit failed for ${workRef}:`
  });
  return true;
}

export function validateGitRemote(remote: unknown): string {
  const requiredMessage = "Worker isolation requires scheduler.remote; set graph.scheduler.remote or pass --remote <url> with --isolation git.";
  if (typeof remote !== "string") {
    throw new GitRuntimeError(`${requiredMessage} Invalid remote: expected string.`);
  }
  const value = remote.trim();
  if (!value) {
    throw new GitRuntimeError(
      requiredMessage
    );
  }
  if (isPlaceholderGitRemote(value)) {
    throw new GitRuntimeError(`Worker isolation remote is a placeholder and cannot be used: ${redactGitRemote(value)}`);
  }
  return value;
}

function isPlaceholderGitRemote(value: string): boolean {
  const normalized = value.toLowerCase();
  return normalized.startsWith("required:")
    || ["todo", "tbd", "fixme", "replace-me", "changeme"].includes(normalized)
    || normalized.includes("set to the git remote url")
    || /<[^>]*(remote|repo)[^>]*>/.test(normalized);
}

function safeGitRefToken(value: string): string {
  const raw = String(value || "");
  let token = raw
    .normalize("NFKD")
    .replaceAll(/[^\w.-]+/g, "-")
    .replaceAll(/\.+/g, ".")
    .replaceAll(/^-+|-+$/g, "")
    .replaceAll(/^\.+|\.+$/g, "");
  token = token.replaceAll(/\.lock$/gi, "-lock");
  if (!token || token === "@" || token.includes("..") || token.includes("@{")) {
    token = "ref";
  }
  if (token !== raw) {
    token = `${token}-${shortHash(raw)}`;
  }
  return token;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

function formatGitCommandError({
  failurePrefix,
  args,
  cwd,
  stdout,
  stderr,
  exitCode,
  redactions
}: {
  failurePrefix: string;
  args: string[];
  cwd?: string;
  stdout: string;
  stderr: string;
  exitCode?: number;
  redactions: Record<string, string>;
}): GitRuntimeError {
  const summary = summarizeGitOutput(`${stderr}\n${stdout}`, redactions);
  const suffix = summary ? ` ${summary}` : exitCode === undefined ? " command could not be started" : ` exited with ${exitCode}`;
  return new GitRuntimeError(`${failurePrefix}${suffix}`, {
    args,
    cwd,
    stdout,
    stderr,
    exitCode,
    summary
  });
}

function summarizeGitOutput(output: string, redactions: Record<string, string>): string {
  const normalized = stripUnsafeControlCharacters(redactGitText(output, redactions))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
  return normalized.length > gitOutputLimit ? `${normalized.slice(0, gitOutputLimit)}...` : normalized;
}

function stripUnsafeControlCharacters(value: string): string {
  return Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127 ? " " : character;
  }).join("");
}

function redactGitText(value: string, redactions: Record<string, string> = {}): string {
  let redacted = value;
  for (const [raw, replacement] of Object.entries(redactions)) {
    redacted = redacted.split(raw).join(replacement);
  }
  return String(redactOperationalEventDetails({ value: redacted }).value);
}

function readErrorExitCode(error: unknown): number | undefined {
  if (typeof error === "object" && error && "code" in error && typeof error.code === "number") {
    return error.code;
  }
  return undefined;
}

function readErrorText(error: unknown, key: "stdout" | "stderr"): string {
  if (typeof error === "object" && error && key in error) {
    const record = error as Record<"stdout" | "stderr", unknown>;
    if (typeof record[key] === "string") {
      return String(record[key]);
    }
  }
  return "";
}

async function withGitCacheLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  {
    timeoutMs = envInteger("SPG_GIT_CACHE_LOCK_TIMEOUT_MS") ?? defaultGitCacheLockTimeoutMs,
    staleMs = defaultGitCacheLockStaleMs,
    retryMs = 100
  }: { timeoutMs?: number; staleMs?: number; retryMs?: number } = {}
): Promise<T> {
  const startedAt = Date.now();
  await mkdir(dirname(lockPath), { recursive: true });

  while (true) {
    let lockOwner: GitCacheLockOwner | undefined;
    try {
      await mkdir(lockPath);
      await writeFile(join(lockPath, "owner.json"), `${JSON.stringify({
        pid: process.pid,
        createdAt: new Date().toISOString(),
        lockPath
      }, null, 2)}\n`, "utf8");
      break;
    } catch (error) {
      if (nodeErrorCode(error) !== "EEXIST") {
        throw error;
      }
      try {
        lockOwner = await readGitCacheLockOwner(lockPath);
        const lockStat = await stat(lockPath);
        if (Date.now() - lockStat.mtimeMs > staleMs) {
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch (statError) {
        if (nodeErrorCode(statError) !== "ENOENT") {
          throw statError;
        }
      }
      if (Date.now() - startedAt > timeoutMs) {
        throw new GitRuntimeError(
          `Timed out waiting for Git cache lock: ${lockPath}${formatGitCacheLockOwner(lockOwner)} ` +
          `(timeoutMs=${timeoutMs}, staleMs=${staleMs}). ` +
          `Next steps: wait for the owner process to finish or inspect ${join(lockPath, "owner.json")} before removing a stale lock directory.`
        );
      }
      await delay(retryMs);
    }
  }

  const heartbeat = setInterval(() => {
    const now = new Date();
    void utimes(lockPath, now, now).catch(() => {
      // Lock release and stale reaping handle races around process exit.
    });
  }, Math.max(1000, Math.floor(staleMs / 3)));
  heartbeat.unref?.();

  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    await rm(lockPath, { recursive: true, force: true });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function nodeErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

interface GitCacheLockOwner {
  pid?: number;
  createdAt?: string;
  lockPath?: string;
}

async function readGitCacheLockOwner(lockPath: string): Promise<GitCacheLockOwner | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8"));
    if (typeof parsed !== "object" || parsed === null) {
      return undefined;
    }
    const owner = parsed as Record<string, unknown>;
    return {
      ...(typeof owner.pid === "number" && Number.isFinite(owner.pid) ? { pid: owner.pid } : {}),
      ...(typeof owner.createdAt === "string" ? { createdAt: owner.createdAt } : {}),
      ...(typeof owner.lockPath === "string" ? { lockPath: owner.lockPath } : {})
    };
  } catch {
    return undefined;
  }
}

function formatGitCacheLockOwner(owner: GitCacheLockOwner | undefined): string {
  if (!owner) {
    return "";
  }
  const fields = [
    owner.pid !== undefined ? `pid=${owner.pid}` : undefined,
    owner.createdAt ? `createdAt=${owner.createdAt}` : undefined,
    owner.lockPath ? `lockPath=${owner.lockPath}` : undefined
  ].filter(Boolean);
  return fields.length > 0 ? ` (owner ${fields.join(", ")})` : "";
}

function envInteger(name: string): number | undefined {
  const value = process.env[name];
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}
