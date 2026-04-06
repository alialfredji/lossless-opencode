import { beforeEach, afterEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { createTestDb, cleanupTestDb, seedTestMessages } from "../helpers";
import { initSession, getSessionInfo, resetSession } from "../../src/session/manager";
import { storeSummary } from "../../src/summaries/dag-store";

const SESSION_ID = "session-test-001";
const OTHER_SESSION_ID = "session-test-002";

function insertMessage(db: Database, conversationId: string, id: string, sequenceNumber: number): void {
  db.query(
    `INSERT INTO messages (id, conversation_id, role, content, token_count, sequence_number, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    conversationId,
    sequenceNumber % 2 === 0 ? "assistant" : "user",
    `message ${sequenceNumber} for ${conversationId}`,
    10 + sequenceNumber,
    sequenceNumber,
    new Date(Date.parse("2024-01-01T10:00:00Z") + (sequenceNumber - 1) * 60_000).toISOString(),
  );
}

describe("session manager", () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    cleanupTestDb(db);
  });

  it("initSession creates valid session state", () => {
    const state = initSession(db, SESSION_ID);

    expect(state).toEqual({
      sessionId: SESSION_ID,
      conversationId: SESSION_ID,
      messageCount: 0,
      lastCompactionAt: null,
      totalTokens: 0,
    });

    const row = db.query("SELECT id, session_id FROM conversations WHERE id = ?").get(SESSION_ID) as {
      id: string;
      session_id: string;
    } | null;

    expect(row).toEqual({ id: SESSION_ID, session_id: SESSION_ID });
  });

  it("getSessionInfo returns accurate counts", () => {
    initSession(db, SESSION_ID);
    const messages = seedTestMessages(db, SESSION_ID, 10);

    storeSummary(db, SESSION_ID, {
      depth: 0,
      content: "summary one",
      tokenCount: 11,
      parentIds: [],
      messageIds: [messages[0].id, messages[1].id],
      compactionLevel: "normal",
      conversationId: SESSION_ID,
    });

    storeSummary(db, SESSION_ID, {
      depth: 1,
      content: "summary two",
      tokenCount: 12,
      parentIds: [],
      messageIds: [messages[2].id, messages[3].id],
      compactionLevel: "normal",
      conversationId: SESSION_ID,
    });

    storeSummary(db, SESSION_ID, {
      depth: 2,
      content: "summary three",
      tokenCount: 13,
      parentIds: [],
      messageIds: [messages[4].id, messages[5].id],
      compactionLevel: "normal",
      conversationId: SESSION_ID,
    });

    const info = getSessionInfo(db, SESSION_ID);
    const expectedTokens = messages.reduce((sum, message) => sum + message.tokenCount, 0);

    expect(info).toEqual({
      sessionId: SESSION_ID,
      messageCount: 10,
      summaryCount: 3,
      dagDepth: 2,
      totalTokens: expectedTokens,
      lastActivityAt: messages[9].timestamp,
    });
  });

  it("resetSession deletes all data", () => {
    initSession(db, SESSION_ID);
    const messages = seedTestMessages(db, SESSION_ID, 4);

    storeSummary(db, SESSION_ID, {
      depth: 0,
      content: "summary",
      tokenCount: 9,
      parentIds: [],
      messageIds: [messages[0].id, messages[1].id],
      compactionLevel: "normal",
      conversationId: SESSION_ID,
    });

    db.query(
      `INSERT INTO large_files (id, conversation_id, message_id, placeholder, original_path, token_count, structural_summary, content)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      crypto.randomUUID(),
      SESSION_ID,
      messages[0].id,
      "[large-file-1]",
      null,
      100,
      "summary",
      "large file content",
    );

    db.query("INSERT INTO context_items (id, conversation_id, item_type, reference_id, depth, position) VALUES (?, ?, ?, ?, ?, ?)").run(
      crypto.randomUUID(),
      SESSION_ID,
      "message",
      messages[0].id,
      0,
      0,
    );

    const result = resetSession(db, SESSION_ID);

    expect(result).toEqual({ messagesDeleted: 4, summariesDeleted: 1, largeFilesDeleted: 1 });

    expect((db.query("SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?").get(SESSION_ID) as { count: number }).count).toBe(0);
    expect((db.query("SELECT COUNT(*) AS count FROM summaries WHERE conversation_id = ?").get(SESSION_ID) as { count: number }).count).toBe(0);
    expect((db.query("SELECT COUNT(*) AS count FROM large_files WHERE conversation_id = ?").get(SESSION_ID) as { count: number }).count).toBe(0);
    expect((db.query("SELECT COUNT(*) AS count FROM context_items WHERE conversation_id = ?").get(SESSION_ID) as { count: number }).count).toBe(0);
    expect((db.query("SELECT COUNT(*) AS count FROM summary_messages").get() as { count: number }).count).toBe(0);
    expect((db.query("SELECT COUNT(*) AS count FROM summary_parents").get() as { count: number }).count).toBe(0);

    expect((db.query("SELECT COUNT(*) AS count FROM conversations WHERE id = ?").get(SESSION_ID) as { count: number }).count).toBe(1);
    expect((db.query("SELECT COUNT(*) AS count FROM messages_fts").get() as { count: number }).count).toBe(0);
    expect((db.query("SELECT COUNT(*) AS count FROM summaries_fts").get() as { count: number }).count).toBe(0);
  });

  it("resetSession is atomic", () => {
    initSession(db, SESSION_ID);
    seedTestMessages(db, SESSION_ID, 2);

    resetSession(db, SESSION_ID);

    const conversation = db.query("SELECT id FROM conversations WHERE id = ?").get(SESSION_ID) as { id: string } | null;
    expect(conversation?.id).toBe(SESSION_ID);
  });

  it("session isolation", () => {
    initSession(db, SESSION_ID);
    initSession(db, OTHER_SESSION_ID);

    for (let i = 1; i <= 3; i++) {
      insertMessage(db, SESSION_ID, `session-1-msg-${i}`, i);
    }
    for (let i = 1; i <= 5; i++) {
      insertMessage(db, OTHER_SESSION_ID, `session-2-msg-${i}`, i);
    }

    storeSummary(db, SESSION_ID, {
      depth: 0,
      content: "session one summary",
      tokenCount: 7,
      parentIds: [],
      messageIds: [],
      compactionLevel: "normal",
      conversationId: SESSION_ID,
    });

    storeSummary(db, OTHER_SESSION_ID, {
      depth: 0,
      content: "session two summary",
      tokenCount: 8,
      parentIds: [],
      messageIds: [],
      compactionLevel: "normal",
      conversationId: OTHER_SESSION_ID,
    });

    resetSession(db, SESSION_ID);

    expect(getSessionInfo(db, SESSION_ID)).toEqual({
      sessionId: SESSION_ID,
      messageCount: 0,
      summaryCount: 0,
      dagDepth: 0,
      totalTokens: 0,
      lastActivityAt: null,
    });

    expect(getSessionInfo(db, OTHER_SESSION_ID)).toEqual({
      sessionId: OTHER_SESSION_ID,
      messageCount: 5,
      summaryCount: 1,
      dagDepth: 0,
      totalTokens: 11 + 12 + 13 + 14 + 15,
      lastActivityAt: new Date(Date.parse("2024-01-01T10:00:00Z") + 4 * 60_000).toISOString(),
    });
  });
});
