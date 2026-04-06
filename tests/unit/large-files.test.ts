import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { createTestDb, cleanupTestDb } from "../helpers";
import {
  detectLargeContent,
  extractAndStore,
  retrieveLargeFile,
  retrieveLargeFileByPath,
  getLargeFileStats,
} from "../../src/files/large-file-handler";
import { persistMessage } from "../../src/messages/persistence";
import type { LcmMessage } from "../../src/types";
import { countTokens } from "../../src/utils/tokens";

const CONVERSATION_ID = "conv-large-files-001";
const SESSION_ID = `session-${CONVERSATION_ID}`;

function setupConversation(db: Database): void {
  db.query("INSERT OR IGNORE INTO conversations (id, session_id) VALUES (?, ?)").run(
    CONVERSATION_ID,
    SESSION_ID,
  );
}

function makeMessage(content: string, overrides?: Partial<LcmMessage>): LcmMessage {
  return {
    id: crypto.randomUUID(),
    role: "user",
    content,
    timestamp: new Date().toISOString(),
    sessionId: SESSION_ID,
    tokenCount: countTokens(content),
    summarized: false,
    sequenceNumber: 1,
    conversationId: CONVERSATION_ID,
    ...overrides,
  };
}

function makeLargeContent(targetTokens: number): string {
  const words = "The quick brown fox jumps over the lazy dog. ";
  let result = "";
  while (countTokens(result) < targetTokens) {
    result += words;
  }
  return result;
}

describe("detect and store large content", () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
    setupConversation(db);
  });

  afterEach(() => {
    cleanupTestDb(db);
  });

  it("stores large content and returns compact reference", () => {
    const largeContent = makeLargeContent(200);
    const message = makeMessage(largeContent);
    const threshold = 100;

    const result = extractAndStore(db, CONVERSATION_ID, message, threshold);

    const rows = db
      .query("SELECT * FROM large_files WHERE conversation_id = ?")
      .all(CONVERSATION_ID) as { id: string; content: string; token_count: number }[];

    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe(largeContent);
    expect(rows[0].token_count).toBeGreaterThan(threshold);

    expect(result.content).not.toBe(largeContent);
    expect(result.content).toContain("[Large file:");
    expect(result.content).toContain("use lcm_expand_query to retrieve");
    expect(result.tokenCount).toBeLessThan(message.tokenCount);
  });

  it("stores null message_id when message is not persisted yet", () => {
    const largeContent = makeLargeContent(200);
    const message = makeMessage(largeContent);
    const threshold = 100;

    extractAndStore(db, CONVERSATION_ID, message, threshold);

    const row = db
      .query("SELECT message_id FROM large_files WHERE conversation_id = ?")
      .get(CONVERSATION_ID) as { message_id: string | null };

    expect(row.message_id).toBeNull();
  });

  it("stores message_id when message has already been persisted", () => {
    const largeContent = makeLargeContent(200);
    const message = makeMessage(largeContent);
    const threshold = 100;

    persistMessage(db, CONVERSATION_ID, message);
    extractAndStore(db, CONVERSATION_ID, message, threshold);

    const row = db
      .query("SELECT message_id FROM large_files WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(CONVERSATION_ID) as { message_id: string | null };

    expect(row.message_id).toBe(message.id);
  });
});

describe("retrieve by file id", () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
    setupConversation(db);
  });

  afterEach(() => {
    cleanupTestDb(db);
  });

  it("retrieves stored large file by id", () => {
    const largeContent = makeLargeContent(200);
    const message = makeMessage(largeContent);
    const threshold = 100;

    extractAndStore(db, CONVERSATION_ID, message, threshold);

    const row = db
      .query("SELECT id FROM large_files WHERE conversation_id = ?")
      .get(CONVERSATION_ID) as { id: string };

    const retrieved = retrieveLargeFile(db, row.id);

    expect(retrieved).not.toBeNull();
    expect(retrieved!.content).toBe(largeContent);
    expect(retrieved!.conversationId).toBe(CONVERSATION_ID);
  });

  it("returns null for unknown file id", () => {
    const result = retrieveLargeFile(db, crypto.randomUUID());
    expect(result).toBeNull();
  });
});

describe("retrieve by path", () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
    setupConversation(db);
  });

  afterEach(() => {
    cleanupTestDb(db);
  });

  it("retrieves stored large file by original path", () => {
    const originalPath = "src/index.ts";
    const largeContent = `<file path="${originalPath}">\n${makeLargeContent(200)}</file>`;
    const message = makeMessage(largeContent);
    const threshold = 100;

    extractAndStore(db, CONVERSATION_ID, message, threshold);

    const retrieved = retrieveLargeFileByPath(db, CONVERSATION_ID, originalPath);

    expect(retrieved).not.toBeNull();
    expect(retrieved!.content).toBe(largeContent);
    expect(retrieved!.originalPath).toBe(originalPath);
  });

  it("returns null when path not found", () => {
    const result = retrieveLargeFileByPath(db, CONVERSATION_ID, "nonexistent/path.ts");
    expect(result).toBeNull();
  });
});

describe("below threshold content is ignored", () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
    setupConversation(db);
  });

  afterEach(() => {
    cleanupTestDb(db);
  });

  it("returns message unchanged when below threshold", () => {
    const smallContent = "This is a small message with about one hundred tokens of content.";
    const message = makeMessage(smallContent);
    const threshold = 50000;

    const result = extractAndStore(db, CONVERSATION_ID, message, threshold);

    expect(result).toBe(message);
    expect(result.content).toBe(smallContent);

    const rows = db
      .query("SELECT * FROM large_files WHERE conversation_id = ?")
      .all(CONVERSATION_ID);
    expect(rows).toHaveLength(0);
  });

  it("detectLargeContent returns isLarge false below threshold", () => {
    const smallContent = "Short content that does not exceed the threshold.";
    const message = makeMessage(smallContent);
    const result = detectLargeContent(message, 50000);

    expect(result.isLarge).toBe(false);
    expect(result.parts).toHaveLength(0);
  });
});

describe("getLargeFileStats", () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
    setupConversation(db);
  });

  afterEach(() => {
    cleanupTestDb(db);
  });

  it("returns correct count and totalTokensSaved for 3 stored files", () => {
    const threshold = 100;
    const expectedTokens: number[] = [];

    for (let i = 0; i < 3; i++) {
      const largeContent = makeLargeContent(200 + i * 50);
      const tokens = countTokens(largeContent);
      expectedTokens.push(tokens);
      const message = makeMessage(largeContent, {
        id: crypto.randomUUID(),
        sequenceNumber: i + 1,
      });
      extractAndStore(db, CONVERSATION_ID, message, threshold);
    }

    const stats = getLargeFileStats(db, CONVERSATION_ID);

    expect(stats.count).toBe(3);
    expect(stats.totalTokensSaved).toBe(expectedTokens.reduce((a, b) => a + b, 0));
  });

  it("returns zero stats for conversation with no large files", () => {
    const stats = getLargeFileStats(db, CONVERSATION_ID);
    expect(stats.count).toBe(0);
    expect(stats.totalTokensSaved).toBe(0);
  });
});
