import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { createTestDb, cleanupTestDb } from "../helpers/db";
import { mockMessage } from "../helpers/mocks";
import {
  persistMessage,
  persistMessages,
  getMessages,
  getMessageCount,
} from "../../src/messages/persistence";

const CONVERSATION_A = "conv-idempotency-a";
const CONVERSATION_B = "conv-idempotency-b";
const SESSION_A = `session-${CONVERSATION_A}`;
const SESSION_B = `session-${CONVERSATION_B}`;

function setupConversations(db: Database): void {
  db.query("INSERT OR IGNORE INTO conversations (id, session_id) VALUES (?, ?)").run(
    CONVERSATION_A,
    SESSION_A,
  );
  db.query("INSERT OR IGNORE INTO conversations (id, session_id) VALUES (?, ?)").run(
    CONVERSATION_B,
    SESSION_B,
  );
}

// Regression: [LCM ERROR] pipeline:persistNewMessages: [UNKNOWN] UNIQUE constraint failed: messages.id
// persistMessage uses plain INSERT. Dual hooks (chat.message + messages.transform) both persist the same message.
describe("Scenario 1: duplicate message ID in same conversation", () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
    setupConversations(db);
  });

  afterEach(() => {
    cleanupTestDb(db);
  });

  it("should handle inserting the same message ID twice without throwing", () => {
    const messageId = "duplicate-msg-001";
    const msg = mockMessage({
      id: messageId,
      conversationId: CONVERSATION_A,
      content: "First insert of this message",
    });

    persistMessage(db, CONVERSATION_A, msg);
    expect(getMessageCount(db, CONVERSATION_A)).toBe(1);

    expect(() => {
      persistMessage(db, CONVERSATION_A, msg);
    }).not.toThrow();

    expect(getMessageCount(db, CONVERSATION_A)).toBe(1);
  });

  it("should preserve original message data on duplicate insert", () => {
    const messageId = "duplicate-msg-002";
    const originalContent = "Original content that should be preserved";
    const msg1 = mockMessage({
      id: messageId,
      conversationId: CONVERSATION_A,
      content: originalContent,
    });

    persistMessage(db, CONVERSATION_A, msg1);

    const msg2 = mockMessage({
      id: messageId,
      conversationId: CONVERSATION_A,
      content: "Different content that should be ignored",
    });

    expect(() => {
      persistMessage(db, CONVERSATION_A, msg2);
    }).not.toThrow();

    const retrieved = getMessages(db, CONVERSATION_A);
    expect(retrieved).toHaveLength(1);
    expect(retrieved[0].content).toBe(originalContent);
  });
});

// messages.id is PRIMARY KEY (globally unique), but messageExists() checks (conversation_id, id).
// Same ID in a different conversation bypasses messageExists but hits the global PK constraint.
describe("Scenario 2: same message ID across different conversations", () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
    setupConversations(db);
  });

  afterEach(() => {
    cleanupTestDb(db);
  });

  it("should handle same message ID in two different conversations", () => {
    const sharedId = "shared-msg-001";

    const msgA = mockMessage({
      id: sharedId,
      conversationId: CONVERSATION_A,
      content: "Message in conversation A",
    });

    const msgB = mockMessage({
      id: sharedId,
      conversationId: CONVERSATION_B,
      content: "Message in conversation B",
    });

    persistMessage(db, CONVERSATION_A, msgA);
    expect(getMessageCount(db, CONVERSATION_A)).toBe(1);

    expect(() => {
      persistMessage(db, CONVERSATION_B, msgB);
    }).not.toThrow();
  });
});

