import type { Database } from "bun:sqlite";
import { getUnsummarizedMessages } from "../messages/persistence";
import {
  getLeafSummaries,
  getRootSummaries,
  getSummaryTree,
} from "../summaries/dag-store";
import { searchAll } from "../search/indexer";
import type { ContextItem, LcmConfig, Summary, SummaryNode } from "../types";
import { countTokens } from "../utils/tokens";

interface ContextMessage {
  role: string;
  content: string;
}

const DEFAULT_SUMMARY_RELEVANCE = 0.25;
const DEFAULT_MESSAGE_RELEVANCE = 0.5;

function normalizeSearchRanks(
  db: Database,
  sessionId: string,
  query?: string,
): Map<string, number> {
  if (!query?.trim()) {
    return new Map();
  }

  const results = searchAll(db, sessionId, query, { limit: 100 });
  if (results.length === 0) {
    return new Map();
  }

  const bestRank = results[0]?.rank ?? 0;
  const worstRank = results[results.length - 1]?.rank ?? bestRank;
  const rankRange = worstRank - bestRank;

  return new Map(
    results.map((result) => {
      const normalized =
        rankRange === 0 ? 1 : Math.max(0, Math.min(1, (worstRank - result.rank) / rankRange));

      return [`${result.type}:${result.id}`, normalized];
    }),
  );
}

function flattenSummaryTree(nodes: SummaryNode[]): Summary[] {
  return nodes.flatMap((node) => [node.summary, ...flattenSummaryTree(node.children)]);
}

function dedupeSummaries(summaries: Summary[]): Summary[] {
  const uniqueSummaries = new Map<string, Summary>();

  for (const summary of summaries) {
    uniqueSummaries.set(summary.id, summary);
  }

  return Array.from(uniqueSummaries.values());
}

function sortChronologically<T extends { createdAt: string }>(items: T[]): T[] {
  return [...items].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function isRootSummary(summary: Summary): boolean {
  return summary.depth > 0 && summary.parentIds.length === 0;
}

function isLeafSummary(summary: Summary): boolean {
  return summary.depth === 0;
}

export function prioritizeSummaries(summaries: Summary[], budget: number): Summary[] {
  if (budget <= 0 || summaries.length === 0) {
    return [];
  }

  const uniqueSummaries = dedupeSummaries(summaries);
  const rootSummaries = uniqueSummaries
    .filter(isRootSummary)
    .sort((left, right) => right.depth - left.depth || left.createdAt.localeCompare(right.createdAt));
  const leafSummaries = sortChronologically(
    uniqueSummaries.filter((summary) => isLeafSummary(summary) && !isRootSummary(summary)),
  );

  const selectedIds = new Set<string>();
  for (const summary of [...rootSummaries, ...leafSummaries]) {
    selectedIds.add(summary.id);
  }

  const remainingSummaries = sortChronologically(
    uniqueSummaries.filter((summary) => !selectedIds.has(summary.id)),
  );

  const prioritized = [...rootSummaries, ...leafSummaries, ...remainingSummaries];
  const selected: Summary[] = [];
  let usedTokens = 0;

  for (const summary of prioritized) {
    if (usedTokens + summary.tokenCount > budget) {
      break;
    }

    selected.push(summary);
    usedTokens += summary.tokenCount;
  }

  return sortChronologically(selected);
}

export function assembleContext(
  db: Database,
  config: LcmConfig,
  sessionId: string,
  query?: string,
): ContextItem[] {
  const unsummarizedMessages = getUnsummarizedMessages(db, sessionId);
  const relevanceScores = normalizeSearchRanks(db, sessionId, query);

  let freshTail = unsummarizedMessages.slice(-config.freshTailSize).map((message) => ({
    message,
    computedTokenCount: countTokens(message.content),
  }));
  let freshTailTokens = freshTail.reduce(
    (total, item) => total + item.computedTokenCount,
    0,
  );

  while (freshTail.length > 0 && freshTailTokens > config.maxContextTokens) {
    const removed = freshTail.shift();
    if (!removed) {
      break;
    }

    freshTailTokens -= removed.computedTokenCount;
  }

  const rootSummaries = getRootSummaries(db, sessionId);
  const leafSummaries = getLeafSummaries(db, sessionId);
  const allSummaries = flattenSummaryTree(getSummaryTree(db, sessionId));
  const remainingBudget = Math.max(0, config.maxContextTokens - freshTailTokens);
  const selectedSummaries = prioritizeSummaries(
    dedupeSummaries([...rootSummaries, ...leafSummaries, ...allSummaries]),
    remainingBudget,
  );

  const summaryItems: ContextItem[] = selectedSummaries.map((summary) => ({
    type: "summary",
    content: summary.content,
    tokenCount: summary.tokenCount,
    relevanceScore: query?.trim()
      ? (relevanceScores.get(`summary:${summary.id}`) ?? DEFAULT_SUMMARY_RELEVANCE)
      : 1,
    referenceId: summary.id,
    depth: summary.depth,
    createdAt: summary.createdAt,
    parentIds: summary.parentIds,
    messageIds: summary.messageIds,
  }));

  const messageItems: ContextItem[] = freshTail.map(({ message }) => ({
    type: "message",
    content: message.content,
    tokenCount: message.tokenCount,
    relevanceScore: query?.trim()
      ? (relevanceScores.get(`message:${message.id}`) ?? DEFAULT_MESSAGE_RELEVANCE)
      : 1,
    referenceId: message.id,
    depth: 0,
    role: message.role,
  }));

  return [...summaryItems, ...messageItems];
}

export function buildContextMessages(contextItems: ContextItem[]): ContextMessage[] {
  return contextItems.map((contextItem) => ({
    role:
      contextItem.type === "system"
        ? "system"
        : contextItem.type === "message"
          ? (contextItem.role ?? "assistant")
          : "assistant",
    content: contextItem.content,
  }));
}

export function estimateContextTokens(contextItems: ContextItem[]): number {
  return contextItems.reduce((total, item) => total + item.tokenCount, 0);
}
