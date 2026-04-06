import type { Database } from "bun:sqlite";

const DEFAULT_LIMIT = 20;

/**
 * Inserts a message's text into the messages_fts FTS5 table.
 * Uses rowid lookup because the primary key is a UUID TEXT, not an integer.
 * Note: triggers auto-index on INSERT, but this is needed for rebuildIndex.
 */
export function indexMessage(
  db: Database,
  messageId: string,
  content: string,
  _sessionId: string,
): void {
  db.prepare(
    `INSERT INTO messages_fts(rowid, content)
     VALUES((SELECT rowid FROM messages WHERE id=?), ?)`,
  ).run(messageId, content);
}

/**
 * Inserts a summary's text into the summaries_fts FTS5 table.
 * Uses rowid lookup because the primary key is a UUID TEXT.
 */
export function indexSummary(
  db: Database,
  summaryId: string,
  text: string,
): void {
  db.prepare(
    `INSERT INTO summaries_fts(rowid, content)
     VALUES((SELECT rowid FROM summaries WHERE id=?), ?)`,
  ).run(summaryId, text);
}

export interface MessageSearchResult {
  messageId: string;
  rank: number;
  snippet: string;
}

/**
 * BM25 full-text search over messages within a specific session (conversation_id).
 * Results are sorted by rank ascending — BM25 returns negative values, so most
 * relevant (most negative) appears first with ORDER BY rank.
 */
export function searchMessages(
  db: Database,
  sessionId: string,
  query: string,
  opts?: { limit?: number },
): MessageSearchResult[] {
  const limit = opts?.limit ?? DEFAULT_LIMIT;

  const rows = db
    .prepare<
      { id: string; rank: number; snippet: string },
      [string, string, number]
    >(
      `SELECT m.id, bm25(messages_fts) as rank,
              snippet(messages_fts, 0, '<b>', '</b>', '...', 10) as snippet
       FROM messages_fts
       JOIN messages m ON messages_fts.rowid = m.rowid
       JOIN conversations c ON m.conversation_id = c.id
       WHERE messages_fts MATCH ?
         AND c.id = ?
       ORDER BY rank
       LIMIT ?`,
    )
    .all(query, sessionId, limit);

  return rows.map((r) => ({
    messageId: r.id,
    rank: r.rank,
    snippet: r.snippet,
  }));
}

export interface SummarySearchResult {
  summaryId: string;
  depth: number;
  rank: number;
  snippet: string;
}

/**
 * BM25 full-text search over summaries within a specific session (conversation_id).
 * Results are sorted by rank ascending (most relevant first).
 */
export function searchSummaries(
  db: Database,
  sessionId: string,
  query: string,
  opts?: { limit?: number },
): SummarySearchResult[] {
  const limit = opts?.limit ?? DEFAULT_LIMIT;

  const rows = db
    .prepare<
      { id: string; depth: number; rank: number; snippet: string },
      [string, string, number]
    >(
      `SELECT s.id, s.depth, bm25(summaries_fts) as rank,
              snippet(summaries_fts, 0, '<b>', '</b>', '...', 10) as snippet
       FROM summaries_fts
       JOIN summaries s ON summaries_fts.rowid = s.rowid
       JOIN conversations c ON s.conversation_id = c.id
       WHERE summaries_fts MATCH ?
         AND c.id = ?
       ORDER BY rank
       LIMIT ?`,
    )
    .all(query, sessionId, limit);

  return rows.map((r) => ({
    summaryId: r.id,
    depth: r.depth,
    rank: r.rank,
    snippet: r.snippet,
  }));
}

export interface UnifiedSearchResult {
  type: "message" | "summary";
  id: string;
  rank: number;
  snippet: string;
  depth?: number;
}

/**
 * Merges results from searchMessages and searchSummaries, re-sorts by rank,
 * and returns the top N most relevant results across both corpora.
 */
export function searchAll(
  db: Database,
  sessionId: string,
  query: string,
  opts?: { limit?: number },
): UnifiedSearchResult[] {
  const limit = opts?.limit ?? DEFAULT_LIMIT;

  const msgResults = searchMessages(db, sessionId, query, { limit });
  const sumResults = searchSummaries(db, sessionId, query, { limit });

  const combined: UnifiedSearchResult[] = [
    ...msgResults.map((r) => ({
      type: "message" as const,
      id: r.messageId,
      rank: r.rank,
      snippet: r.snippet,
    })),
    ...sumResults.map((r) => ({
      type: "summary" as const,
      id: r.summaryId,
      rank: r.rank,
      snippet: r.snippet,
      depth: r.depth,
    })),
  ];

  // BM25 rank: more negative = more relevant. Sort ascending = most relevant first.
  combined.sort((a, b) => a.rank - b.rank);

  return combined.slice(0, limit);
}

/**
 * Full reindex for a session. Uses the FTS5 'rebuild' command which reads the
 * content tables (messages, summaries) to reconstruct the index from scratch.
 * The sessionId parameter is accepted for API consistency — the FTS5 rebuild
 * command always processes the full index, which includes the session's data.
 */
export function rebuildIndex(db: Database, _sessionId: string): void {
  db.transaction(() => {
    db.prepare(`INSERT INTO messages_fts(messages_fts) VALUES('rebuild')`).run();
    db.prepare(`INSERT INTO summaries_fts(summaries_fts) VALUES('rebuild')`).run();
  })();
}
