export interface NumericArgumentOptions {
  flag: string;
  min?: number;
  max?: number;
  integer?: boolean;
  defaultValue?: number;
}

export const numericArgumentRanges = {
  leaseSeconds: { min: 1, max: 86_400, integer: true },
  idleMs: { min: 1, max: 86_400_000, integer: true },
  port: { min: 0, max: 65_535, integer: true },
  workerCount: { min: 1, max: 100, integer: true }
} as const;

type NumericArgumentValue = string | number | boolean | null | undefined | Array<string | number | boolean | null | undefined>;

export class NumericArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NumericArgumentError";
  }
}

export function parseNumericArgument(value: NumericArgumentValue, options: NumericArgumentOptions): number | undefined {
  const raw = lastNumericValue(value);
  if (raw === undefined) {
    return options.defaultValue;
  }
  if (raw === null || raw === true || raw === false) {
    throw missingNumericArgumentError(options);
  }

  let numericValue: number;
  if (typeof raw === "number") {
    numericValue = raw;
  } else {
    const text = raw.trim();
    if (!text) {
      throw missingNumericArgumentError(options);
    }
    if (!matchesExpectedNumberFormat(text, options)) {
      throw invalidNumericArgumentError(raw, options);
    }
    numericValue = Number(text);
  }

  if (!Number.isFinite(numericValue)) {
    throw invalidNumericArgumentError(raw, options);
  }
  if (options.integer !== false && !Number.isInteger(numericValue)) {
    throw invalidNumericArgumentError(raw, options);
  }
  if (options.min !== undefined && numericValue < options.min) {
    throw invalidNumericArgumentError(raw, options);
  }
  if (options.max !== undefined && numericValue > options.max) {
    throw invalidNumericArgumentError(raw, options);
  }
  return numericValue;
}

function lastNumericValue(value: NumericArgumentValue): string | number | boolean | null | undefined {
  return Array.isArray(value) ? value[value.length - 1] : value;
}

function matchesExpectedNumberFormat(value: string, options: NumericArgumentOptions): boolean {
  if (options.integer !== false) {
    return /^[+-]?\d+$/.test(value);
  }
  return /^[+-]?(?:\d+|\d*\.\d+)(?:e[+-]?\d+)?$/i.test(value);
}

function missingNumericArgumentError(options: NumericArgumentOptions): Error {
  return new NumericArgumentError(`Missing ${options.flag} value; expected ${expectedNumericArgument(options)}`);
}

function invalidNumericArgumentError(value: string | number | boolean | null | undefined, options: NumericArgumentOptions): Error {
  return new NumericArgumentError(`Invalid ${options.flag}: expected ${expectedNumericArgument(options)}; received ${formatReceivedValue(value)}`);
}

function expectedNumericArgument(options: NumericArgumentOptions): string {
  const kind = options.integer === false ? "number" : "integer";
  if (options.min !== undefined && options.max !== undefined) {
    return `${kind} from ${options.min} to ${options.max}`;
  }
  if (options.min !== undefined) {
    return `${kind} >= ${options.min}`;
  }
  if (options.max !== undefined) {
    return `${kind} <= ${options.max}`;
  }
  return kind;
}

function formatReceivedValue(value: string | number | boolean | null | undefined): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}
