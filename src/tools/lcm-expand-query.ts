import type { Database } from "bun:sqlite";
import { tool } from "@opencode-ai/plugin";
import type { HookSessionState } from "../types";
import { getMessages } from "../messages/persistence";
import { searchAll } from "../search/indexer";
import { getChildSummaries, getMessagesForSummary } from "../summaries/dag-store";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const APPROX_CHARS_PER_TOKEN = 4;
const MAX_OUTPUT_TOKENS = 50_000;
const MAX_OUTPUT_CHARS = MAX_OUTPUT_TOKENS * APPROX_CHARS_PER_TOKEN;

interface SummaryRow {
  id: string;
  conversation_id: string;
  depth: number;
  content: string;
  token_count: number;
  created_at: string;
  compaction_level: string;
}

interface MessageRow {
  id: string;
  role: string;
  content: string;
  sequence_number: number;
  created_at: string;
}

function getSummaryById(db: Database, summaryId: string, conversationId: string): SummaryRow | null {
  return db
    .query<SummaryRow, [string, string]>(
      `SELECT id, conversation_id, depth, content, token_count, created_at, compaction_level
       FROM summaries
       WHERE id = ? AND conversation_id = ?`,
    )
    .get(summaryId, conversationId) ?? null;
}

function getMessageById(db: Database, messageId: string): MessageRow | null {
  return db
    .query<MessageRow, [string]>(
      `SELECT id, role, content, sequence_number, created_at
       FROM messages
       WHERE id = ?`,
    )
    .get(messageId) ?? null;
}

function getSummaryMessageRows(db: Database, messageIds: string[]): MessageRow[] {
  if (messageIds.length === 0) return [];

  const rows: MessageRow[] = [];
  for (const id of messageIds) {
    const row = getMessageById(db, id);
    if (row) rows.push(row);
  }
  rows.sort((a, b) => a.sequence_number - b.sequence_number);
  return rows;
}

function appendSection(sections: string[], remainingChars: number, section: string): number {
  const separatorLength = sections.length === 0 ? 0 : 2;
  const cost = separatorLength + section.length;

  if (cost > remainingChars) {
    return remainingChars;
  }

  sections.push(section);
  return remainingChars - cost;
}

function expandSummaryById(
  db: Database,
  summaryId: string,
  conversationId: string,
  format: "full" | "condensed",
): string {
  const summary = getSummaryById(db, summaryId, conversationId);
  if (!summary) {
    return `Summary not found: ${summaryId}`;
  }

  const messageIds = getMessagesForSummary(db, summaryId);
  const messageRows = getSummaryMessageRows(db, messageIds);
  const childSummaries = getChildSummaries(db, summaryId);

  const minSeq = messageRows.length > 0 ? messageRows[0].sequence_number : 0;
  const maxSeq = messageRows.length > 0 ? messageRows[messageRows.length - 1].sequence_number : 0;

  const headerLine = `=== Expanded: Summary ${summary.id} (depth ${summary.depth}) ===`;
  const summaryBlock = `Summary text:\n${summary.content}`;
  const rangeBlock = `Covers messages: ${minSeq}-${maxSeq} (${messageRows.length} messages)`;
  const sections: string[] = [];
  let remainingChars = MAX_OUTPUT_CHARS;

  remainingChars = appendSection(sections, remainingChars, headerLine);
  remainingChars = appendSection(sections, remainingChars, summaryBlock);
  remainingChars = appendSection(sections, remainingChars, rangeBlock);

  for (const childSummary of childSummaries) {
    const childBlock = `### Child Summary (depth=${childSummary.depth}, id=${childSummary.id})\n${childSummary.content}`;
    remainingChars = appendSection(sections, remainingChars, childBlock);
  }

  if (format === "condensed" || messageRows.length === 0) {
    return sections.join("\n\n");
  }

  remainingChars = appendSection(sections, remainingChars, "Original message content:");

  let shown = 0;
  for (const row of messageRows) {
    const block = `[#${row.sequence_number} ${row.role}] ${row.content}`;
    const nextRemaining = appendSection(sections, remainingChars, block);
    if (nextRemaining === remainingChars) {
      break;
    }
    remainingChars = nextRemaining;
    shown++;
  }

  const remaining = messageRows.length - shown;
  if (remaining > 0) {
    appendSection(sections, remainingChars, `... (${remaining} more messages not shown)`);
  }

  return sections.join("\n\n");
}

