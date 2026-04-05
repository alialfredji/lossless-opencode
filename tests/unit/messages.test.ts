import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { createTestDb, cleanupTestDb } from "../helpers";
import { mockMessage } from "../helpers/mocks";
import {
  persistMessage,
  persistMessages,
  getMessages,
  getMessageCount,
  markMessagesSummarized,
  getUnsummarizedMessages,
} from "../../src/messages/persistence";

const CONVERSATION_ID = "conv-test-001";
const SESSION_ID = `session-${CONVERSATION_ID}`;

function setupConversation(db: Database): void {
  db.query("INSERT OR IGNORE INTO conversations (id, session_id) VALUES (?, ?)").run(
    CONVERSATION_ID,
    SESSION_ID,
  );
}

describe("persistMessage + getMessages roundtrip", () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
    setupConversation(db);
  });

  afterEach(() => {
    cleanupTestDb(db);
  });

  it("roundtrip: single message persisted and retrieved correctly", () => {
    const msg = mockMessage({ conversationId: CONVERSATION_ID, sequenceNumber: 1 });
    persistMessage(db, CONVERSATION_ID, msg);

    const retrieved = getMessages(db, CONVERSATION_ID);
    expect(retrieved).toHaveLength(1);
    expect(retrieved[0].id).toBe(msg.id);
    expect(retrieved[0].role).toBe(msg.role);
    expect(retrieved[0].content).toBe(msg.content);
    expect(retrieved[0].conversationId).toBe(CONVERSATION_ID);
    expect(retrieved[0].sessionId).toBe(SESSION_ID);
    expect(retrieved[0].tokenCount).toBe(msg.tokenCount);
  });

  it("roundtrip: sequence_number assigned monotonically", () => {
    const m1 = mockMessage({ id: crypto.randomUUID(), conversationId: CONVERSATION_ID });
    const m2 = mockMessage({ id: crypto.randomUUID(), conversationId: CONVERSATION_ID });
    const m3 = mockMessage({ id: crypto.randomUUID(), conversationId: CONVERSATION_ID });

    persistMessage(db, CONVERSATION_ID, m1);
    persistMessage(db, CONVERSATION_ID, m2);
    persistMessage(db, CONVERSATION_ID, m3);

    const retrieved = getMessages(db, CONVERSATION_ID);
    expect(retrieved).toHaveLength(3);
    expect(retrieved[0].sequenceNumber).toBe(1);
    expect(retrieved[1].sequenceNumber).toBe(2);
    expect(retrieved[2].sequenceNumber).toBe(3);
  });

  it("roundtrip: empty conversation returns empty array", () => {
    const result = getMessages(db, CONVERSATION_ID);
    expect(result).toEqual([]);
  });

  it("roundtrip: unknown conversation returns empty array", () => {
    const result = getMessages(db, "nonexistent-conv");
    expect(result).toEqual([]);
  });

  it("roundtrip: messages ordered by sequence_number ASC", () => {
    const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    for (const id of ids) {
      persistMessage(db, CONVERSATION_ID, mockMessage({ id, conversationId: CONVERSATION_ID }));
    }

    const retrieved = getMessages(db, CONVERSATION_ID);
    expect(retrieved[0].id).toBe(ids[0]);
    expect(retrieved[1].id).toBe(ids[1]);
    expect(retrieved[2].id).toBe(ids[2]);
  });

  it("roundtrip: after option filters by sequence_number", () => {
    for (let i = 0; i < 5; i++) {
      persistMessage(db, CONVERSATION_ID, mockMessage({ id: crypto.randomUUID(), conversationId: CONVERSATION_ID }));
    }

    const result = getMessages(db, CONVERSATION_ID, { after: 3 });
    expect(result).toHaveLength(2);
    expect(result[0].sequenceNumber).toBe(4);
    expect(result[1].sequenceNumber).toBe(5);
  });

  it("roundtrip: limit option restricts result count", () => {
    for (let i = 0; i < 5; i++) {
      persistMessage(db, CONVERSATION_ID, mockMessage({ id: crypto.randomUUID(), conversationId: CONVERSATION_ID }));
    }

    const result = getMessages(db, CONVERSATION_ID, { limit: 2 });
    expect(result).toHaveLength(2);
  });

  it("roundtrip: message_parts record created for each message", () => {
    const msg = mockMessage({ conversationId: CONVERSATION_ID });
    persistMessage(db, CONVERSATION_ID, msg);

    const part = db.query("SELECT * FROM message_parts WHERE message_id = ?").get(msg.id) as {
      part_type: string;
      content: string;
      sequence_number: number;
    };

    expect(part).toBeTruthy();
    expect(part.part_type).toBe("text");
    expect(part.content).toBe(msg.content);
    expect(part.sequence_number).toBe(1);
  });
});

