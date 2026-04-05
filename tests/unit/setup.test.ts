import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { createTestDb, cleanupTestDb, seedTestMessages, seedTestSummaries } from "../helpers/db";
import { mockMessage, mockSessionState, mockSummary } from "../helpers/mocks";
import { SAMPLE_MESSAGES } from "../fixtures/sample-messages";

describe("Test infrastructure", () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    cleanupTestDb(db);
  });

  it("creates an in-memory database with all tables", () => {
    const tables = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all();
    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain("messages");
    expect(tableNames).toContain("summaries");
    expect(tableNames).toContain("conversations");
  });

  it("seed helpers insert messages and summaries", () => {
    const messages = seedTestMessages(db, "test-conversation-1", 4);
    const summaries = seedTestSummaries(db, "test-conversation-1", messages.map((m) => m.id));

    expect(messages).toHaveLength(4);
    expect(summaries).toHaveLength(1);

    const messageCount = db
      .query<{ count: number }, []>("SELECT COUNT(*) as count FROM messages")
      .get()?.count;
    const summaryCount = db
      .query<{ count: number }, []>("SELECT COUNT(*) as count FROM summaries")
      .get()?.count;

    expect(messageCount).toBe(4);
    expect(summaryCount).toBe(1);
  });

  it("mockMessage returns valid LcmMessage", () => {
    const msg = mockMessage();
    expect(msg.id).toBeTruthy();
    expect(msg.role).toBe("user");
    expect(typeof msg.tokenCount).toBe("number");
  });

  it("mockSummary returns valid Summary", () => {
    const summary = mockSummary();
    expect(summary.id).toBeTruthy();
    expect(summary.depth).toBe(0);
    expect(Array.isArray(summary.parentIds)).toBe(true);
  });

  it("mockSessionState returns valid SessionState", () => {
    const state = mockSessionState();
    expect(typeof state.sessionId).toBe("string");
    expect(state.messageCount).toBe(0);
  });

  it("sample messages fixture has 20+ messages", () => {
    expect(SAMPLE_MESSAGES.length).toBeGreaterThanOrEqual(20);
  });

  it("sample messages have varied roles", () => {
    const roles = new Set(SAMPLE_MESSAGES.map((m) => m.role));
    expect(roles.size).toBeGreaterThanOrEqual(2);
  });
});
