import { appendFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";

export class LcmError extends Error {
  readonly code: string;
  readonly recoverable: boolean;
  readonly context: Record<string, unknown>;

  constructor(
    message: string,
    code: string,
    recoverable: boolean,
    context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "LcmError";
    this.code = code;
    this.recoverable = recoverable;
    this.context = context;
  }
}

export type RetryOpts = {
  maxRetries: number;
  initialDelay: number;
  maxDelay: number;
  retryIf: (err: unknown) => boolean;
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function wrapAsync<T>(
  fn: () => Promise<T>,
  fallback: T,
  context: string,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = err instanceof LcmError ? err.code : "UNKNOWN";
    process.stderr.write(`[LCM ERROR] ${context}: [${code}] ${message}\n`);
    return fallback;
  }
}

export function wrapSync<T>(fn: () => T, fallback: T, context: string): T {
  try {
    return fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = err instanceof LcmError ? err.code : "UNKNOWN";
    process.stderr.write(`[LCM ERROR] ${context}: [${code}] ${message}\n`);
    return fallback;
  }
}

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  opts: RetryOpts,
): Promise<T> {
  let lastErr: unknown;
  let currentDelay = opts.initialDelay;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;

      if (attempt < opts.maxRetries && opts.retryIf(err)) {
        await delay(currentDelay);
        currentDelay = Math.min(currentDelay * 2, opts.maxDelay);
      } else {
        throw err;
      }
    }
  }

  throw lastErr;
}

const LOG_MAX_SIZE = 1024 * 1024; // 1MB

export function createErrorLogger(
  logPath: string,
): (err: unknown, context: string) => void {
  const resolvedPath = resolve(logPath);

  return (err: unknown, context: string): void => {
    const timestamp = new Date().toISOString();
    const code =
      err instanceof LcmError ? err.code : "UNKNOWN";
    const message =
      err instanceof Error ? err.message : String(err);
    const line = `[${timestamp}] [${code}] ${context}: ${message}\n`;

    try {
      mkdirSync(dirname(resolvedPath), { recursive: true });

      let shouldTruncate = false;
      try {
        const stat = statSync(resolvedPath);
        if (stat.size > LOG_MAX_SIZE) {
          shouldTruncate = true;
        }
      } catch {
        // file doesn't exist yet — that's fine
      }

      if (shouldTruncate) {
        writeFileSync(resolvedPath, line, { encoding: "utf8" });
      } else {
        appendFileSync(resolvedPath, line, { encoding: "utf8" });
      }
    } catch {
      process.stderr.write(`[LCM ERROR LOGGER] Failed to write log: ${line}`);
    }
  };
}

const defaultLogger = createErrorLogger(".lcm/errors.log");

export function handlePipelineError(
  error: unknown,
  stage: string,
  state: unknown,
): { action: "passthrough" | "partial" | "retry" } {
  defaultLogger(error, `pipeline:${stage}`);

  if (error instanceof LcmError) {
    if (error.code.startsWith("DB_")) {
      return { action: "passthrough" };
    }

    if (error.recoverable) {
      return { action: "retry" };
    }
  }

  if (
    state !== null &&
    state !== undefined &&
    typeof state === "object" &&
    "assembledContext" in state &&
    Array.isArray((state as Record<string, unknown>).assembledContext) &&
    ((state as Record<string, unknown>).assembledContext as unknown[]).length > 0
  ) {
    return { action: "partial" };
  }

  return { action: "passthrough" };
}
