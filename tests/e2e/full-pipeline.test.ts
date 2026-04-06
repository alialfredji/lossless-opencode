import { afterEach, describe, expect, it, mock } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Hooks } from "@opencode-ai/plugin";
import { cleanupTestDb, createTestDb } from "../helpers/db";
import { DEFAULT_CONFIG, type LcmConfig } from "../../src/types";
import type { HookSessionState } from "../../src/index";

type TransformHook = NonNullable<Hooks["experimental.chat.messages.transform"]>;
type TransformMessage = Parameters<TransformHook>[1]["messages"][number];

let currentDb: Database | null = null;

async function mockWorkingSummarizer(tag: string): Promise<void> {
  mock.module("ai", () => ({
    generateText: async ({ prompt }: { prompt: string }) => ({
      text: `Summary of ${prompt.length} chars: [MOCK_SUMMARY_${prompt.length}]`,
      usage: {
        inputTokens: Math.max(1, Math.ceil(prompt.length / 4)),
        outputTokens: 24,
      },
    }),
  }));

  const actualSummarizer = await import(`../../src/summarization/summarizer.ts?actual=${tag}`);
  mock.module("../../src/summarization/summarizer", () => ({
    ...actualSummarizer,
    summarize: async (
      _config: LcmConfig,
      messages: Array<{ content: string }>,
      opts: { depth: number; aggressive?: boolean },
    ) => {
      const promptLength = messages.reduce((total, message) => total + message.content.length, 0);
      return {
        text:
          opts.depth === 0
            ? `Summary of ${promptLength} chars: [MOCK_SUMMARY_${promptLength}]`
            : `condensed depth ${opts.depth}: ${messages.length}`,
        inputTokens: Math.max(1, Math.ceil(promptLength / 4)),
        outputTokens: 64,
      };
    },
    batchSummarize: async (
      _config: LcmConfig,
      messageBatches: Array<Array<{ content: string }>>,
      opts: { depth: number; aggressive?: boolean } = { depth: 0 },
    ) =>
      Promise.all(
        messageBatches.map(async (batch) => ({
          text:
            opts.depth === 0
              ? `Summary of ${batch.reduce((total, message) => total + message.content.length, 0)} chars`
              : `condensed depth ${opts.depth}: ${batch.length}`,
          inputTokens: Math.max(
            1,
            Math.ceil(batch.reduce((total, message) => total + message.content.length, 0) / 4),
          ),
          outputTokens: 64,
        })),
      ),
  }));
}

async function mockFailingSummarizer(tag: string): Promise<void> {
  mock.module("ai", () => ({
    generateText: async () => {
      throw new Error("mock summarizer failure");
    },
  }));

  const actualSummarizer = await import(`../../src/summarization/summarizer.ts?actual=${tag}`);
  mock.module("../../src/summarization/summarizer", () => ({
    ...actualSummarizer,
    summarize: async () => {
      throw new Error("mock summarizer failure");
    },
    batchSummarize: async () => {
      throw new Error("mock summarizer failure");
    },
  }));
}

async function loadRuntime(tag: string = crypto.randomUUID()) {
  const actualEngine = await import(`../../src/compaction/engine.ts?actual=${tag}`);

  mock.module("../../src/compaction/engine", () => ({
    ...actualEngine,
  }));

  const [{ runPipeline }, assembler, integrity, grep, describeTool, expand, session] = await Promise.all([
    import(`../../src/pipeline.ts?tag=${tag}`),
    import(`../../src/context/assembler.ts?tag=${tag}`),
    import(`../../src/integrity/checker.ts?tag=${tag}`),
    import(`../../src/tools/lcm-grep.ts?tag=${tag}`),
    import(`../../src/tools/lcm-describe.ts?tag=${tag}`),
    import(`../../src/tools/lcm-expand-query.ts?tag=${tag}`),
    import(`../../src/session/manager.ts?tag=${tag}`),
  ]);

  return {
    runPipeline,
    assembleContext: assembler.assembleContext,
    estimateContextTokens: assembler.estimateContextTokens,
    runIntegrityChecks: integrity.runIntegrityChecks,
    createGrepToolDefinition: grep.createGrepToolDefinition,
    createDescribeToolDefinition: describeTool.createDescribeToolDefinition,
    createExpandQueryToolDefinition: expand.createExpandQueryToolDefinition,
    resetSession: session.resetSession,
  };
}

