import type { Database } from "bun:sqlite";
import type { LargeFile, LcmMessage } from "../types";
import { countTokens } from "../utils/tokens";

export interface LargeContentPart {
  index: number;
  tokens: number;
  path?: string;
}

export interface DetectionResult {
  isLarge: boolean;
  parts: LargeContentPart[];
}

function detectPath(content: string): string | undefined {
  // XML tag: <file path="...">
  const xmlMatch = content.match(/<file\s+path="([^"]+)"/);
  if (xmlMatch) return xmlMatch[1];

  // Code block with filename comment: ```typescript\n// src/foo/bar.ts  or ```\n// path: src/foo.ts
  const codeBlockMatch = content.match(/```[^\n]*\n\/\/\s*(?:path:\s*)?([^\s]+\.[a-zA-Z0-9]+)/);
  if (codeBlockMatch) return codeBlockMatch[1];

  // File path mention at start — first line looks like a path (no spaces, has / or \, ends with extension)
  const firstLine = content.split("\n")[0].trim();
  if (
    firstLine.length > 0 &&
    !firstLine.includes(" ") &&
    (firstLine.includes("/") || firstLine.includes("\\")) &&
    /\.[a-zA-Z0-9]{1,10}$/.test(firstLine)
  ) {
    return firstLine;
  }

  return undefined;
}

export function detectLargeContent(message: LcmMessage, threshold: number): DetectionResult {
  const tokens = countTokens(message.content);

  if (tokens > threshold) {
    const path = detectPath(message.content);
    return {
      isLarge: true,
      parts: [{ index: 0, tokens, path }],
    };
  }

  return { isLarge: false, parts: [] };
}

interface LargeFileRow {
  id: string;
  placeholder: string;
  original_path: string | null;
  token_count: number;
  structural_summary: string | null;
  content: string;
  created_at: string;
  conversation_id: string;
  message_id: string | null;
}

interface MessageExistsRow {
  found: number;
}

function rowToLargeFile(row: LargeFileRow): LargeFile {
  return {
    id: row.id,
    placeholder: row.placeholder,
    originalPath: row.original_path,
    tokenCount: row.token_count,
    structuralSummary: row.structural_summary,
    content: row.content,
    storedAt: row.created_at,
    conversationId: row.conversation_id,
    messageId: row.message_id,
  };
}

export function extractAndStore(
  db: Database,
  conversationId: string,
  message: LcmMessage,
  threshold: number,
): LcmMessage {
  const detection = detectLargeContent(message, threshold);

  if (!detection.isLarge) {
    return message;
  }

  const part = detection.parts[0];
  const fileId = crypto.randomUUID();
  const placeholder = `[LCM:${fileId}]`;
  const label = part.path ?? "content";
  const replacement = `[Large file: ${label} (${part.tokens} tokens) — use lcm_expand_query to retrieve]`;
  const messageExists =
    (
      db
        .query<MessageExistsRow, [string]>(
          "SELECT 1 AS found FROM messages WHERE id = ? LIMIT 1",
        )
        .get(message.id)?.found ?? 0
    ) === 1;

  db.query<void, [string, string, string | null, string, string | null, number, string]>(
    `INSERT INTO large_files (id, conversation_id, message_id, placeholder, original_path, token_count, content, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  ).run(
    fileId,
    conversationId,
    messageExists ? message.id : null,
    placeholder,
    part.path ?? null,
    part.tokens,
    message.content,
  );

  const newCount = countTokens(replacement);

  return {
    ...message,
    content: replacement,
    tokenCount: newCount,
  };
}

export function retrieveLargeFile(db: Database, fileId: string): LargeFile | null {
  const row = db
    .query<LargeFileRow, [string]>("SELECT * FROM large_files WHERE id = ?")
    .get(fileId);

  return row ? rowToLargeFile(row) : null;
}

export function retrieveLargeFileByPath(
  db: Database,
  conversationId: string,
  path: string,
): LargeFile | null {
  const row = db
    .query<LargeFileRow, [string, string]>(
      `SELECT * FROM large_files WHERE conversation_id = ? AND original_path = ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(conversationId, path);

  return row ? rowToLargeFile(row) : null;
}

export function getLargeFileStats(
  db: Database,
  conversationId: string,
): { count: number; totalTokensSaved: number } {
  const row = db
    .query<{ count: number; total: number | null }, [string]>(
      `SELECT COUNT(*) as count, SUM(token_count) as total
       FROM large_files WHERE conversation_id = ?`,
    )
    .get(conversationId);

  return {
    count: row?.count ?? 0,
    totalTokensSaved: row?.total ?? 0,
  };
}
