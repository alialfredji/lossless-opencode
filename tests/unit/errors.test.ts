import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  LcmError,
  createErrorLogger,
  handlePipelineError,
  retryWithBackoff,
  wrapAsync,
  wrapSync,
} from "../../src/errors/handler";

describe("LcmError", () => {
  it("has correct fields", () => {
    const err = new LcmError("test error", "DB_ERROR", false, { key: "val" });
    expect(err.message).toBe("test error");
    expect(err.code).toBe("DB_ERROR");
    expect(err.recoverable).toBe(false);
    expect(err.context).toEqual({ key: "val" });
    expect(err.name).toBe("LcmError");
    expect(err instanceof Error).toBeTrue();
    expect(err instanceof LcmError).toBeTrue();
  });

  it("defaults context to empty object", () => {
    const err = new LcmError("msg", "CODE", true);
    expect(err.context).toEqual({});
  });
});

describe("wrapAsync", () => {
  it("returns fn result on success", async () => {
    const result = await wrapAsync(() => Promise.resolve(42), 0, "test");
    expect(result).toBe(42);
  });

  it("returns fallback when fn throws", async () => {
    const result = await wrapAsync(
      () => Promise.reject(new Error("boom")),
      -1,
      "test-context",
    );
    expect(result).toBe(-1);
  });

  it("does not throw when fn throws", async () => {
    let threw = false;
    try {
      await wrapAsync(() => Promise.reject(new LcmError("fail", "DB_ERROR", false)), null, "ctx");
    } catch {
      threw = true;
    }
    expect(threw).toBeFalse();
  });

  it("returns fallback for non-Error throws", async () => {
    const result = await wrapAsync(
      () => Promise.reject("string error"),
      "fallback",
      "ctx",
    );
    expect(result).toBe("fallback");
  });
});

describe("wrapSync", () => {
  it("returns fn result on success", () => {
    const result = wrapSync(() => "hello", "fallback", "ctx");
    expect(result).toBe("hello");
  });

  it("returns fallback when fn throws", () => {
    const result = wrapSync(() => {
      throw new Error("sync fail");
    }, 99, "sync-ctx");
    expect(result).toBe(99);
  });

  it("does not throw when fn throws", () => {
    let threw = false;
    try {
      wrapSync(() => {
        throw new LcmError("fail", "FTS_ERROR", true);
      }, null, "ctx");
    } catch {
      threw = true;
    }
    expect(threw).toBeFalse();
  });
});

describe("retryWithBackoff", () => {
  let origSetTimeout: typeof globalThis.setTimeout;

  beforeEach(() => {
    origSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: TimerHandler) => {
      (fn as () => void)();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof globalThis.setTimeout;
  });

  afterEach(() => {
    globalThis.setTimeout = origSetTimeout;
  });

  it("returns result on first success", async () => {
    const result = await retryWithBackoff(() => Promise.resolve("ok"), {
      maxRetries: 3,
      initialDelay: 10,
      maxDelay: 100,
      retryIf: () => true,
    });
    expect(result).toBe("ok");
  });

  it("calls fn exactly maxRetries+1 times on repeated failure then throws", async () => {
    let calls = 0;
    const err = new LcmError("fail", "SUMMARIZE_FAILED", true);

    await expect(
      retryWithBackoff(
        () => {
          calls += 1;
          return Promise.reject(err);
        },
        {
          maxRetries: 3,
          initialDelay: 10,
          maxDelay: 100,
          retryIf: () => true,
        },
      ),
    ).rejects.toThrow("fail");

    expect(calls).toBe(4);
  });

  it("succeeds on 3rd try after 2 failures", async () => {
    let calls = 0;

    const result = await retryWithBackoff(
      () => {
        calls += 1;
        if (calls < 3) {
          return Promise.reject(new LcmError("transient", "SUMMARIZE_FAILED", true));
        }
        return Promise.resolve("success");
      },
      {
        maxRetries: 3,
        initialDelay: 10,
        maxDelay: 100,
        retryIf: (err) => err instanceof LcmError && err.recoverable,
      },
    );

    expect(result).toBe("success");
    expect(calls).toBe(3);
  });

  it("does NOT retry when retryIf returns false — exactly 1 call total", async () => {
    let calls = 0;
    const err = new LcmError("unrecoverable", "DB_CORRUPT", false);

    await expect(
      retryWithBackoff(
        () => {
          calls += 1;
          return Promise.reject(err);
        },
        {
          maxRetries: 5,
          initialDelay: 10,
          maxDelay: 100,
          retryIf: (e) => e instanceof LcmError && e.recoverable,
        },
      ),
    ).rejects.toThrow("unrecoverable");

    expect(calls).toBe(1);
  });
});