function createState(
  db: Database,
  sessionId: string,
  overrides: Partial<LcmConfig> = {},
): HookSessionState {
  db.query("INSERT OR IGNORE INTO conversations (id, session_id) VALUES (?, ?)").run(
    sessionId,
    sessionId,
  );

  return {
    sessionId,
    db,
    config: {
      ...DEFAULT_CONFIG,
      maxContextTokens: 50_000,
      ...overrides,
    },
    isCompacting: false,
    compactionCount: 0,
  };
}

function makeMessage(
  role: "user" | "assistant",
  content: string,
  sessionId: string,
  parentID?: string,
): TransformMessage {
  const id = crypto.randomUUID();
  const created = Date.now();

  if (role === "user") {
    return {
      info: {
        id,
        sessionID: sessionId,
        role,
        time: { created },
        agent: "test-agent",
        model: {
          providerID: "anthropic",
          modelID: "claude-sonnet-4-5",
        },
      },
      parts: [
        {
          id: crypto.randomUUID(),
          sessionID: sessionId,
          messageID: id,
          type: "text",
          text: content,
        },
      ],
    };
  }

  return {
    info: {
      id,
      sessionID: sessionId,
      role,
      time: { created, completed: created },
      parentID: parentID ?? crypto.randomUUID(),
      modelID: "claude-sonnet-4-5",
      providerID: "anthropic",
      mode: "default",
      path: { cwd: "", root: "" },
      summary: false,
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    },
    parts: [
      {
        id: crypto.randomUUID(),
        sessionID: sessionId,
        messageID: id,
        type: "text",
        text: content,
      },
    ],
  };
}

function makeConversation(
  sessionId: string,
  count: number,
  options: { keyword?: string; keywordIndex?: number; startAt?: number } = {},
): TransformMessage[] {
  const messages: TransformMessage[] = [];
  let lastMessageId: string | undefined;
  const startAt = options.startAt ?? 1;

  for (let index = 0; index < count; index += 1) {
    const sequence = startAt + index;
    const role = index % 2 === 0 ? "user" : "assistant";
    const keyword =
      options.keyword !== undefined && options.keywordIndex === index ? ` ${options.keyword}` : "";
    const content =
      role === "user"
        ? `User message ${sequence}${keyword}: investigating end-to-end LCM behavior, session tracking, retrieval quality, and compaction thresholds. ${"context detail ".repeat(24)}`
        : `Assistant message ${sequence}${keyword}: describing compaction flow, DAG summaries, retrieval helpers, and integrity checks. ${"implementation note ".repeat(24)}`;

    const message = makeMessage(role, content, sessionId, lastMessageId);
    lastMessageId = message.info.id;
    messages.push(message);
  }

  return messages;
}

function chunkMessages(messages: TransformMessage[], chunkSize: number): TransformMessage[][] {
  const chunks: TransformMessage[][] = [];
  for (let index = 0; index < messages.length; index += chunkSize) {
    chunks.push(messages.slice(index, index + chunkSize));
  }
  return chunks;
}

function makeVeryLargeContent(): string {
  return `<file path="src/huge-file.ts">\n${"export const massiveValue = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';\n".repeat(2500)}</file>`;
}

afterEach(() => {
  mock.restore();

  if (currentDb) {
    cleanupTestDb(currentDb);
    currentDb = null;
  }
});