describe("persistMessages atomicity", () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
    setupConversation(db);
  });

  afterEach(() => {
    cleanupTestDb(db);
  });

  it("atomicity: bulk insert persists all messages", () => {
    const messages = Array.from({ length: 5 }, (_, i) =>
      mockMessage({ id: crypto.randomUUID(), conversationId: CONVERSATION_ID, sequenceNumber: i + 1 }),
    );

    persistMessages(db, CONVERSATION_ID, messages);

    const count = getMessageCount(db, CONVERSATION_ID);
    expect(count).toBe(5);
  });

  it("atomicity: bulk insert assigns sequential sequence numbers", () => {
    const messages = Array.from({ length: 3 }, (_, i) =>
      mockMessage({ id: crypto.randomUUID(), conversationId: CONVERSATION_ID, sequenceNumber: i + 1 }),
    );

    persistMessages(db, CONVERSATION_ID, messages);

    const retrieved = getMessages(db, CONVERSATION_ID);
    expect(retrieved[0].sequenceNumber).toBe(1);
    expect(retrieved[1].sequenceNumber).toBe(2);
    expect(retrieved[2].sequenceNumber).toBe(3);
  });

  it("atomicity: empty array inserts nothing", () => {
    persistMessages(db, CONVERSATION_ID, []);
    expect(getMessageCount(db, CONVERSATION_ID)).toBe(0);
  });

  it("atomicity: bulk inserts create message_parts for each message", () => {
    const messages = Array.from({ length: 3 }, () =>
      mockMessage({ id: crypto.randomUUID(), conversationId: CONVERSATION_ID }),
    );

    persistMessages(db, CONVERSATION_ID, messages);

    const partCount = (
      db
        .query(
          `SELECT COUNT(*) AS count FROM message_parts WHERE message_id IN (${messages.map(() => "?").join(",")})`,
        )
        .get(...messages.map((m) => m.id)) as { count: number }
    ).count;

    expect(partCount).toBe(3);
  });
});

describe("getMessageCount", () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
    setupConversation(db);
  });

  afterEach(() => {
    cleanupTestDb(db);
  });

  it("returns 0 for empty conversation", () => {
    expect(getMessageCount(db, CONVERSATION_ID)).toBe(0);
  });

  it("returns correct count after inserts", () => {
    persistMessage(db, CONVERSATION_ID, mockMessage({ id: crypto.randomUUID(), conversationId: CONVERSATION_ID }));
    persistMessage(db, CONVERSATION_ID, mockMessage({ id: crypto.randomUUID(), conversationId: CONVERSATION_ID }));
    expect(getMessageCount(db, CONVERSATION_ID)).toBe(2);
  });
});

describe("markMessagesSummarized + getUnsummarizedMessages unsummarized", () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
    setupConversation(db);
  });

  afterEach(() => {
    cleanupTestDb(db);
  });

  it("unsummarized: all messages unsummarized before marking", () => {
    const msgs = Array.from({ length: 3 }, () =>
      mockMessage({ id: crypto.randomUUID(), conversationId: CONVERSATION_ID }),
    );
    persistMessages(db, CONVERSATION_ID, msgs);

    const unsummarized = getUnsummarizedMessages(db, CONVERSATION_ID);
    expect(unsummarized).toHaveLength(3);
  });

  it("unsummarized: marked messages excluded from unsummarized", () => {
    const msgs = Array.from({ length: 4 }, () =>
      mockMessage({ id: crypto.randomUUID(), conversationId: CONVERSATION_ID }),
    );
    persistMessages(db, CONVERSATION_ID, msgs);

    const summaryId = crypto.randomUUID();

    db.query(
      `INSERT INTO summaries (id, conversation_id, depth, content, token_count, compaction_level)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(summaryId, CONVERSATION_ID, 0, "test summary", 10, "normal");

    markMessagesSummarized(db, [msgs[0].id, msgs[1].id], summaryId);

    const unsummarized = getUnsummarizedMessages(db, CONVERSATION_ID);
    expect(unsummarized).toHaveLength(2);
    const ids = unsummarized.map((m) => m.id);
    expect(ids).not.toContain(msgs[0].id);
    expect(ids).not.toContain(msgs[1].id);
    expect(ids).toContain(msgs[2].id);
    expect(ids).toContain(msgs[3].id);
  });

  it("unsummarized: empty conversation returns empty array", () => {
    const result = getUnsummarizedMessages(db, CONVERSATION_ID);
    expect(result).toEqual([]);
  });

  it("unsummarized: all messages marked returns empty array", () => {
    const msgs = Array.from({ length: 2 }, () =>
      mockMessage({ id: crypto.randomUUID(), conversationId: CONVERSATION_ID }),
    );
    persistMessages(db, CONVERSATION_ID, msgs);

    const summaryId = crypto.randomUUID();
    db.query(
      `INSERT INTO summaries (id, conversation_id, depth, content, token_count, compaction_level)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(summaryId, CONVERSATION_ID, 0, "summary", 5, "normal");

    markMessagesSummarized(db, msgs.map((m) => m.id), summaryId);

    const result = getUnsummarizedMessages(db, CONVERSATION_ID);
    expect(result).toEqual([]);
  });

  it("unsummarized: markMessagesSummarized is idempotent", () => {
    const msg = mockMessage({ id: crypto.randomUUID(), conversationId: CONVERSATION_ID });
    persistMessage(db, CONVERSATION_ID, msg);

    const summaryId = crypto.randomUUID();
    db.query(
      `INSERT INTO summaries (id, conversation_id, depth, content, token_count, compaction_level)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(summaryId, CONVERSATION_ID, 0, "summary", 5, "normal");

    markMessagesSummarized(db, [msg.id], summaryId);
    markMessagesSummarized(db, [msg.id], summaryId);

    const count = (db.query("SELECT COUNT(*) AS count FROM summary_messages WHERE message_id = ?").get(msg.id) as { count: number }).count;
    expect(count).toBe(1);
  });
});
