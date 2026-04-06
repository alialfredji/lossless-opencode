import type { Database } from "bun:sqlite";
import { tool } from "@opencode-ai/plugin";
import { z } from "zod";
import { searchAll } from "../search/indexer";
import type { HookSessionState } from "../types";

const DEFAULT_LIMIT = 10;

interface MessageMeta {
  role: string;
  sequenceNumber: number;
  createdAt: string;
}

interface SummaryMeta {
  depth: number;
  createdAt: string;
  minSequence: number | null;
  maxSequence: number | null;
}

interface CountRow {
  count: number;
}

function getMessageMeta(db: Database, messageId: string): MessageMeta | null {
  const row = db
    .prepare<{ role: string; sequence_number: number; created_at: string }, [string]>(
      `SELECT role, sequence_number, created_at FROM messages WHERE id = ?`,
    )
    .get(messageId);

  if (!row) return null;
  return {
    role: row.role,
    sequenceNumber: row.sequence_number,
    createdAt: row.created_at,
  };
}

function getSummaryMeta(db: Database, summaryId: string): SummaryMeta | null {
  const row = db
    .prepare<
      {
        depth: number;
        created_at: string;
        min_sequence: number | null;
        max_sequence: number | null;
      },
      [string, string]
    >(
      `WITH RECURSIVE descendants(id) AS (
         SELECT ?
         UNION ALL
         SELECT sp.child_id
         FROM summary_parents sp
         JOIN descendants d ON sp.parent_id = d.id
       )
       SELECT s.depth,
              s.created_at,
              MIN(m.sequence_number) AS min_sequence,
              MAX(m.sequence_number) AS max_sequence
       FROM summaries s
       LEFT JOIN descendants d ON d.id IS NOT NULL
       LEFT JOIN summary_messages sm ON sm.summary_id = d.id
       LEFT JOIN messages m ON m.id = sm.message_id
       WHERE s.id = ?
       GROUP BY s.id, s.depth, s.created_at`,
    )
    .get(summaryId, summaryId);

  if (!row) return null;
  return {
    depth: row.depth,
    createdAt: row.created_at,
    minSequence: row.min_sequence,
    maxSequence: row.max_sequence,
  };
}

function getSearchLimit(db: Database, sessionId: string, type: "messages" | "summaries" | "all", limit: number): number {
  if (type === "all") {
    return limit;
  }

  const messagesCount =
    db.query<CountRow, [string]>("SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?").get(sessionId)
      ?.count ?? 0;
  const summariesCount =
    db.query<CountRow, [string]>("SELECT COUNT(*) AS count FROM summaries WHERE conversation_id = ?").get(sessionId)
      ?.count ?? 0;

  return Math.max(limit, messagesCount + summariesCount);
}

function formatTimestamp(isoString: string): string {
  const d = new Date(isoString);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hours = String(d.getHours()).padStart(2, "0");
  const minutes = String(d.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

/**
 * Core BM25 full-text search over conversation history (messages and/or summaries).
 * Returns a formatted string suitable for display in an LLM tool response.
 */
export function lcmGrep(
  db: Database,
  sessionId: string,
  query: string,
  opts?: { limit?: number; type?: "messages" | "summaries" | "all" },
): string {
  if (query.trim() === "") {
    return "Error: query cannot be empty";
  }

  const limit = opts?.limit ?? DEFAULT_LIMIT;
  const type = opts?.type ?? "all";
  const searchLimit = getSearchLimit(db, sessionId, type, limit);
  const results = searchAll(db, sessionId, query, { limit: searchLimit });
  const filteredResults =
    type === "all"
      ? results
      : results.filter((result) => (type === "messages" ? result.type === "message" : result.type === "summary"));

  const lines: string[] = [];

  for (const result of filteredResults.slice(0, limit)) {
    if (result.type === "message") {
      const meta = getMessageMeta(db, result.id);
      if (!meta) continue;
      const timestamp = formatTimestamp(meta.createdAt);
      lines.push(`[Message #${meta.sequenceNumber} | ${meta.role} | ${timestamp}]`);
      lines.push(result.snippet);
      lines.push("");
      continue;
    }

    const meta = getSummaryMeta(db, result.id);
    if (!meta) continue;
    const timestamp = formatTimestamp(meta.createdAt);
    const coverage =
      meta.minSequence !== null && meta.maxSequence !== null
        ? `covers #${meta.minSequence}-${meta.maxSequence}`
        : "covers #?-?";
    lines.push(`[Summary depth=${meta.depth} | ${coverage} | ${timestamp}]`);
    lines.push(result.snippet);
    lines.push("");
  }

  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  if (lines.length === 0) {
    return `No results found for '${query}'. Try different search terms.`;
  }

  return lines.join("\n");
}

/**
 * Returns the OpenCode tool definition for lcm_grep.
 * Register this under the key "lcm_grep" in the tools hook.
 */
export function createGrepToolDefinition(state: HookSessionState) {
  return tool({
    description:
      "Search the full conversation history (messages and summaries) using BM25 full-text search. Use this when you need to find specific information from earlier in the conversation.",
    args: {
      query: z.string().describe("Search query"),
      limit: z.number().optional().describe("Max results (default 10)"),
      type: z
        .enum(["messages", "summaries", "all"])
        .optional()
        .describe("What to search (default: all)"),
    },
    async execute(args) {
      if (!state.db || !state.sessionId) {
        return "LCM not initialized yet";
      }
      return lcmGrep(state.db, state.sessionId, args.query, {
        limit: args.limit,
        type: args.type,
      });
    },
  });
}
