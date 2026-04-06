import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Hooks } from "@opencode-ai/plugin";
import type { Database } from "bun:sqlite";
import { cleanupTestDb, createTestDb } from "../helpers/db";
import { mockConfig } from "../helpers/mocks";

type TransformHook = NonNullable<Hooks["experimental.chat.messages.transform"]>;
type TransformOutput = Parameters<TransformHook>[1];
type TransformMessage = TransformOutput["messages"][number];

function createUserTransformMessage(sessionID: string, index: number): TransformMessage {
  const messageID = `user-${index.toString().padStart(3, "0")}`;

  return {
    info: {
      id: messageID,
      sessionID,
      role: "user",
      time: {
        created: Date.now() + index,
      },
      agent: "test-agent",
      model: {
        providerID: "test-provider",
        modelID: "test-model",
      },
    },
    parts: [
      {
        id: `part-${messageID}`,
        sessionID,
        messageID,
        type: "text",
        text: `User message ${index} discussing the transform pipeline, compaction thresholds, database persistence, and message assembly details. ${"extra context ".repeat(20)}`,
      },
    ],
  };
}

function createAssistantTransformMessage(
  sessionID: string,
  index: number,
  parentID: string,
): TransformMessage {
  const messageID = `assistant-${index.toString().padStart(3, "0")}`;

  return {
    info: {
      id: messageID,
      sessionID,
      role: "assistant",
      time: {
        created: Date.now() + index,
        completed: Date.now() + index + 1,
      },
      parentID,
      modelID: "test-model",
      providerID: "test-provider",
      mode: "default",
      path: {
        cwd: "/tmp",
        root: "/tmp",
      },
      summary: false,
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: {
          read: 0,
          write: 0,
        },
      },
    },
    parts: [
      {
        id: `part-${messageID}`,
        sessionID,
        messageID,
        type: "text",
        text: `Assistant message ${index} responding with implementation notes for the transform hook, summarization pipeline, indexing flow, and context formatting. ${"implementation detail ".repeat(20)}`,
      },
    ],
  };
}

function createConversationMessages(sessionID: string, count: number): TransformMessage[] {
  const messages: TransformMessage[] = [];
  let previousUserId = "root-user";

  for (let index = 0; index < count; index += 1) {
    if (index % 2 === 0) {
      const userMessage = createUserTransformMessage(sessionID, index + 1);
      previousUserId = userMessage.info.id;
      messages.push(userMessage);
      continue;
    }

    messages.push(createAssistantTransformMessage(sessionID, index + 1, previousUserId));
  }

  return messages;
}

async function loadIndexModule() {
  const actualEngine = await import(`../../src/compaction/engine.ts?actual=${crypto.randomUUID()}`);

  mock.module("../../src/compaction/engine", () => ({
    ...actualEngine,
  }));

  mock.module("ai", () => ({
    generateText: async () => ({
      text: "Compacted summary block with preserved technical details.",
      usage: {
        inputTokens: 400,
        outputTokens: 40,
      },
    }),
  }));

  return import(`../../src/index.ts?test=${crypto.randomUUID()}`);
}

describe("messages.transform integration", () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    mock.restore();
    cleanupTestDb(db);
  });

  it("full pipeline", async () => {
    mock.module("ai", () => ({
      generateText: mock(async () => ({
        text: "Compacted summary block with preserved technical details.",
        usage: {
          inputTokens: 400,
          outputTokens: 40,
        },
      })),
    }));

    const { createMessagesTransformHandler, createSessionState } = await loadIndexModule();
    const state = createSessionState(
      mockConfig({
        dbPath: ":memory:",
        summarizeAfterMessages: 20,
        summarizeAfterTokens: 999999,
        leafSummaryBudget: 180,
      }),
    );

    state.db = db;
    state.sessionId = "transform-full-pipeline";
    db.query("INSERT OR IGNORE INTO conversations (id, session_id) VALUES (?, ?)").run(
      state.sessionId,
      state.sessionId,
    );

    const handler = createMessagesTransformHandler(state);
    const inputMessages = createConversationMessages(state.sessionId, 25);
    const output: TransformOutput = {
      messages: inputMessages.slice(),
    };

    await handler({}, output);

    const persistedCount = db
      .query<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?",
      )
      .get(state.sessionId)?.count;
    const summaryCount = db
      .query<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM summaries WHERE conversation_id = ?",
      )
      .get(state.sessionId)?.count;

    expect(persistedCount).toBe(25);
    expect(summaryCount).toBeGreaterThan(0);
    expect(
      output.messages.length < inputMessages.length ||
        output.messages.some((message) =>
          message.parts.some(
            (part) => part.type === "text" && part.text.includes("<context_summary"),
          ),
        ),
    ).toBe(true);
  });

  it("passthrough on first run", async () => {
    const generateText = mock(async () => ({
      text: "unused summary",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
      },
    }));

    mock.module("ai", () => ({ generateText }));

    const { createMessagesTransformHandler, createSessionState } = await loadIndexModule();
    const state = createSessionState(
      mockConfig({
        dbPath: ":memory:",
        summarizeAfterMessages: 20,
        summarizeAfterTokens: 999999,
      }),
    );

    state.db = db;
    state.sessionId = "transform-first-run";
    db.query("INSERT OR IGNORE INTO conversations (id, session_id) VALUES (?, ?)").run(
      state.sessionId,
      state.sessionId,
    );

    const handler = createMessagesTransformHandler(state);
    const inputMessages = createConversationMessages(state.sessionId, 3);
    const output: TransformOutput = {
      messages: inputMessages.slice(),
    };

    await handler({}, output);

    const persistedCount = db
      .query<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?",
      )
      .get(state.sessionId)?.count;
    const summaryCount = db
      .query<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM summaries WHERE conversation_id = ?",
      )
      .get(state.sessionId)?.count;

    expect(output.messages).toEqual(inputMessages);
    expect(persistedCount).toBe(3);
    expect(summaryCount).toBe(0);
    expect(generateText).not.toHaveBeenCalled();
  });

  it("error fallback", async () => {
    mock.module("../../src/compaction/engine", () => ({
      compact: mock(async () => {
        throw new Error("compaction failed");
      }),
    }));

    mock.module("ai", () => ({
      generateText: mock(async () => ({
        text: "unused",
        usage: {
          inputTokens: 0,
          outputTokens: 0,
        },
      })),
    }));

    const { createMessagesTransformHandler, createSessionState } = await loadIndexModule();
    const state = createSessionState(
      mockConfig({
        dbPath: ":memory:",
        summarizeAfterMessages: 5,
        summarizeAfterTokens: 999999,
      }),
    );

    state.db = db;
    state.sessionId = "transform-error-fallback";
    db.query("INSERT OR IGNORE INTO conversations (id, session_id) VALUES (?, ?)").run(
      state.sessionId,
      state.sessionId,
    );

    const handler = createMessagesTransformHandler(state);
    const inputMessages = createConversationMessages(state.sessionId, 10);
    const output: TransformOutput = {
      messages: inputMessages.slice(),
    };

    await expect(handler({}, output)).resolves.toBeUndefined();
    expect(output.messages.length).toBeLessThanOrEqual(inputMessages.length);
  });
});
