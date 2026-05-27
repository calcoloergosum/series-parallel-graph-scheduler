import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { redactOperationalEventDetails } from "./operational-events.js";

const execFileAsync = promisify(execFile);
const defaultBareRepositoryRelativePath = "runs/git/cache/repo.git";
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
    timeoutMs = 5000,
    staleMs = 10 * 60 * 1000,
    retryMs = 100
  }: { timeoutMs?: number; staleMs?: number; retryMs?: number } = {}
): Promise<T> {
  const startedAt = Date.now();
  await mkdir(dirname(lockPath), { recursive: true });

  while (true) {
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
        throw new GitRuntimeError(`Timed out waiting for Git cache lock: ${lockPath}`);
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