// Exact production scenario: chat.message handler persists first (no existence check),
// then messages.transform pipeline tries the same message (TOCTOU race on messageExists).
describe("Scenario 3: dual-hook persistence race (chat.message + transform)", () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
    setupConversations(db);
  });

  afterEach(() => {
    cleanupTestDb(db);
  });

  it("should survive chat.message persisting before transform pipeline", () => {
    const messageId = "race-msg-001";
    const msg = mockMessage({
      id: messageId,
      conversationId: CONVERSATION_A,
      content: "Message persisted by chat.message hook first",
    });

    db.transaction(() => {
      persistMessage(db, CONVERSATION_A, msg);
    })();

    expect(getMessageCount(db, CONVERSATION_A)).toBe(1);

    expect(() => {
      persistMessage(db, CONVERSATION_A, msg);
    }).not.toThrow();

    expect(getMessageCount(db, CONVERSATION_A)).toBe(1);
  });

  it("should survive transform pipeline persisting before chat.message hook", () => {
    const messageId = "race-msg-002";
    const msg = mockMessage({
      id: messageId,
      conversationId: CONVERSATION_A,
      content: "Message persisted by transform pipeline first",
    });

    persistMessage(db, CONVERSATION_A, msg);
    expect(getMessageCount(db, CONVERSATION_A)).toBe(1);

    expect(() => {
      db.transaction(() => {
        persistMessage(db, CONVERSATION_A, msg);
      })();
    }).not.toThrow();

    expect(getMessageCount(db, CONVERSATION_A)).toBe(1);
  });
});

// persistMessages wraps in a transaction. A duplicate ID in the batch currently
// rolls back the entire batch due to UNIQUE constraint.
describe("Scenario 4: batch persistence with duplicate IDs", () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
    setupConversations(db);
  });

  afterEach(() => {
    cleanupTestDb(db);
  });

  it("should handle batch with pre-existing message IDs", () => {
    const existingMsg = mockMessage({
      id: "batch-msg-002",
      conversationId: CONVERSATION_A,
      content: "Already exists in DB",
    });
    persistMessage(db, CONVERSATION_A, existingMsg);

    const batchMessages = [
      mockMessage({ id: "batch-msg-001", conversationId: CONVERSATION_A, content: "New message 1" }),
      mockMessage({ id: "batch-msg-002", conversationId: CONVERSATION_A, content: "Duplicate of existing" }),
      mockMessage({ id: "batch-msg-003", conversationId: CONVERSATION_A, content: "New message 3" }),
    ];

    expect(() => {
      persistMessages(db, CONVERSATION_A, batchMessages);
    }).not.toThrow();

    expect(getMessageCount(db, CONVERSATION_A)).toBe(3);
  });

  it("should handle batch with internal duplicate IDs", () => {
    const duplicateId = "batch-dup-001";
    const batchMessages = [
      mockMessage({ id: duplicateId, conversationId: CONVERSATION_A, content: "First occurrence" }),
      mockMessage({ id: crypto.randomUUID(), conversationId: CONVERSATION_A, content: "Unique message" }),
      mockMessage({ id: duplicateId, conversationId: CONVERSATION_A, content: "Second occurrence of same ID" }),
    ];

    expect(() => {
      persistMessages(db, CONVERSATION_A, batchMessages);
    }).not.toThrow();

    expect(getMessageCount(db, CONVERSATION_A)).toBe(2);
  });
});

// persistMessage inserts message then message_parts without a per-call transaction.
// Duplicate inserts must not create orphaned or doubled parts.
describe("Scenario 5: message_parts consistency on duplicate insert", () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
    setupConversations(db);
  });

  afterEach(() => {
    cleanupTestDb(db);
  });

  it("should not create duplicate message_parts on repeated insert", () => {
    const messageId = "parts-msg-001";
    const msg = mockMessage({
      id: messageId,
      conversationId: CONVERSATION_A,
      content: "Message with parts that should not be duplicated",
    });

    persistMessage(db, CONVERSATION_A, msg);

    const partsBeforeCount = (
      db.query("SELECT COUNT(*) AS count FROM message_parts WHERE message_id = ?").get(messageId) as { count: number }
    ).count;

    expect(() => {
      persistMessage(db, CONVERSATION_A, msg);
    }).not.toThrow();

    const partsAfterCount = (
      db.query("SELECT COUNT(*) AS count FROM message_parts WHERE message_id = ?").get(messageId) as { count: number }
    ).count;

    expect(partsAfterCount).toBe(partsBeforeCount);
  });

  it("should not create orphaned message_parts on multipart message duplicate", () => {
    const messageId = "parts-multipart-001";
    const multipartContent = JSON.stringify([
      { type: "text", content: "First part" },
      { type: "tool_use", content: '{"name":"grep","input":"src"}' },
      { type: "tool_result", content: "Found 3 files" },
    ]);

    const msg = mockMessage({
      id: messageId,
      conversationId: CONVERSATION_A,
      content: multipartContent,
      tokenCount: 25,
    });

    persistMessage(db, CONVERSATION_A, msg);

    const partsBeforeCount = (
      db.query("SELECT COUNT(*) AS count FROM message_parts WHERE message_id = ?").get(messageId) as { count: number }
    ).count;
    expect(partsBeforeCount).toBe(3);

    expect(() => {
      persistMessage(db, CONVERSATION_A, msg);
    }).not.toThrow();

    const partsAfterCount = (
      db.query("SELECT COUNT(*) AS count FROM message_parts WHERE message_id = ?").get(messageId) as { count: number }
    ).count;
    expect(partsAfterCount).toBe(3);
  });
});

