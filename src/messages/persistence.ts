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

interface MessagePartRow {
  message_id: string;
  part_type: string;
  content: string;
  sequence_number: number;
}

interface MessagePart {
  type: string;
  content: string;
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

function parseMessageParts(content: string): MessagePart[] | null {
  try {
    const parsed = JSON.parse(content);

    if (!Array.isArray(parsed)) {
      return null;
    }

    const parts = parsed.flatMap((part): MessagePart[] => {
      if (!part || typeof part !== "object") {
        return [];
      }

      const typedPart = part as { type?: unknown; content?: unknown; text?: unknown };
      const type = typeof typedPart.type === "string" ? typedPart.type : null;
      const value =
        typeof typedPart.content === "string"
          ? typedPart.content
          : typeof typedPart.text === "string"
            ? typedPart.text
            : null;

      if (!type || value === null) {
        return [];
      }

      return [{ type, content: value }];
    });

    return parts.length > 0 ? parts : null;
  } catch {
    return null;
  }
}

function decomposeMessageParts(content: string): MessagePart[] {
  return parseMessageParts(content) ?? [{ type: "text", content }];
}

function buildConcatenatedContent(parts: MessagePart[]): string {
  return parts
    .map((part) => part.content.trim())
    .filter((partContent) => partContent.length > 0)
    .join("\n\n");
}

function reconstructMessageContent(messageContent: string, parts: MessagePartRow[]): string {
  if (parts.length === 0) {
    return messageContent;
  }

  return buildConcatenatedContent(
    parts.map((part) => ({
      type: part.part_type,
      content: part.content,
    })),
  );
}

export function persistMessage(
  db: Database,
  conversationId: string,
  message: LcmMessage,
): boolean {
  const seqRow = db
    .prepare<SequenceRow, [string]>(
      "SELECT MAX(sequence_number) AS max_seq FROM messages WHERE conversation_id = ?",
    )
    .get(conversationId);

  const sequenceNumber = (seqRow?.max_seq ?? 0) + 1;
  const parts = decomposeMessageParts(message.content);
  const concatenatedContent = buildConcatenatedContent(parts);

  const result = db.prepare(
    `INSERT OR IGNORE INTO messages (id, conversation_id, role, content, token_count, sequence_number, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    message.id,
    conversationId,
    message.role,
    concatenatedContent,
    message.tokenCount,
    sequenceNumber,
    message.timestamp,
  );

  if (result.changes === 0) {
    return false;
  }

  const insertPart = db.prepare(
    `INSERT INTO message_parts (id, message_id, part_type, content, sequence_number)
     VALUES (?, ?, ?, ?, ?)`,
  );

  for (const [index, part] of parts.entries()) {
    insertPart.run(crypto.randomUUID(), message.id, part.type, part.content, index + 1);
  }

  return true;
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

  let messageSelectionSql =
    `SELECT m.id, m.conversation_id, m.role, m.content, m.token_count, m.sequence_number, m.created_at` +
    ` FROM messages m` +
    ` WHERE m.conversation_id = ?`;

  const params: (string | number)[] = [conversationId];

  if (after !== undefined) {
    messageSelectionSql += ` AND m.sequence_number > ?`;
    params.push(after);
  }

  messageSelectionSql += ` ORDER BY m.sequence_number ASC`;

  if (limit !== undefined) {
    messageSelectionSql += ` LIMIT ?`;
    params.push(limit);
  }

  const sql =
    `SELECT m.id, m.conversation_id, m.role, m.content, m.token_count, m.sequence_number, m.created_at,` +
    ` mp.message_id, mp.part_type, mp.content AS part_content, mp.sequence_number AS part_sequence_number` +
    ` FROM (${messageSelectionSql}) m` +
    ` LEFT JOIN message_parts mp ON mp.message_id = m.id` +
    ` ORDER BY m.sequence_number ASC, mp.sequence_number ASC`;

  const rows = db
    .prepare<
      MessageRow & {
        message_id: string | null;
        part_type: string | null;
        part_content: string | null;
        part_sequence_number: number | null;
      },
      (string | number)[]
    >(sql)
    .all(...params);

  const messages = new Map<string, LcmMessage & { parts: MessagePartRow[] }>();

  for (const row of rows) {
    const existing = messages.get(row.id);

    if (!existing) {
      messages.set(row.id, {
        id: row.id,
        role: row.role as LcmMessage["role"],
        content: row.content,
        timestamp: row.created_at,
        sessionId,
        tokenCount: row.token_count,
        summarized: false,
        sequenceNumber: row.sequence_number,
        conversationId: row.conversation_id,
        parts: [],
      });
    }

    if (row.message_id && row.part_type && row.part_content !== null && row.part_sequence_number) {
      messages.get(row.id)?.parts.push({
        message_id: row.message_id,
        part_type: row.part_type,
        content: row.part_content,
        sequence_number: row.part_sequence_number,
      });
    }
  }

  return Array.from(messages.values()).map(({ parts, ...message }) => ({
    ...message,
    content: reconstructMessageContent(message.content, parts),
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