describe("createErrorLogger", () => {
  let tmpDir: string;
  let logPath: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `lcm-test-${crypto.randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
    logPath = join(tmpDir, "errors.log");
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("writes log line with correct format", () => {
    const logger = createErrorLogger(logPath);
    const err = new LcmError("disk full", "DB_WRITE", false);
    logger(err, "persist-stage");

    const contents = readFileSync(logPath, "utf8");
    expect(contents).toMatch(/^\[\d{4}-\d{2}-\d{2}T.*Z\] \[DB_WRITE\] persist-stage: disk full\n$/);
  });

  it("uses UNKNOWN code for plain Error", () => {
    const logger = createErrorLogger(logPath);
    logger(new Error("plain error"), "test-stage");

    const contents = readFileSync(logPath, "utf8");
    expect(contents).toContain("[UNKNOWN] test-stage: plain error");
  });

  it("appends multiple log lines", () => {
    const logger = createErrorLogger(logPath);
    logger(new Error("first"), "stage-a");
    logger(new Error("second"), "stage-b");

    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("first");
    expect(lines[1]).toContain("second");
  });

  it("truncates file when size exceeds 1MB before writing", () => {
    const logger = createErrorLogger(logPath);
    const bigLine = "x".repeat(1024 * 1024 + 1);
    const { writeFileSync } = require("node:fs");
    writeFileSync(logPath, bigLine);

    logger(new Error("after rotation"), "rotate-stage");

    const contents = readFileSync(logPath, "utf8");
    expect(contents).not.toContain("x".repeat(100));
    expect(contents).toContain("after rotation");
  });
});

describe("handlePipelineError", () => {
  it("returns passthrough for non-recoverable LcmError", () => {
    const err = new LcmError("schema mismatch", "SCHEMA_ERROR", false);
    const result = handlePipelineError(err, "persist", null);
    expect(result.action).toBe("passthrough");
  });

  it("returns retry for recoverable LcmError", () => {
    const err = new LcmError("rate limited", "SUMMARIZE_FAILED", true);
    const result = handlePipelineError(err, "summarize", null);
    expect(result.action).toBe("retry");
  });

  it("returns passthrough for DB_ error code regardless of recoverable flag", () => {
    const err = new LcmError("db locked", "DB_LOCK", true);
    const result = handlePipelineError(err, "compact", null);
    expect(result.action).toBe("passthrough");
  });

  it("returns passthrough for generic Error", () => {
    const err = new Error("something unknown");
    const result = handlePipelineError(err, "fts", null);
    expect(result.action).toBe("passthrough");
  });

  it("returns passthrough for unknown non-Error throw", () => {
    const result = handlePipelineError("string error", "pipeline", null);
    expect(result.action).toBe("passthrough");
  });

  it("returns partial when state has assembled context", () => {
    const err = new Error("unknown failure");
    const state = { assembledContext: [{ type: "message", content: "hello" }] };
    const result = handlePipelineError(err, "format", state);
    expect(result.action).toBe("partial");
  });

  it("returns passthrough when state assembled context is empty", () => {
    const err = new Error("fail");
    const state = { assembledContext: [] };
    const result = handlePipelineError(err, "format", state);
    expect(result.action).toBe("passthrough");
  });
});
