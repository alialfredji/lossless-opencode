import type { Database } from "bun:sqlite";
import { getUnsummarizedMessages } from "../messages/persistence";
import {
  batchSummarize,
  shouldSummarize,
  splitIntoChunks,
  summarize,
} from "../summarization/summarizer";
import {
  getLeafSummaries,
  getRootSummaries,
  getSummariesAtDepth,
  linkSummaryToMessages,
  linkSummaryToParent,
  storeSummary,
} from "../summaries/dag-store";
import type { CompactionLevel, LcmConfig, LcmMessage, Summary } from "../types";

type CompactResult = {
  summariesCreated: number;
  depth: number;
  tokensProcessed: number;
};

type CondenseStats = {
  summariesCreated: number;
  tokensProcessed: number;
  depth: number;
};

const MIN_SUMMARIES_TO_CONDENSE = 5;

function resolveTokenThresholds(config: LcmConfig): {
  soft: number;
  hard: number;
} {
  const derivedSoft = Math.max(1, Math.floor(config.maxContextTokens * 0.7));
  const derivedHard = Math.max(derivedSoft, Math.floor(config.maxContextTokens * 0.9));

  const softBase =
    config.softTokenThreshold > 0 && config.softTokenThreshold < config.maxContextTokens
      ? config.softTokenThreshold
      : derivedSoft;
  const soft = Math.min(softBase, Math.max(1, config.leafSummaryBudget * 4));
  const hard =
    config.hardTokenThreshold > soft && config.hardTokenThreshold <= config.maxContextTokens
      ? config.hardTokenThreshold
      : derivedHard;

  return { soft, hard };
}

function getConversationTokenLoad(db: Database, sessionId: string): number {
  const unsummarizedTokenCount = getSummaryTokenCount(getUnsummarizedMessages(db, sessionId));
  const summaries = [...getLeafSummaries(db, sessionId), ...getRootSummaries(db, sessionId)];
  const uniqueSummaries = new Map(summaries.map((summary) => [summary.id, summary]));
  const summaryTokenCount = Array.from(uniqueSummaries.values()).reduce(
    (total, summary) => total + summary.tokenCount,
    0,
  );

  return unsummarizedTokenCount + summaryTokenCount;
}

function getMaxRootDepth(db: Database, sessionId: string): number {
  const rootSummaries = getRootSummaries(db, sessionId);

  if (rootSummaries.length === 0) {
    return 0;
  }

  return Math.max(...rootSummaries.map((summary) => summary.depth));
}

function getUncondensedSummariesAtDepth(
  db: Database,
  sessionId: string,
  depth: number,
): Summary[] {
  return getSummariesAtDepth(db, sessionId, depth).filter(
    (summary) => summary.parentIds.length === 0,
  );
}

function getSummaryTokenCount(messages: LcmMessage[]): number {
  return messages.reduce((total, message) => total + message.tokenCount, 0);
}

function resolveCompactionLevelForDepth(
  depth: number,
  config: LcmConfig,
): CompactionLevel {
  if (depth >= config.maxSummaryDepth) {
    return "deterministic";
  }

  if (depth >= config.aggressiveThreshold) {
    return "aggressive";
  }

  return "normal";
}

function toSummaryMessages(sessionId: string, summaries: Summary[]): LcmMessage[] {
  return summaries.map((summary, index) => ({
    id: summary.id,
    role: "assistant",
    content: summary.content,
    timestamp: summary.createdAt,
    sessionId,
    tokenCount: summary.tokenCount,
    summarized: true,
    sequenceNumber: index + 1,
    conversationId: sessionId,
  }));
}

async function condenseSummariesInternal(
  db: Database,
  config: LcmConfig,
  sessionId: string,
  depth: number,
): Promise<CondenseStats> {
  const childSummaries = getUncondensedSummariesAtDepth(db, sessionId, depth);

  if (childSummaries.length === 0) {
    return {
      summariesCreated: 0,
      depth: getMaxRootDepth(db, sessionId),
      tokensProcessed: 0,
    };
  }

  const batch = toSummaryMessages(sessionId, childSummaries);
  const nextDepth = depth + 1;
  const tokenLevel = determineCompactionLevel(db, sessionId, config);
  const nextLevel =
    tokenLevel === "aggressive"
      ? "aggressive"
      : resolveCompactionLevelForDepth(nextDepth, config);
  const [result] = await batchSummarize(config, [batch], {
    depth: nextDepth,
    aggressive: nextLevel === "aggressive",
  });

  db.transaction(() => {
    const parentId = storeSummary(db, sessionId, {
      depth: nextDepth,
      content: result.text,
      tokenCount: result.outputTokens,
      parentIds: [],
      messageIds: [],
      compactionLevel: nextLevel,
      conversationId: sessionId,
    });

    for (const child of childSummaries) {
      linkSummaryToParent(db, child.id, parentId);
    }
  })();

  return {
    summariesCreated: 1,
    depth: Math.max(nextDepth, getMaxRootDepth(db, sessionId)),
    tokensProcessed: result.inputTokens,
  };
}

