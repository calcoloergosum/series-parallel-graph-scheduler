export interface CliErrorEnvironment {
  SPG_DEBUG?: string;
}

export interface CliErrorOutput {
  error(message: string): void;
}

// CLI error policy:
// - successful machine-readable command output belongs on stdout only;
// - expected operator errors print one concise, actionable stderr message and exit non-zero;
// - stack traces are reserved for SPG_DEBUG=1 or genuinely unexpected failures.
export function printCliError(error: unknown, env: CliErrorEnvironment = {}, output: CliErrorOutput = console): void {
  output.error(formatCliError(error, env));
}

export function formatCliError(error: unknown, env: CliErrorEnvironment = {}): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  if (debugEnabled(env) && error.stack) {
    return error.stack;
  }

  if (isExpectedCliError(error)) {
    return error.message;
  }

  return error.stack || error.message;
}

function debugEnabled(env: CliErrorEnvironment): boolean {
  return Boolean(env.SPG_DEBUG && !["0", "false", "False", "FALSE"].includes(env.SPG_DEBUG));
}

function isExpectedCliError(error: Error): boolean {
  return expectedCliErrorPatterns.some((pattern) => pattern.test(error.message));
}

const expectedCliErrorPatterns = [
  /^Boolean flag --/,
  /^Option --/,
  /^Missing --/,
  /^Missing node id$/,
  /^Invalid --/,
  /^Unknown command:/,
  /\brequires --/,
  /^Use either --/,
  /^--child-json/,
  /^--child #\d+ /,
  /^Invalid --child/,
  /^Invalid graph file /,
  /^Generated graph failed validation:/,
  /^Worker isolation /,
  /^Failed to parse graph file /,
  /^Timed out waiting for graph lock:/,
  /^Timed out waiting for Git cache lock:/,
  /^Failed to remove stale graph lock:/,
  /^Path escapes graph directory:/,
  /^Unsafe graph output path:/,
  /^Refusing to overwrite existing graph file:/,
  /^Refusing to bind visualizer write endpoints /,
  /^No ready nodes to claim in graph /,
  /^Node is not ready to claim:/,
  /^Only leaf nodes can be mutated directly:/,
  /^Cannot /,
  /^Lease /,
  /^Child node already exists:/,
  /^Cycle detected in graph:/,
  /^render-plan exited with /,
  /^plan\.graph\.json is missing document content$/
];