function expandMessageRange(
  db: Database,
  conversationId: string,
  start: number,
  end: number,
): string {
  const allMessages = getMessages(db, conversationId);
  const filtered = allMessages.filter(
    (m) => m.sequenceNumber >= start && m.sequenceNumber <= end,
  );

  if (filtered.length === 0) {
    return `No messages found in range ${start}-${end} for this session.`;
  }

  const header = `=== Messages ${start}-${end} ===`;
  const blocks: string[] = [header];
  let totalChars = header.length;

  for (let i = 0; i < filtered.length; i++) {
    const msg = filtered[i];
    const msgHeader = `[#${msg.sequenceNumber} ${msg.role} | ${msg.timestamp}]`;
    const block = `${msgHeader}\n${msg.content}`;
    totalChars += block.length + 5;

    if (totalChars > MAX_OUTPUT_CHARS) break;

    if (i > 0) blocks.push("---");
    blocks.push(block);
  }

  return blocks.join("\n\n");
}

function expandBySearchQuery(
  db: Database,
  conversationId: string,
  query: string,
): string {
  const results = searchAll(db, conversationId, query, { limit: 5 });

  if (results.length === 0) {
    return `No results found for: "${query}"`;
  }

  const header = `=== Full content for: "${query}" ===`;
  const blocks: string[] = [header];
  let totalChars = header.length;

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    let blockHeader: string;
    let content: string;

    if (result.type === "message") {
      const row = getMessageById(db, result.id);
      if (!row) continue;
      blockHeader = `[Message #${row.sequence_number} | ${row.role} | ${row.created_at}]`;
      content = row.content;
    } else {
      const row = db
        .query<SummaryRow, [string]>(
          `SELECT id, conversation_id, depth, content, token_count, created_at, compaction_level
           FROM summaries WHERE id = ?`,
        )
        .get(result.id);
      if (!row) continue;
      blockHeader = `[Summary depth=${row.depth} | ${row.created_at}]`;
      content = row.content;
    }

    const block = `${blockHeader}\n${content}`;
    totalChars += block.length + 5;

    if (totalChars > MAX_OUTPUT_CHARS) break;

    if (i > 0) blocks.push("---");
    blocks.push(block);
  }

  return blocks.join("\n\n");
}

export function lcmExpandQuery(
  db: Database,
  sessionId: string,
  target: string,
  opts?: { format?: "full" | "condensed" },
): string {
  const format = opts?.format ?? "full";

  if (UUID_RE.test(target)) {
    return expandSummaryById(db, target, sessionId, format);
  }

  if (target.startsWith("messages:")) {
    const rangeStr = target.slice("messages:".length);
    const [startStr, endStr] = rangeStr.split("-");
    const start = parseInt(startStr, 10);
    const end = parseInt(endStr, 10);

    if (isNaN(start) || isNaN(end)) {
      return `Invalid message range format: "${target}". Expected "messages:N-M".`;
    }

    return expandMessageRange(db, sessionId, start, end);
  }

  return expandBySearchQuery(db, sessionId, target);
}

export function createExpandQueryToolDefinition(state: HookSessionState) {
  return tool({
    description:
      "Retrieve full content of a specific summary, message range, or search result. Use when you need the complete text of something referenced in context.",
    args: {
      target: tool.schema.string().describe(
        "Summary UUID, message range (e.g. 'messages:10-25'), or search query",
      ),
      format: tool.schema
        .enum(["full", "condensed"])
        .optional()
        .describe("Output verbosity (default: full)"),
    },
    async execute(args) {
      if (!state.db || !state.sessionId) {
        return "LCM not initialized yet";
      }

      return lcmExpandQuery(state.db, state.sessionId, args.target, {
        format: args.format as "full" | "condensed" | undefined,
      });
    },
  });
}
