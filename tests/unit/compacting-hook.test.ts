import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Database } from "bun:sqlite";
import { storeSummary } from "../../src/summaries/dag-store";
import { createTestDb, cleanupTestDb, seedTestMessages } from "../helpers/db";
import { mockConfig } from "../helpers/mocks";

async function loadHookModule() {
  return import(`../../src/index.ts?test=${crypto.randomUUID()}`);
}

describe("compacting hook", () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    mock.restore();
    cleanupTestDb(db);
  });

  it("triggers LCM compaction", async () => {
    mock.module("ai", () => ({
      generateText: async () => ({
        text: "summary",
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    }));

    const conversationId = "conv-compacting-hook";
    seedTestMessages(db, conversationId, 22);
    storeSummary(db, conversationId, {
      depth: 4,
      content: "existing summary",
      tokenCount: 20,
      parentIds: [],
      messageIds: [],
      compactionLevel: "normal",
      conversationId,
    });

    const { createSessionCompactingHandler, createSessionState } = await loadHookModule();
    const state = createSessionState(mockConfig({ dbPath: ":memory:" }));
    state.db = db;
    state.sessionId = conversationId;

    const output: { context: string[]; prompt?: string } = { context: [] };
    const handler = createSessionCompactingHandler(state);

    await handler({ sessionID: conversationId }, output);

    expect(state.compactionCount).toBe(1);
    expect(output.prompt).toContain("LCM");
    expect(output.prompt).toContain("summaries");
  });

  it("increments compaction counter", async () => {
    mock.module("ai", () => ({
      generateText: async () => ({
        text: "summary",
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    }));

    const conversationId = "conv-compacting-counter";
    seedTestMessages(db, conversationId, 5);

    const { createSessionCompactingHandler, createSessionState } = await loadHookModule();
    const state = createSessionState(mockConfig({ dbPath: ":memory:" }));
    state.db = db;
    state.sessionId = conversationId;

    const handler = createSessionCompactingHandler(state);
    const output1: { context: string[]; prompt?: string } = { context: [] };
    const output2: { context: string[]; prompt?: string } = { context: [] };

    await handler({ sessionID: conversationId }, output1);
    await handler({ sessionID: conversationId }, output2);

    expect(state.compactionCount).toBe(2);
  });

  it("error fallback", async () => {
    mock.module("ai", () => ({
      generateText: async () => ({
        text: "summary",
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    }));

    const conversationId = "conv-compacting-error";
    seedTestMessages(db, conversationId, 10);

    const { createSessionCompactingHandler, createSessionState } = await loadHookModule();
    const state = createSessionState(mockConfig({ dbPath: ":memory:" }));
    db.close();
    state.db = db;
    state.sessionId = conversationId;

    const output: { context: string[]; prompt?: string } = { context: [] };
    const handler = createSessionCompactingHandler(state);

    await expect(handler({ sessionID: conversationId }, output)).resolves.toBeUndefined();

    expect(output.prompt).toBe("LCM compaction failed, native compaction proceeding");
  });

  it("no crash without db", async () => {
    mock.module("ai", () => ({
      generateText: async () => ({
        text: "summary",
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    }));

    const { createSessionCompactingHandler, createSessionState } = await loadHookModule();
    const state = createSessionState(mockConfig({ dbPath: ":memory:" }));
    state.db = null;
    state.sessionId = "conv-compacting-no-db";

    const output: { context: string[]; prompt?: string } = { context: [] };
    const handler = createSessionCompactingHandler(state);

    await expect(handler({ sessionID: state.sessionId }, output)).resolves.toBeUndefined();

    expect(output.prompt).toBe("Return only: LCM initializing. Do not summarize.");
  });
});