// persistMessage computes sequence_number as MAX(sequence_number) + 1.
// Ignored duplicates must not leave gaps in sequence numbering.
describe("Scenario 6: sequence number integrity after duplicate handling", () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
    setupConversations(db);
  });

  afterEach(() => {
    cleanupTestDb(db);
  });

  it("should maintain correct sequence numbering after ignored duplicate", () => {
    const msg1 = mockMessage({ id: "seq-msg-001", conversationId: CONVERSATION_A });
    const msg2 = mockMessage({ id: "seq-msg-002", conversationId: CONVERSATION_A });
    const msg3 = mockMessage({ id: "seq-msg-003", conversationId: CONVERSATION_A });

    persistMessage(db, CONVERSATION_A, msg1);
    persistMessage(db, CONVERSATION_A, msg2);

    expect(() => {
      persistMessage(db, CONVERSATION_A, msg1);
    }).not.toThrow();

    persistMessage(db, CONVERSATION_A, msg3);

    const messages = getMessages(db, CONVERSATION_A);
    expect(messages).toHaveLength(3);
    expect(messages[0].sequenceNumber).toBe(1);
    expect(messages[1].sequenceNumber).toBe(2);
    expect(messages[2].sequenceNumber).toBe(3);
  });
});

// Stress test simulating a busy OpenCode session with frequent tool calls.
describe("Scenario 7: rapid sequential persistence stress test", () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
    setupConversations(db);
  });

  afterEach(() => {
    cleanupTestDb(db);
  });

  it("should persist 100 unique messages without errors", () => {
    const messages = Array.from({ length: 100 }, (_, i) =>
      mockMessage({
        id: `stress-msg-${i.toString().padStart(4, "0")}`,
        conversationId: CONVERSATION_A,
        content: `Stress test message ${i} with enough content to be realistic in size ${"padding ".repeat(10)}`,
      }),
    );

    for (const msg of messages) {
      persistMessage(db, CONVERSATION_A, msg);
    }

    expect(getMessageCount(db, CONVERSATION_A)).toBe(100);

    const retrieved = getMessages(db, CONVERSATION_A);
    expect(retrieved).toHaveLength(100);

    for (let i = 0; i < 100; i++) {
      expect(retrieved[i].sequenceNumber).toBe(i + 1);
    }
  });

  it("should handle 100 messages with intermittent duplicates", () => {
    const uniqueIds = Array.from({ length: 100 }, (_, i) =>
      `stress-dup-${i.toString().padStart(4, "0")}`,
    );

    for (const id of uniqueIds) {
      persistMessage(
        db,
        CONVERSATION_A,
        mockMessage({ id, conversationId: CONVERSATION_A }),
      );
    }

    for (let i = 0; i < 100; i += 10) {
      expect(() => {
        persistMessage(
          db,
          CONVERSATION_A,
          mockMessage({ id: uniqueIds[i], conversationId: CONVERSATION_A }),
        );
      }).not.toThrow();
    }

    expect(getMessageCount(db, CONVERSATION_A)).toBe(100);
  });
});
