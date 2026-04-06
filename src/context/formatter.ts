import type { ContextItem, LargeFile, Summary } from "../types";

type Message = { role: string; content: string };

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function formatMessageRange(messageIds: string[]): string {
  if (messageIds.length === 0) {
    return "0 messages";
  }

  const numericIds = messageIds.map((id) => Number(id));
  const allNumeric = numericIds.every((id) => Number.isInteger(id) && Number.isFinite(id));

  if (!allNumeric) {
    return `${messageIds.length} messages`;
  }

  const min = Math.min(...numericIds);
  const max = Math.max(...numericIds);
  return min === max ? `${min}` : `${min}-${max}`;
}

export function formatSummaryAsMessage(summary: Summary): Message {
  const coversMessages = formatMessageRange(summary.messageIds);
  const xml = `<context_summary depth="${summary.depth}" tokens="${summary.tokenCount}" covers_messages="${escapeXml(coversMessages)}" created="${escapeXml(summary.createdAt)}">\n${summary.content}\n</context_summary>`;

  return {
    role: "assistant",
    content: xml,
  };
}

export function createContextPreamble(stats: {
  totalMessages: number;
  summariesCount: number;
  dagDepth: number;
  freshTailSize: number;
}): Message {
  return {
    role: "system",
    content:
      `This conversation uses Lossless Context Management. Earlier messages have been summarized into <context_summary> blocks. Each summary preserves all technical decisions, file paths, and code changes. You have access to the full history via lcm_grep and lcm_expand_query tools.\n` +
      `Session stats: ${stats.totalMessages} total messages, ${stats.summariesCount} summaries (DAG depth ${stats.dagDepth}), ${stats.freshTailSize} fresh messages.`,
  };
}

export function formatContextAsMessages(
  contextItems: ContextItem[],
  stats: {
    totalMessages: number;
    summariesCount: number;
    dagDepth: number;
    freshTailSize: number;
  },
): Message[] {
  const messages: Message[] = [createContextPreamble(stats)];

  for (const item of contextItems) {
    if (item.type === "summary") {
      messages.push(
        formatSummaryAsMessage({
          id: item.referenceId,
          depth: item.depth,
          content: item.content,
          tokenCount: item.tokenCount,
          createdAt: "",
          parentIds: [],
          messageIds: [],
          compactionLevel: "normal",
          conversationId: "",
        }),
      );
      continue;
    }

    if (item.type === "message") {
      messages.push({ role: "assistant", content: item.content });
    }
  }

  return messages;
}

export function formatLargeFileReference(fileRef: LargeFile): string {
  const preview = fileRef.content.slice(0, 200);
  const storedAt = fileRef.storedAt.slice(0, 10);
  const remaining = Math.max(fileRef.tokenCount - 200, 0);

  return `<large_file path="${escapeXml(fileRef.originalPath ?? fileRef.placeholder)}" tokens="${fileRef.tokenCount}" stored_at="${escapeXml(storedAt)}">\n${preview}\n... (${remaining} tokens stored externally - use lcm_expand_query to retrieve sections)\n</large_file>`;
}
