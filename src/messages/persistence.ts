import type { Database } from "bun:sqlite";
import type { LcmMessage } from "../types";

export interface GetMessagesOptions {
  after?: number;
  limit?: number;
  includeHidden?: boolean;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  token_count: number;
  sequence_number: number;
  created_at: string;
}

interface ConversationRow {
  session_id: string;
}

interface CountRow {
  count: number;
}

interface SequenceRow {
  max_seq: number | null;
}

export function persistMessage(
  db: Database,
  conversationId: string,
  message: LcmMessage,
): void {
  const seqRow = db
    .prepare<SequenceRow, [string]>(
      "SELECT MAX(sequence_number) AS max_seq FROM messages WHERE conversation_id = ?",
    )
    .get(conversationId);

  const sequenceNumber = (seqRow?.max_seq ?? 0) + 1;

  db.prepare(
    `INSERT INTO messages (id, conversation_id, role, content, token_count, sequence_number, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    message.id,
    conversationId,
    message.role,
    message.content,
    message.tokenCount,
    sequenceNumber,
    message.timestamp,
  );

  db.prepare(
    `INSERT INTO message_parts (id, message_id, part_type, content, sequence_number)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(crypto.randomUUID(), message.id, "text", message.content, 1);
}

export function persistMessages(
  db: Database,
  conversationId: string,
  messages: LcmMessage[],
): void {
  db.transaction(() => {
    for (const message of messages) {
      persistMessage(db, conversationId, message);
    }
  })();
}

export function getMessages(
  db: Database,
  conversationId: string,
  opts: GetMessagesOptions = {},
): LcmMessage[] {
  const { after, limit } = opts;

  const conversationRow = db
    .prepare<ConversationRow, [string]>(
      "SELECT session_id FROM conversations WHERE id = ?",
    )
    .get(conversationId);

  const sessionId = conversationRow?.session_id ?? "";

  let sql =
    `SELECT m.id, m.conversation_id, m.role, m.content, m.token_count, m.sequence_number, m.created_at` +
    ` FROM messages m` +
    ` WHERE m.conversation_id = ?`;

  const params: (string | number)[] = [conversationId];

  if (after !== undefined) {
    sql += ` AND m.sequence_number > ?`;
    params.push(after);
  }

  sql += ` ORDER BY m.sequence_number ASC`;

  if (limit !== undefined) {
    sql += ` LIMIT ?`;
    params.push(limit);
  }

  const rows = db.prepare<MessageRow, (string | number)[]>(sql).all(...params);

  return rows.map((row) => ({
    id: row.id,
    role: row.role as LcmMessage["role"],
    content: row.content,
    timestamp: row.created_at,
    sessionId,
    tokenCount: row.token_count,
    summarized: false,
    sequenceNumber: row.sequence_number,
    conversationId: row.conversation_id,
  }));
}

export function getMessageCount(db: Database, conversationId: string): number {
  const row = db
    .prepare<CountRow, [string]>(
      "SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?",
    )
    .get(conversationId);

  return row?.count ?? 0;
}

export function markMessagesSummarized(
  db: Database,
  messageIds: string[],
  summaryId: string,
): void {
  const stmt = db.prepare(
    "INSERT OR IGNORE INTO summary_messages (summary_id, message_id) VALUES (?, ?)",
  );

  db.transaction(() => {
    for (const messageId of messageIds) {
      stmt.run(summaryId, messageId);
    }
  })();
}

export function getUnsummarizedMessages(
  db: Database,
  conversationId: string,
): LcmMessage[] {
  const conversationRow = db
    .prepare<ConversationRow, [string]>(
      "SELECT session_id FROM conversations WHERE id = ?",
    )
    .get(conversationId);

  const sessionId = conversationRow?.session_id ?? "";

  const sql =
    `SELECT m.id, m.conversation_id, m.role, m.content, m.token_count, m.sequence_number, m.created_at` +
    ` FROM messages m` +
    ` WHERE m.conversation_id = ?` +
    ` AND m.id NOT IN (SELECT message_id FROM summary_messages)` +
    ` ORDER BY m.sequence_number ASC`;

  const rows = db.prepare<MessageRow, [string]>(sql).all(conversationId);

  return rows.map((row) => ({
    id: row.id,
    role: row.role as LcmMessage["role"],
    content: row.content,
    timestamp: row.created_at,
    sessionId,
    tokenCount: row.token_count,
    summarized: false,
    sequenceNumber: row.sequence_number,
    conversationId: row.conversation_id,
  }));
}
