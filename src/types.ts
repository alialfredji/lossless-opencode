import { z } from "zod";

export interface LcmConfig {
  softTokenThreshold: number;
  hardTokenThreshold: number;
  freshTailSize: number;
  maxLeafSummaryTokens: number;
  maxCondensedSummaryTokens: number;
  summaryMaxOverageFactor: number;
  compactionBatchSize: number;
  largeFileThreshold: number;
  dbPath: string;
  summarizeAfterMessages: number;
  summarizeAfterTokens: number;
}

export interface LcmMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  timestamp: string;
  sessionId: string;
  tokenCount: number;
  summarized: boolean;
  sequenceNumber: number;
  conversationId: string;
}

export type CompactionLevel = "normal" | "aggressive" | "deterministic";

export interface Summary {
  id: string;
  depth: number;
  content: string;
  tokenCount: number;
  createdAt: string;
  parentIds: string[];
  messageIds: string[];
  compactionLevel: CompactionLevel;
  conversationId: string;
}

export interface SummaryNode {
  summary: Summary;
  children: SummaryNode[];
  depth: number;
}

export interface ContextItem {
  type: "summary" | "message" | "system";
  content: string;
  tokenCount: number;
  relevanceScore: number;
  referenceId: string;
  depth: number;
}

export interface CompactionResult {
  summary: Summary;
  level: CompactionLevel;
  inputTokens: number;
  outputTokens: number;
}

export interface LargeFile {
  id: string;
  placeholder: string;
  originalPath: string | null;
  tokenCount: number;
  structuralSummary: string | null;
  content: string;
  storedAt: string;
  conversationId: string;
  messageId: string | null;
}

export interface IntegrityCheckResult {
  check: string;
  passed: boolean;
  details: string;
  repairAction?: string;
}

export interface SessionState {
  sessionId: string;
  conversationId: string;
  messageCount: number;
  lastCompactionAt: string | null;
  totalTokens: number;
}

export interface RetrievalResult {
  type: "message" | "summary";
  id: string;
  content: string;
  score: number;
  metadata: Record<string, unknown>;
}

export const DEFAULT_CONFIG: LcmConfig = {
  softTokenThreshold: 100000,
  hardTokenThreshold: 150000,
  freshTailSize: 64,
  maxLeafSummaryTokens: 1200,
  maxCondensedSummaryTokens: 2000,
  summaryMaxOverageFactor: 3,
  compactionBatchSize: 10,
  largeFileThreshold: 25000,
  dbPath: ".lcm/lcm.db",
  summarizeAfterMessages: 20,
  summarizeAfterTokens: 20000,
};

export const LcmConfigSchema = z
  .object({
    softTokenThreshold: z.number().positive(),
    hardTokenThreshold: z.number().positive(),
    freshTailSize: z.number().positive(),
    maxLeafSummaryTokens: z.number().positive(),
    maxCondensedSummaryTokens: z.number().positive(),
    summaryMaxOverageFactor: z.number().positive(),
    compactionBatchSize: z.number().positive(),
    largeFileThreshold: z.number().positive(),
    dbPath: z.string().min(1),
    summarizeAfterMessages: z.number().positive(),
    summarizeAfterTokens: z.number().positive(),
  })
  .partial();
