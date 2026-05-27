export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const secretPatterns = [
  /(https:\/\/hooks\.slack\.com\/services\/)[^\s)"'?]+/gi,
  /(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s)"'@]+(?=@)/gi,
  /\b(Authorization\s*[:=]\s*)Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi,
  /\b((?:[A-Z0-9_]*TOKEN|[A-Z0-9_]*SECRET|[A-Z0-9_]*PASSWORD|[A-Z0-9_]*PASSWD|[A-Z0-9_]*API_KEY|SLACK_WEBHOOK_URL|WEBHOOK)\s*[:=]\s*)[^\s)"']+/gi,
  /\b((?:token|secret|password|passwd|api[_-]?key|webhook)\s*[:=]\s*)[^\s)"']+/gi
] as const;

const secretLikeEnvironmentKey = /(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|AUTHORIZATION|WEBHOOK|SLACK_WEBHOOK_URL)/i;
const minimumSecretValueLength = 4;

export function redactSecretText(value: string, environment: Record<string, string | undefined> = process.env): string {
  let redacted = secretPatterns.reduce(
    (text, pattern) => text.replaceAll(pattern, (match: string, prefix?: string) => `${prefix || ""}[REDACTED]`),
    value
  );
  for (const secretValue of configuredSecretValues(environment)) {
    redacted = redacted.replaceAll(new RegExp(escapeRegExp(secretValue), "g"), "[REDACTED]");
  }
  return redacted;
}

function configuredSecretValues(environment: Record<string, string | undefined>): string[] {
  return [...new Set(Object.entries(environment)
    .filter(([key, value]) => secretLikeEnvironmentKey.test(key) && typeof value === "string" && value.length >= minimumSecretValueLength)
    .map(([, value]) => value!)
    .filter((value) => value !== "[REDACTED]"))]
    .sort((left, right) => right.length - left.length);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function safeFilePart(value: unknown): string {
  return String(value || "run").replaceAll(/[^a-zA-Z0-9._-]/g, "_");
}

export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function classToken(value: unknown, fallback = "unknown"): string {
  const token = String(value || fallback).toLowerCase().replaceAll(/[^a-z0-9_-]/g, "-").replaceAll(/-+/g, "-");
  return token.replaceAll(/^-|-$/g, "") || fallback;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
