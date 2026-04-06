import type { Database } from "bun:sqlite";
import { tool } from "@opencode-ai/plugin";
import { z } from "zod";
import { searchMessages, searchSummaries } from "../search/indexer";
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
    .prepare<{ depth: number; created_at: string }, [string]>(
      `SELECT depth, created_at FROM summaries WHERE id = ?`,
    )
    .get(summaryId);

  if (!row) return null;
  return {
    depth: row.depth,
    createdAt: row.created_at,
  };
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

  const lines: string[] = [];

  if (type === "messages" || type === "all") {
    const msgResults = searchMessages(db, sessionId, query, { limit });
    for (const r of msgResults) {
      const meta = getMessageMeta(db, r.messageId);
      if (!meta) continue;
      const timestamp = formatTimestamp(meta.createdAt);
      lines.push(`[Message #${meta.sequenceNumber} | ${meta.role} | ${timestamp}]`);
      lines.push(r.snippet);
      lines.push("");
    }
  }

  if (type === "summaries" || type === "all") {
    const sumResults = searchSummaries(db, sessionId, query, { limit });
    for (const r of sumResults) {
      const meta = getSummaryMeta(db, r.summaryId);
      if (!meta) continue;
      const timestamp = formatTimestamp(meta.createdAt);
      lines.push(`[Summary depth=${meta.depth} | ${timestamp}]`);
      lines.push(r.snippet);
      lines.push("");
    }
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
