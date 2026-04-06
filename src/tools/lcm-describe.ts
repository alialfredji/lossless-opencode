import type { Database } from "bun:sqlite";
import { tool } from "@opencode-ai/plugin";
import { getMessageCount, getUnsummarizedMessages } from "../messages/persistence";
import { determineCompactionLevel } from "../compaction/engine";
import type { HookSessionState, } from "../index";
import type { LcmConfig } from "../types";

interface DepthCountRow {
  depth: number;
  count: number;
}

interface TokenSumRow {
  total: number;
}

interface MaxDepthRow {
  max_depth: number | null;
}

interface IndexCountRow {
  count: number;
}

function getSummaryDepthCounts(
  db: Database,
  sessionId: string,
): DepthCountRow[] {
  return db
    .query<DepthCountRow, [string]>(
      `SELECT depth, COUNT(*) as count FROM summaries WHERE conversation_id = ? GROUP BY depth ORDER BY depth`,
    )
    .all(sessionId);
}

function getSummaryTokenTotal(db: Database, sessionId: string): number {
  const row = db
    .query<TokenSumRow, [string]>(
      `SELECT COALESCE(SUM(token_count), 0) as total FROM summaries WHERE conversation_id = ?`,
    )
    .get(sessionId);
  return row?.total ?? 0;
}

function getMaxSummaryDepth(db: Database, sessionId: string): number {
  const row = db
    .query<MaxDepthRow, [string]>(
      `SELECT MAX(depth) as max_depth FROM summaries WHERE conversation_id = ?`,
    )
    .get(sessionId);
  return row?.max_depth ?? 0;
}

function getSummaryCount(db: Database, sessionId: string): number {
  const row = db
    .query<IndexCountRow, [string]>(
      `SELECT COUNT(*) as count FROM summaries WHERE conversation_id = ?`,
    )
    .get(sessionId);
  return row?.count ?? 0;
}

function getMessageIndexCount(db: Database, sessionId: string): number {
  const row = db
    .query<IndexCountRow, [string]>(
      `SELECT COUNT(*) as count FROM messages WHERE conversation_id = ?`,
    )
    .get(sessionId);
  return row?.count ?? 0;
}

export function lcmDescribe(
  db: Database,
  sessionId: string,
  config: LcmConfig,
): string {
  const totalMessages = getMessageCount(db, sessionId);
  const unsummarizedMessages = getUnsummarizedMessages(db, sessionId);
  const unsummarizedCount = unsummarizedMessages.length;

  const depthCounts = getSummaryDepthCounts(db, sessionId);
  const totalSummaries = depthCounts.reduce((sum, row) => sum + row.count, 0);

  const summaryTokens = getSummaryTokenTotal(db, sessionId);
  const freshTailTokens = unsummarizedMessages.reduce(
    (sum, msg) => sum + msg.tokenCount,
    0,
  );

  const messagesIndexed = getMessageIndexCount(db, sessionId);
  const summariesIndexed = getSummaryCount(db, sessionId);

  const compactionLevel = determineCompactionLevel(db, sessionId, config);
  const currentMaxDepth = getMaxSummaryDepth(db, sessionId);

  const lines: string[] = [];
  lines.push("=== LCM Session State ===");
  lines.push(`Session: ${sessionId}`);
  lines.push(`Total Messages: ${totalMessages}`);
  lines.push(`Unsummarized (fresh tail): ${unsummarizedCount}`);
  lines.push("");
  lines.push("Summary DAG:");

  if (totalSummaries === 0) {
    lines.push("  Total summaries: 0");
  } else {
    for (const row of depthCounts) {
      if (row.count > 0) {
        const label = row.depth === 0 ? "Depth 0 (leaf)" : `Depth ${row.depth}`;
        lines.push(`  ${label}: ${row.count} summaries`);
      }
    }
    lines.push(`  Total summaries: ${totalSummaries}`);
  }

  lines.push("");
  lines.push("Context Budget:");
  lines.push(`  Max tokens: ${config.maxContextTokens}`);
  lines.push(`  Summaries: ${summaryTokens} tokens`);
  lines.push(`  Fresh tail: ${freshTailTokens} tokens`);
  lines.push("");
  lines.push("FTS Index:");
  lines.push(`  Messages indexed: ${messagesIndexed}`);
  lines.push(`  Summaries indexed: ${summariesIndexed}`);
  lines.push("");
  lines.push(
    `Compaction Level: ${compactionLevel} (depth ${currentMaxDepth} of max ${config.maxSummaryDepth})`,
  );

  return lines.join("\n");
}

export function createDescribeToolDefinition(state: HookSessionState) {
  return tool({
    description:
      "Show the current state of the LCM system: message count, summary DAG structure, token budget, and compaction status.",
    args: {},
    async execute() {
      if (!state.db || !state.sessionId) {
        return "LCM not initialized yet";
      }
      return lcmDescribe(state.db, state.sessionId, state.config);
    },
  });
}
