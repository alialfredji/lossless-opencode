import type { Database } from "bun:sqlite";
import type { Summary, SummaryNode } from "../types";

interface SummaryRow {
  id: string;
  conversation_id: string;
  depth: number;
  content: string;
  token_count: number;
  created_at: string;
  compaction_level: string;
}

function rowToSummary(row: SummaryRow, parentIds: string[], messageIds: string[]): Summary {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    depth: row.depth,
    content: row.content,
    tokenCount: row.token_count,
    createdAt: row.created_at,
    compactionLevel: row.compaction_level as Summary["compactionLevel"],
    parentIds,
    messageIds,
  };
}

function loadParentIds(db: Database, summaryId: string): string[] {
  return db
    .query<{ parent_id: string }, [string]>(
      "SELECT parent_id FROM summary_parents WHERE child_id = ?",
    )
    .all(summaryId)
    .map((r) => r.parent_id);
}

function loadMessageIds(db: Database, summaryId: string): string[] {
  return db
    .query<{ message_id: string }, [string]>(
      "SELECT message_id FROM summary_messages WHERE summary_id = ?",
    )
    .all(summaryId)
    .map((r) => r.message_id);
}

export function storeSummary(
  db: Database,
  conversationId: string,
  summary: Omit<Summary, "id" | "createdAt">,
): string {
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();

  db.query<void, [string, string, number, string, number, string, string]>(
    `INSERT INTO summaries (id, conversation_id, depth, content, token_count, created_at, compaction_level)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, conversationId, summary.depth, summary.content, summary.tokenCount, createdAt, summary.compactionLevel);

  return id;
}

export function linkSummaryToMessages(
  db: Database,
  summaryId: string,
  messageIds: string[],
): void {
  if (messageIds.length === 0) return;

  db.transaction(() => {
    const stmt = db.query<void, [string, string]>(
      "INSERT INTO summary_messages (summary_id, message_id) VALUES (?, ?)",
    );
    for (const messageId of messageIds) {
      stmt.run(summaryId, messageId);
    }
  })();
}

export function linkSummaryToParent(
  db: Database,
  childSummaryId: string,
  parentSummaryId: string,
): void {
  db.query<void, [string, string]>(
    "INSERT INTO summary_parents (child_id, parent_id) VALUES (?, ?)",
  ).run(childSummaryId, parentSummaryId);
}

export function getSummariesAtDepth(
  db: Database,
  conversationId: string,
  depth: number,
): Summary[] {
  const rows = db
    .query<SummaryRow, [string, number]>(
      `SELECT id, conversation_id, depth, content, token_count, created_at, compaction_level
       FROM summaries
       WHERE conversation_id = ? AND depth = ?
       ORDER BY created_at ASC`,
    )
    .all(conversationId, depth);

  return rows.map((row) =>
    rowToSummary(row, loadParentIds(db, row.id), loadMessageIds(db, row.id)),
  );
}

export function getLeafSummaries(db: Database, conversationId: string): Summary[] {
  const rows = db
    .query<SummaryRow, [string]>(
      `SELECT s.id, s.conversation_id, s.depth, s.content, s.token_count, s.created_at, s.compaction_level
       FROM summaries s
       WHERE s.conversation_id = ?
         AND s.depth = 0
         AND s.id NOT IN (SELECT child_id FROM summary_parents)
       ORDER BY s.created_at ASC`,
    )
    .all(conversationId);

  return rows.map((row) =>
    rowToSummary(row, loadParentIds(db, row.id), loadMessageIds(db, row.id)),
  );
}

export function getRootSummaries(db: Database, conversationId: string): Summary[] {
  const rows = db
    .query<SummaryRow, [string]>(
      `SELECT s.id, s.conversation_id, s.depth, s.content, s.token_count, s.created_at, s.compaction_level
       FROM summaries s
       WHERE s.conversation_id = ?
         AND s.id NOT IN (SELECT child_id FROM summary_parents)
       ORDER BY s.created_at ASC`,
    )
    .all(conversationId);

  return rows.map((row) =>
    rowToSummary(row, loadParentIds(db, row.id), loadMessageIds(db, row.id)),
  );
}

export function getSummaryTree(db: Database, conversationId: string): SummaryNode[] {
  const rows = db
    .query<SummaryRow, [string]>(
      `SELECT id, conversation_id, depth, content, token_count, created_at, compaction_level
       FROM summaries
       WHERE conversation_id = ?
       ORDER BY created_at ASC`,
    )
    .all(conversationId);

  if (rows.length === 0) return [];

  const summaryMap = new Map<string, Summary>();
  for (const row of rows) {
    const summary = rowToSummary(row, loadParentIds(db, row.id), loadMessageIds(db, row.id));
    summaryMap.set(summary.id, summary);
  }

  const parentRelations = db
    .query<{ child_id: string; parent_id: string }, [string]>(
      `SELECT sp.child_id, sp.parent_id
       FROM summary_parents sp
       WHERE sp.child_id IN (
         SELECT id FROM summaries WHERE conversation_id = ?
       )`,
    )
    .all(conversationId);

  const childrenMap = new Map<string, string[]>();
  const childIds = new Set<string>();

  for (const rel of parentRelations) {
    childIds.add(rel.child_id);
    if (!childrenMap.has(rel.parent_id)) {
      childrenMap.set(rel.parent_id, []);
    }
    childrenMap.get(rel.parent_id)!.push(rel.child_id);
  }

  function buildNode(summaryId: string): SummaryNode {
    const summary = summaryMap.get(summaryId)!;
    const childIdList = childrenMap.get(summaryId) ?? [];
    const children = childIdList.map(buildNode);
    return { summary, children, depth: summary.depth };
  }

  const rootIds = rows.map((r) => r.id).filter((id) => !childIds.has(id));
  return rootIds.map(buildNode);
}

export function getMessagesForSummary(db: Database, summaryId: string): string[] {
  return db
    .query<{ message_id: string }, [string]>(
      "SELECT message_id FROM summary_messages WHERE summary_id = ? ORDER BY rowid ASC",
    )
    .all(summaryId)
    .map((r) => r.message_id);
}
