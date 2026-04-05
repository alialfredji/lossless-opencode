import type {
  CompactionLevel,
  CompactionResult,
  ContextItem,
  IntegrityCheckResult,
  LargeFile,
  LcmConfig,
  LcmMessage,
  RetrievalResult,
  SessionState,
  Summary,
  SummaryNode,
} from "../../src/types";

export function mockConfig(overrides?: Partial<LcmConfig>): LcmConfig {
  return {
    dataDir: ".lcm",
    maxContextTokens: 120000,
    softTokenThreshold: 100000,
    hardTokenThreshold: 150000,
    freshTailSize: 64,
    maxLeafSummaryTokens: 1200,
    maxCondensedSummaryTokens: 2000,
    leafSummaryBudget: 1200,
    condensedSummaryBudget: 2000,
    maxSummaryDepth: 5,
    summaryMaxOverageFactor: 3,
    compactionBatchSize: 10,
    aggressiveThreshold: 3,
    model: "anthropic:claude-sonnet-4-20250514",
    enableIntegrity: true,
    enableFts: true,
    largeFileThreshold: 25000,
    dbPath: ":memory:",
    summarizeAfterMessages: 20,
    summarizeAfterTokens: 20000,
    ...overrides,
  };
}

export function mockMessage(overrides?: Partial<LcmMessage>): LcmMessage {
  return {
    id: crypto.randomUUID(),
    role: "user",
    content: "Test message content for unit testing purposes",
    timestamp: new Date().toISOString(),
    sessionId: "test-session-1",
    tokenCount: 8,
    summarized: false,
    sequenceNumber: 1,
    conversationId: "test-conversation-1",
    ...overrides,
  };
}

export function mockSummary(overrides?: Partial<Summary>): Summary {
  return {
    id: crypto.randomUUID(),
    depth: 0,
    content: "This is a test summary of several messages.",
    tokenCount: 10,
    createdAt: new Date().toISOString(),
    parentIds: [],
    messageIds: [],
    compactionLevel: "normal",
    conversationId: "test-conversation-1",
    ...overrides,
  };
}

export function mockSummaryNode(overrides?: Partial<SummaryNode>): SummaryNode {
  return {
    summary: mockSummary(),
    children: [],
    depth: 0,
    ...overrides,
  };
}

export function mockSessionState(overrides?: Partial<SessionState>): SessionState {
  return {
    sessionId: crypto.randomUUID(),
    conversationId: crypto.randomUUID(),
    messageCount: 0,
    lastCompactionAt: null,
    totalTokens: 0,
    ...overrides,
  };
}

export function mockContextItem(overrides?: Partial<ContextItem>): ContextItem {
  return {
    type: "message",
    content: "Context item content used in tests.",
    tokenCount: 7,
    relevanceScore: 0.5,
    referenceId: crypto.randomUUID(),
    depth: 0,
    ...overrides,
  };
}

export function mockCompactionResult(overrides?: Partial<CompactionResult>): CompactionResult {
  return {
    summary: mockSummary(),
    level: "normal",
    inputTokens: 100,
    outputTokens: 24,
    ...overrides,
  };
}

export function mockLargeFile(overrides?: Partial<LargeFile>): LargeFile {
  return {
    id: crypto.randomUUID(),
    placeholder: "[large-file-1]",
    originalPath: null,
    tokenCount: 250,
    structuralSummary: "A small file used to exercise large-file handling in tests.",
    content: "Large file content for testing placeholder logic and storage round trips.",
    storedAt: new Date().toISOString(),
    conversationId: "test-conversation-1",
    messageId: null,
    ...overrides,
  };
}

export function mockIntegrityCheckResult(
  overrides?: Partial<IntegrityCheckResult>,
): IntegrityCheckResult {
  return {
    check: "message-count",
    passed: true,
    details: "Everything looks good.",
    repairAction: undefined,
    ...overrides,
  };
}

export function mockRetrievalResult(overrides?: Partial<RetrievalResult>): RetrievalResult {
  return {
    type: "message",
    id: crypto.randomUUID(),
    content: "Retrieval result content for tests.",
    score: 0.8,
    metadata: {},
    ...overrides,
  };
}

export function mockSummarizer(): (messages: LcmMessage[]) => Promise<string> {
  return async (messages: LcmMessage[]) => {
    const firstWords = messages[0]?.content.split(" ").slice(0, 3).join(" ") ?? "empty";
    return `Summary of ${messages.length} messages about ${firstWords}`;
  };
}

export function mockCompactionLevel(overrides?: CompactionLevel): CompactionLevel {
  return overrides ?? "normal";
}