describe("full pipeline e2e", () => {
  it("runs the full conversation lifecycle end to end", async () => {
    await mockWorkingSummarizer("full-lifecycle");

    const runtime = await loadRuntime("full-lifecycle");
    currentDb = createTestDb();

    const sessionId = "test-session-e2e-lifecycle";
    const state = createState(currentDb, sessionId, {
      summarizeAfterMessages: 10,
      summarizeAfterTokens: 5_000,
      leafSummaryBudget: 140,
      condensedSummaryBudget: 240,
    });

    const conversation = makeConversation(sessionId, 30);
    const batches = chunkMessages(conversation, 5);
    let accumulated: TransformMessage[] = [];
    let latestOutput: TransformMessage[] = [];

    for (const batch of batches) {
      accumulated = [...accumulated, ...batch];
      latestOutput = await runtime.runPipeline(state, accumulated);
      expect(latestOutput.length).toBeGreaterThan(0);
    }

    const summaryCount =
      currentDb
        .query<{ count: number }, [string]>(
          "SELECT COUNT(*) AS count FROM summaries WHERE conversation_id = ?",
        )
        .get(sessionId)?.count ?? 0;

    expect(summaryCount).toBeGreaterThan(0);

    const integrityReport = runtime.runIntegrityChecks(currentDb, sessionId, state.config);
    expect(integrityReport.failed).toBe(0);
    expect(integrityReport.warnings).toBe(0);

    const contextItems = runtime.assembleContext(currentDb, state.config, sessionId);
    expect(runtime.estimateContextTokens(contextItems)).toBeLessThanOrEqual(
      state.config.maxContextTokens,
    );
  });

  it("retrieves stored context accurately through LCM tools", async () => {
    await mockWorkingSummarizer("retrieval-tools");

    const runtime = await loadRuntime("retrieval-tools");
    currentDb = createTestDb();

    const sessionId = "test-session-e2e-retrieval";
    const state = createState(currentDb, sessionId, {
      summarizeAfterMessages: 6,
      summarizeAfterTokens: 2_500,
      leafSummaryBudget: 120,
    });

    const conversation = makeConversation(sessionId, 12, {
      keyword: "UNIQUETERM_XYZ123",
      keywordIndex: 2,
    });

    await runtime.runPipeline(state, conversation);

    const grepTool = runtime.createGrepToolDefinition(state);
    const grepResult = await grepTool.execute({ query: "UNIQUETERM_XYZ123" }, {} as never);
    expect(grepResult).toContain("UNIQUETERM_XYZ123");

    const describeTool = runtime.createDescribeToolDefinition(state);
    const describeResult = await describeTool.execute({}, {} as never);
    expect(describeResult).toContain("=== LCM Session State ===");
    expect(describeResult).toContain("Total Messages:");

    const summaryRow = currentDb
        .query<{ id: string }, [string]>(
          "SELECT id FROM summaries WHERE conversation_id = ? ORDER BY created_at ASC LIMIT 1",
        )
        .get(sessionId);

    expect(summaryRow).not.toBeNull();

    const expandTool = runtime.createExpandQueryToolDefinition(state);
    const expandResult = await expandTool.execute({ target: summaryRow!.id }, {} as never);
    expect(expandResult).toContain(`Summary ${summaryRow!.id}`);
  });

  it("resets session state cleanly and allows a fresh restart", async () => {
    await mockWorkingSummarizer("session-reset");

    const runtime = await loadRuntime("session-reset");
    currentDb = createTestDb();

    const sessionId = "test-session-e2e-reset";
    const state = createState(currentDb, sessionId, {
      summarizeAfterMessages: 6,
      summarizeAfterTokens: 2_500,
      leafSummaryBudget: 120,
    });

    await runtime.runPipeline(state, makeConversation(sessionId, 12));

    const beforeResetCount =
      currentDb
        .query<{ count: number }, [string]>(
          "SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?",
        )
        .get(sessionId)?.count ?? 0;

    expect(beforeResetCount).toBeGreaterThan(0);

    currentDb.query("PRAGMA foreign_keys=OFF").run();
    const resetResult = runtime.resetSession(currentDb, sessionId);
    currentDb.query("PRAGMA foreign_keys=ON").run();
    expect(resetResult.messagesDeleted).toBeGreaterThan(0);

    const remainingMessages =
      currentDb
        .query<{ count: number }, [string]>(
          "SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?",
        )
        .get(sessionId)?.count ?? 0;
    const remainingSummaries =
      currentDb
        .query<{ count: number }, [string]>(
          "SELECT COUNT(*) AS count FROM summaries WHERE conversation_id = ?",
        )
        .get(sessionId)?.count ?? 0;
    const remainingLargeFiles =
      currentDb
        .query<{ count: number }, [string]>(
          "SELECT COUNT(*) AS count FROM large_files WHERE conversation_id = ?",
        )
        .get(sessionId)?.count ?? 0;

    expect(remainingMessages).toBe(0);
    expect(remainingSummaries).toBe(0);
    expect(remainingLargeFiles).toBe(0);

    const freshMessages = makeConversation(sessionId, 4, { startAt: 100 });
    const restartResult = await runtime.runPipeline(state, freshMessages);

    expect(restartResult).toEqual(freshMessages);

    const afterRestartCount =
      currentDb
        .query<{ count: number }, [string]>(
          "SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?",
        )
        .get(sessionId)?.count ?? 0;

    expect(afterRestartCount).toBe(4);
  });

  it("stores oversized content in large_files and keeps runtime output compact", async () => {
    await mockWorkingSummarizer("large-file");

    const runtime = await loadRuntime("large-file");
    currentDb = createTestDb();

    const sessionId = "test-session-e2e-large-file";
    const state = createState(currentDb, sessionId, {
      largeFileThreshold: 25_000,
      summarizeAfterMessages: 1,
      summarizeAfterTokens: 1,
      leafSummaryBudget: 180,
    });

    const largeContent = makeVeryLargeContent();
    const result = await runtime.runPipeline(state, [makeMessage("user", largeContent, sessionId)]);

    const row = currentDb
      .query<{ count: number; placeholder: string | null }, [string]>(
        `SELECT COUNT(*) AS count, MIN(placeholder) AS placeholder
         FROM large_files WHERE conversation_id = ?`,
      )
      .get(sessionId);

    expect(row?.count).toBe(1);
    expect(row?.placeholder).toMatch(/^\[LCM:/);
    expect(
      result.some((message: TransformMessage) =>
        message.parts.some((part) => part.type === "text" && part.text.includes("<context_summary")),
      ),
    ).toBe(true);
    expect(
      result.every((message: TransformMessage) =>
        message.parts.every(
          (part) => part.type !== "text" || !part.text.includes(largeContent.slice(0, 500)),
        ),
      ),
    ).toBe(true);
  });

  it("recovers cleanly after summarizer failure and succeeds on the next run", async () => {
    await mockFailingSummarizer("error-first-pass");

    const failingRuntime = await loadRuntime("error-first-pass");
    currentDb = createTestDb();

    const sessionId = "test-session-e2e-recovery";
    const state = createState(currentDb, sessionId, {
      summarizeAfterMessages: 4,
      summarizeAfterTokens: 1_000,
      leafSummaryBudget: 120,
    });

    const initialMessages = makeConversation(sessionId, 8);
    const failedResult = await failingRuntime.runPipeline(state, initialMessages);

    expect(failedResult).toEqual(initialMessages);

    mock.restore();
    await mockWorkingSummarizer("error-recovery-pass");

    const recoveredRuntime = await loadRuntime("error-recovery-pass");
    const recoveryMessages = makeConversation(sessionId, 2, { startAt: 1000 });
    const recoveredResult = await recoveredRuntime.runPipeline(state, recoveryMessages);

    expect(recoveredResult).not.toEqual(recoveryMessages);
    expect(
      recoveredResult.some((message: TransformMessage) =>
        message.parts.some(
          (part) =>
            part.type === "text" &&
            (part.text.includes("Lossless Context Management") || part.text.includes("<context_summary")),
        ),
      ),
    ).toBe(true);
  });
});
