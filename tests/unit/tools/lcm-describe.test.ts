import { describe, it, expect, beforeEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { createTestDb, cleanupTestDb, seedTestMessages } from "../../helpers/db";
import { lcmDescribe, createDescribeToolDefinition } from "../../../src/tools/lcm-describe";
import { DEFAULT_CONFIG } from "../../../src/types";
import type { HookSessionState } from "../../../src/index";
import { storeSummary, linkSummaryToMessages } from "../../../src/summaries/dag-store";
import { markMessagesSummarized } from "../../../src/messages/persistence";

const CONVERSATION_ID = "test-conv-describe";

describe("lcmDescribe", () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it("describe on empty session — no crashes, all zeros", () => {
    db.query("INSERT OR IGNORE INTO conversations (id, session_id) VALUES (?, ?)").run(
      CONVERSATION_ID,
      `session-${CONVERSATION_ID}`,
    );

    const result = lcmDescribe(db, CONVERSATION_ID, DEFAULT_CONFIG);

    expect(result).toContain("Total Messages: 0");
    expect(result).toContain("Total summaries: 0");
    expect(result).not.toContain("NaN");
    expect(result).not.toContain("undefined");
    expect(result).toContain(`Session: ${CONVERSATION_ID}`);
    expect(result).toContain("Unsummarized (fresh tail): 0");
    expect(result).toContain(`Max tokens: ${DEFAULT_CONFIG.maxContextTokens}`);
    expect(result).toContain("Messages indexed: 0");
    expect(result).toContain("Summaries indexed: 0");
  });

  it("describe on populated session — correct message and summary counts", () => {
    const messages = seedTestMessages(db, CONVERSATION_ID, 30);

    const leaf1 = storeSummary(db, CONVERSATION_ID, {
      depth: 0,
      content: "Leaf summary 1",
      tokenCount: 10,
      parentIds: [],
      messageIds: [],
      compactionLevel: "normal",
      conversationId: CONVERSATION_ID,
    });
    const leaf2 = storeSummary(db, CONVERSATION_ID, {
      depth: 0,
      content: "Leaf summary 2",
      tokenCount: 10,
      parentIds: [],
      messageIds: [],
      compactionLevel: "normal",
      conversationId: CONVERSATION_ID,
    });
    const leaf3 = storeSummary(db, CONVERSATION_ID, {
      depth: 0,
      content: "Leaf summary 3",
      tokenCount: 10,
      parentIds: [],
      messageIds: [],
      compactionLevel: "normal",
      conversationId: CONVERSATION_ID,
    });
    const leaf4 = storeSummary(db, CONVERSATION_ID, {
      depth: 0,
      content: "Leaf summary 4",
      tokenCount: 10,
      parentIds: [],
      messageIds: [],
      compactionLevel: "normal",
      conversationId: CONVERSATION_ID,
    });
    storeSummary(db, CONVERSATION_ID, {
      depth: 1,
      content: "Depth-1 summary",
      tokenCount: 20,
      parentIds: [leaf1, leaf2, leaf3, leaf4],
      messageIds: [],
      compactionLevel: "normal",
      conversationId: CONVERSATION_ID,
    });

    const result = lcmDescribe(db, CONVERSATION_ID, DEFAULT_CONFIG);

    expect(result).toContain("Total Messages: 30");
    expect(result).toContain("Depth 0 (leaf): 4 summaries");
    expect(result).toContain("Depth 1: 1 summaries");
    expect(result).toContain("Total summaries: 5");
    expect(result).not.toContain("NaN");
    expect(result).not.toContain("undefined");

    void messages;
  });

  it("describe shows correct fresh tail count", () => {
    const messages = seedTestMessages(db, CONVERSATION_ID, 30);

    const summaryId = storeSummary(db, CONVERSATION_ID, {
      depth: 0,
      content: "A summary covering first 20 messages",
      tokenCount: 50,
      parentIds: [],
      messageIds: messages.slice(0, 20).map((m) => m.id),
      compactionLevel: "normal",
      conversationId: CONVERSATION_ID,
    });

    linkSummaryToMessages(db, summaryId, messages.slice(0, 20).map((m) => m.id));
    markMessagesSummarized(db, messages.slice(0, 20).map((m) => m.id), summaryId);

    const result = lcmDescribe(db, CONVERSATION_ID, DEFAULT_CONFIG);

    expect(result).toContain("Total Messages: 30");
    expect(result).toContain("Unsummarized (fresh tail): 10");
  });

  it("only shows depths with summaries — no zero-count depth lines", () => {
    seedTestMessages(db, CONVERSATION_ID, 5);

    storeSummary(db, CONVERSATION_ID, {
      depth: 0,
      content: "Depth 0 summary",
      tokenCount: 10,
      parentIds: [],
      messageIds: [],
      compactionLevel: "normal",
      conversationId: CONVERSATION_ID,
    });

    storeSummary(db, CONVERSATION_ID, {
      depth: 2,
      content: "Depth 2 summary",
      tokenCount: 15,
      parentIds: [],
      messageIds: [],
      compactionLevel: "normal",
      conversationId: CONVERSATION_ID,
    });

    const result = lcmDescribe(db, CONVERSATION_ID, DEFAULT_CONFIG);

    expect(result).toContain("Depth 0 (leaf): 1 summaries");
    expect(result).toContain("Depth 2: 1 summaries");
    expect(result).not.toContain("Depth 1:");
    expect(result).toContain("Total summaries: 2");
  });
});

describe("createDescribeToolDefinition", () => {
  it("returns LCM not initialized when db is null", async () => {
    const state: HookSessionState = {
      sessionId: null,
      db: null,
      config: { ...DEFAULT_CONFIG },
      isCompacting: false,
      compactionCount: 0,
    };
    const def = createDescribeToolDefinition(state);
    const result = await def.execute({}, {} as never);
    expect(result).toBe("LCM not initialized yet");
  });

  it("returns LCM not initialized when sessionId is null", async () => {
    const db = createTestDb();
    const state: HookSessionState = {
      sessionId: null,
      db,
      config: { ...DEFAULT_CONFIG },
      isCompacting: false,
      compactionCount: 0,
    };
    const def = createDescribeToolDefinition(state);
    const result = await def.execute({}, {} as never);
    expect(result).toBe("LCM not initialized yet");
    cleanupTestDb(db);
  });

  it("delegates to lcmDescribe when initialized", async () => {
    const db = createTestDb();
    seedTestMessages(db, CONVERSATION_ID, 5);
    const state: HookSessionState = {
      sessionId: CONVERSATION_ID,
      db,
      config: { ...DEFAULT_CONFIG },
      isCompacting: false,
      compactionCount: 0,
    };
    const def = createDescribeToolDefinition(state);
    const result = await def.execute({}, {} as never);
    expect(typeof result).toBe("string");
    expect(result).toContain("=== LCM Session State ===");
    expect(result).toContain("Total Messages: 5");
    cleanupTestDb(db);
  });
});
