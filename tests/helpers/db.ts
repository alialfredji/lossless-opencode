import type { Database } from "bun:sqlite";
import { createDatabase } from "../../src/db/database";
import { runMigrations } from "../../src/db/migrations";
import type { LcmMessage, Summary } from "../../src/types";

export function createTestDb(): Database {
  const db = createDatabase(":memory:");
  runMigrations(db);
  return db;
}

export function seedTestMessages(
  db: Database,
  conversationId: string,
  count: number,
): LcmMessage[] {
  const sessionId = `session-${conversationId}`;

  db.query("INSERT OR IGNORE INTO conversations (id, session_id) VALUES (?, ?)").run(
    conversationId,
    sessionId,
  );

  const messages: LcmMessage[] = [];
  const baseTime = Date.parse("2024-01-01T10:00:00Z");

  for (let i = 0; i < count; i++) {
    const role = i % 2 === 0 ? "user" : "assistant";
    const sequenceNumber = i + 1;
    const timestamp = new Date(baseTime + i * 60_000).toISOString();
    const content =
      role === "user"
        ? `Test message ${sequenceNumber}: I am debugging a TypeScript workflow and need help understanding why the message pipeline loses state between compaction steps.`
        : `Test message ${sequenceNumber}: The issue usually comes from inserting summaries before persisting the latest message batch. Check the transaction boundaries and verify sequence ordering.`;

    const message: LcmMessage = {
      id: `msg-${sequenceNumber.toString().padStart(3, "0")}`,
      role,
      content,
      timestamp,
      sessionId,
      tokenCount: Math.max(8, Math.ceil(content.length / 4)),
      summarized: false,
      sequenceNumber,
      conversationId,
    };

    db.query(
      `INSERT INTO messages (id, conversation_id, role, content, token_count, sequence_number, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      message.id,
      message.conversationId,
      message.role,
      message.content,
      message.tokenCount,
      message.sequenceNumber,
      message.timestamp,
    );

    messages.push(message);
  }

  return messages;
}

export function seedTestSummaries(
  db: Database,
  conversationId: string,
  messageIds: string[],
): Summary[] {
  const summary: Summary = {
    id: `summary-${conversationId}`,
    depth: 0,
    content:
      "This summary captures a compact debugging conversation about TypeScript types, database writes, and message ordering across a compaction boundary.",
    tokenCount: 24,
    createdAt: new Date().toISOString(),
    parentIds: [],
    messageIds,
    compactionLevel: "normal",
    conversationId,
  };

  db.query(
    `INSERT INTO summaries (id, conversation_id, depth, content, token_count, created_at, compaction_level)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    summary.id,
    summary.conversationId,
    summary.depth,
    summary.content,
    summary.tokenCount,
    summary.createdAt,
    summary.compactionLevel,
  );

  for (const messageId of messageIds) {
    db.query("INSERT INTO summary_messages (summary_id, message_id) VALUES (?, ?)").run(
      summary.id,
      messageId,
    );
  }

  return [summary];
}

export function cleanupTestDb(db: Database): void {
  db.close();
}
