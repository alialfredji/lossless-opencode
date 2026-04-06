import type { Database } from "bun:sqlite";
import { tool } from "@opencode-ai/plugin";
import type { HookSessionState, SessionState } from "../types";

export interface SessionInfo {
  sessionId: string;
  messageCount: number;
  summaryCount: number;
  dagDepth: number;
  totalTokens: number;
  lastActivityAt: string | null;
}

export interface ResetResult {
  messagesDeleted: number;
  summariesDeleted: number;
  largeFilesDeleted: number;
}

interface CountRow {
  count: number;
}

interface DepthRow {
  max_depth: number | null;
}

interface TotalRow {
  total: number | null;
}

interface LastRow {
  last: string | null;
}

export function initSession(db: Database, sessionId: string): SessionState {
  db.prepare("INSERT OR IGNORE INTO conversations (id, session_id) VALUES (?, ?)").run(
    sessionId,
    sessionId,
  );

  return {
    sessionId,
    conversationId: sessionId,
    messageCount: 0,
    lastCompactionAt: null,
    totalTokens: 0,
  };
}

export function getSessionInfo(db: Database, sessionId: string): SessionInfo {
  const messageRow = db
    .query<CountRow, [string]>("SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?")
    .get(sessionId);
  const summaryRow = db
    .query<CountRow, [string]>("SELECT COUNT(*) AS count FROM summaries WHERE conversation_id = ?")
    .get(sessionId);
  const depthRow = db
    .query<DepthRow, [string]>("SELECT MAX(depth) AS max_depth FROM summaries WHERE conversation_id = ?")
    .get(sessionId);
  const totalRow = db
    .query<TotalRow, [string]>("SELECT SUM(token_count) AS total FROM messages WHERE conversation_id = ?")
    .get(sessionId);
  const lastRow = db
    .query<LastRow, [string]>("SELECT MAX(created_at) AS last FROM messages WHERE conversation_id = ?")
    .get(sessionId);

  return {
    sessionId,
    messageCount: messageRow?.count ?? 0,
    summaryCount: summaryRow?.count ?? 0,
    dagDepth: depthRow?.max_depth ?? 0,
    totalTokens: totalRow?.total ?? 0,
    lastActivityAt: lastRow?.last ?? null,
  };
}

export function resetSession(db: Database, sessionId: string): ResetResult {
  let messagesDeleted = 0;
  let summariesDeleted = 0;
  let largeFilesDeleted = 0;

  db.transaction(() => {
    messagesDeleted =
      db.query<CountRow, [string]>("SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?").get(sessionId)
        ?.count ?? 0;
    summariesDeleted =
      db.query<CountRow, [string]>("SELECT COUNT(*) AS count FROM summaries WHERE conversation_id = ?").get(sessionId)
        ?.count ?? 0;
    largeFilesDeleted =
      db.query<CountRow, [string]>("SELECT COUNT(*) AS count FROM large_files WHERE conversation_id = ?").get(sessionId)
        ?.count ?? 0;

    db.query(
      "DELETE FROM summary_messages WHERE summary_id IN (SELECT id FROM summaries WHERE conversation_id = ?)",
    ).run(sessionId);
    db.query(
      "DELETE FROM summary_parents WHERE child_id IN (SELECT id FROM summaries WHERE conversation_id = ?) OR parent_id IN (SELECT id FROM summaries WHERE conversation_id = ?)",
    ).run(sessionId, sessionId);
    db.query("DELETE FROM summaries WHERE conversation_id = ?").run(sessionId);
    db.query("DELETE FROM large_files WHERE conversation_id = ?").run(sessionId);
    db.query("DELETE FROM messages WHERE conversation_id = ?").run(sessionId);
    db.query("DELETE FROM context_items WHERE conversation_id = ?").run(sessionId);
    db.query("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')").run();
    db.query("INSERT INTO summaries_fts(summaries_fts) VALUES('rebuild')").run();
  })();

  return { messagesDeleted, summariesDeleted, largeFilesDeleted };
}

export function createNewSessionCommand(state: HookSessionState) {
  return tool({
    description:
      "Start a new LCM session, clearing the current session state. All future messages will be tracked under the new session.",
    args: {},
    async execute() {
      const newSessionId = crypto.randomUUID();
      state.sessionId = newSessionId;

      if (state.db) {
        initSession(state.db, newSessionId);
      }

      return `New LCM session started: ${newSessionId}`;
    },
  });
}

export function createResetCommand(state: HookSessionState) {
  return tool({
    description:
      "Reset the current LCM session, deleting all messages, summaries, and stored context for this session.",
    args: {},
    async execute() {
      if (!state.db || !state.sessionId) {
        return "LCM not initialized";
      }

      const result = resetSession(state.db, state.sessionId);
      return `LCM session reset. Deleted: ${result.messagesDeleted} messages, ${result.summariesDeleted} summaries, ${result.largeFilesDeleted} large files.`;
    },
  });
}