export async function compact(
  db: Database,
  config: LcmConfig,
  sessionId: string,
): Promise<CompactResult> {
  let summariesCreated = 0;
  let tokensProcessed = 0;
  let maxDepth = getMaxRootDepth(db, sessionId);
  const { soft } = resolveTokenThresholds(config);

  if (determineCompactionLevel(db, sessionId, config) === "deterministic") {
    await deterministicTruncate(db, config, sessionId);
    maxDepth = getMaxRootDepth(db, sessionId);
  }

  const unsummarizedMessages = getUnsummarizedMessages(db, sessionId);
  const unsummarizedTokenCount = getSummaryTokenCount(unsummarizedMessages);
  const currentTokenLoad = getConversationTokenLoad(db, sessionId);
  const level = determineCompactionLevel(db, sessionId, config);
  const shouldCompact =
    level === "aggressive" ||
    (shouldSummarize(unsummarizedMessages.length, unsummarizedTokenCount, config) &&
      currentTokenLoad >= soft);

  if (unsummarizedMessages.length > 0 && shouldCompact) {
    if (level === "deterministic") {
      await deterministicTruncate(db, config, sessionId);
    } else {
      const chunks = splitIntoChunks(unsummarizedMessages, config.leafSummaryBudget);

      for (const chunk of chunks) {
        const result = await summarize(config, chunk, {
          depth: 0,
          aggressive: level === "aggressive",
        });

        db.transaction(() => {
          const summaryId = storeSummary(db, sessionId, {
            depth: 0,
            content: result.text,
            tokenCount: result.outputTokens,
            parentIds: [],
            messageIds: chunk.map((message) => message.id),
            compactionLevel: level,
            conversationId: sessionId,
          });

          linkSummaryToMessages(
            db,
            summaryId,
            chunk.map((message) => message.id),
          );
        })();

        summariesCreated += 1;
        tokensProcessed += result.inputTokens;
      }

      maxDepth = Math.max(maxDepth, 0);
    }
  }

  if (getLeafSummaries(db, sessionId).length >= MIN_SUMMARIES_TO_CONDENSE) {
    const result = await condenseSummariesInternal(db, config, sessionId, 0);
    summariesCreated += result.summariesCreated;
    tokensProcessed += result.tokensProcessed;
    maxDepth = Math.max(maxDepth, result.depth);
  }

  for (let depth = 1; depth < config.maxSummaryDepth; depth += 1) {
    if (getUncondensedSummariesAtDepth(db, sessionId, depth).length < MIN_SUMMARIES_TO_CONDENSE) {
      continue;
    }

    const result = await condenseSummariesInternal(db, config, sessionId, depth);
    summariesCreated += result.summariesCreated;
    tokensProcessed += result.tokensProcessed;
    maxDepth = Math.max(maxDepth, result.depth);
  }

  if (determineCompactionLevel(db, sessionId, config) === "deterministic") {
    await deterministicTruncate(db, config, sessionId);
    maxDepth = getMaxRootDepth(db, sessionId);
  } else {
    maxDepth = Math.max(maxDepth, getMaxRootDepth(db, sessionId));
  }

  return {
    summariesCreated,
    depth: maxDepth,
    tokensProcessed,
  };
}

export function determineCompactionLevel(
  db: Database,
  sessionId: string,
  config: LcmConfig,
): CompactionLevel {
  const maxDepth = getMaxRootDepth(db, sessionId);
  const { soft, hard } = resolveTokenThresholds(config);
  const tokenLoad = getConversationTokenLoad(db, sessionId);

  if (maxDepth >= config.maxSummaryDepth) {
    return "deterministic";
  }

  if (tokenLoad >= hard) {
    return "aggressive";
  }

  if (maxDepth >= config.aggressiveThreshold) {
    return "aggressive";
  }

  return "normal";
}

export async function condenseSummaries(
  db: Database,
  config: LcmConfig,
  sessionId: string,
  depth: number,
): Promise<void> {
  await condenseSummariesInternal(db, config, sessionId, depth);
}

export async function deterministicTruncate(
  db: Database,
  config: LcmConfig,
  sessionId: string,
): Promise<void> {
  const targetBudget = config.condensedSummaryBudget;
  const leafSummaries = getLeafSummaries(db, sessionId);
  let totalTokens = leafSummaries.reduce(
    (total, summary) => total + summary.tokenCount,
    0,
  );

  if (totalTokens <= targetBudget) {
    return;
  }

  process.stderr.write(
    `[lcm] deterministic truncation triggered for ${sessionId}; leaf summary tokens ${totalTokens} exceed ${targetBudget}\n`,
  );

  for (const summary of leafSummaries) {
    if (totalTokens <= targetBudget) {
      break;
    }

    db.transaction(() => {
      db.query<void, [string]>(
        "DELETE FROM summary_messages WHERE summary_id = ?",
      ).run(summary.id);
      db.query<void, [string, string]>(
        "DELETE FROM summary_parents WHERE child_id = ? OR parent_id = ?",
      ).run(summary.id, summary.id);
      db.query<void, [string]>("DELETE FROM summaries WHERE id = ?").run(summary.id);
    })();

    totalTokens -= summary.tokenCount;
  }
}
