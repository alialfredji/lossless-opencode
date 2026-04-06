import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  assembleContext,
  buildContextMessages,
  estimateContextTokens,
  prioritizeSummaries,
} from "../../src/context/assembler";
import { persistMessage } from "../../src/messages/persistence";
import { linkSummaryToParent, storeSummary } from "../../src/summaries/dag-store";
import type { LcmMessage, Summary } from "../../src/types";
import { countTokens } from "../../src/utils/tokens";
import { cleanupTestDb, createTestDb, mockConfig } from "../helpers";

function setupConversation(db: Database, conversationId: string): void {
  db.query("INSERT OR IGNORE INTO conversations (id, session_id) VALUES (?, ?)").run(
    conversationId,
    conversationId,
  );
}

function createRepeatedContent(label: string, repeatCount: number): string {
  return `${label} ${"token ".repeat(repeatCount)}`.trim();
}

function insertMessage(
  db: Database,
  conversationId: string,
  role: LcmMessage["role"],
  content: string,
): LcmMessage {
  const message: LcmMessage = {
    id: crypto.randomUUID(),
    role,
    content,
    timestamp: new Date().toISOString(),
    sessionId: conversationId,
    tokenCount: countTokens(content),
    summarized: false,
    sequenceNumber: 0,
    conversationId,
  };

  persistMessage(db, conversationId, message);
  return message;
}

function createSummary(
  db: Database,
  conversationId: string,
  depth: number,
  content: string,
  createdAt: string,
): Summary {
  const tokenCount = countTokens(content);
  const summaryId = storeSummary(db, conversationId, {
    depth,
    content,
    tokenCount,
    compactionLevel: "normal",
    conversationId,
    parentIds: [],
    messageIds: [],
  });

  db.query("UPDATE summaries SET created_at = ? WHERE id = ?").run(createdAt, summaryId);

  return {
    id: summaryId,
    depth,
    content,
    tokenCount,
    createdAt,
    parentIds: [],
    messageIds: [],
    compactionLevel: "normal",
    conversationId,
  };
}

describe("assembleContext budget", () => {
  let db: Database;
  const conversationId = "conv-assembler-budget";

  beforeEach(() => {
    db = createTestDb();
    setupConversation(db, conversationId);
  });

  afterEach(() => {
    cleanupTestDb(db);
  });

  it("budget: keeps assembled context within maxContextTokens", () => {
    const rootSummary = createSummary(
      db,
      conversationId,
      1,
      createRepeatedContent("summary root", 1500),
      "2024-01-01T10:00:00.000Z",
    );
    const childLeaf = createSummary(
      db,
      conversationId,
      0,
      createRepeatedContent("summary leaf", 1200),
      "2024-01-01T10:01:00.000Z",
    );
    linkSummaryToParent(db, childLeaf.id, rootSummary.id);

    const freshMessages = Array.from({ length: 5 }, (_, index) =>
      insertMessage(
        db,
        conversationId,
        index % 2 === 0 ? "user" : "assistant",
        createRepeatedContent(`fresh message ${index + 1}`, 5000),
      ),
    );

    const contextItems = assembleContext(
      db,
      mockConfig({ maxContextTokens: 15000 }),
      conversationId,
    );

    expect(estimateContextTokens(contextItems)).toBeLessThanOrEqual(15000);
    expect(contextItems.every((item) => item.referenceId !== freshMessages[0].id)).toBe(true);
    expect(contextItems.some((item) => item.referenceId === freshMessages.at(-1)?.id)).toBe(true);
    expect(contextItems.some((item) => item.type === "summary")).toBe(true);
  });
});

describe("prioritizeSummaries prioritization", () => {
  it("prioritization: includes both roots before leaves when budget fits four summaries", () => {
    const summaries: Summary[] = [
      {
        id: "root-1",
        depth: 2,
        content: "Root summary one",
        tokenCount: 10,
        createdAt: "2024-01-01T10:00:00.000Z",
        parentIds: [],
        messageIds: [],
        compactionLevel: "normal",
        conversationId: "conv-priority",
      },
      {
        id: "root-2",
        depth: 1,
        content: "Root summary two",
        tokenCount: 10,
        createdAt: "2024-01-01T10:01:00.000Z",
        parentIds: [],
        messageIds: [],
        compactionLevel: "normal",
        conversationId: "conv-priority",
      },
      {
        id: "leaf-1",
        depth: 0,
        content: "Leaf summary one",
        tokenCount: 10,
        createdAt: "2024-01-01T10:02:00.000Z",
        parentIds: ["root-1"],
        messageIds: [],
        compactionLevel: "normal",
        conversationId: "conv-priority",
      },
      {
        id: "leaf-2",
        depth: 0,
        content: "Leaf summary two",
        tokenCount: 10,
        createdAt: "2024-01-01T10:03:00.000Z",
        parentIds: ["root-1"],
        messageIds: [],
        compactionLevel: "normal",
        conversationId: "conv-priority",
      },
      {
        id: "leaf-3",
        depth: 0,
        content: "Leaf summary three",
        tokenCount: 10,
        createdAt: "2024-01-01T10:04:00.000Z",
        parentIds: ["root-2"],
        messageIds: [],
        compactionLevel: "normal",
        conversationId: "conv-priority",
      },
      {
        id: "leaf-4",
        depth: 0,
        content: "Leaf summary four",
        tokenCount: 10,
        createdAt: "2024-01-01T10:05:00.000Z",
        parentIds: ["root-2"],
        messageIds: [],
        compactionLevel: "normal",
        conversationId: "conv-priority",
      },
    ];

    const selected = prioritizeSummaries(summaries, 40);

    expect(selected).toHaveLength(4);
    expect(selected.slice(0, 2).map((summary) => summary.id)).toEqual(["root-1", "root-2"]);
    expect(selected.map((summary) => summary.id)).toEqual([
      "root-1",
      "root-2",
      "leaf-1",
      "leaf-2",
    ]);
  });
});

describe("assembleContext fresh only", () => {
  let db: Database;
  const conversationId = "conv-assembler-fresh-only";

  beforeEach(() => {
    db = createTestDb();
    setupConversation(db, conversationId);
  });

  afterEach(() => {
    cleanupTestDb(db);
  });

  it("fresh only: returns all messages in order when there are no summaries", () => {
    const messages = Array.from({ length: 15 }, (_, index) =>
      insertMessage(
        db,
        conversationId,
        index % 2 === 0 ? "user" : "assistant",
        `Fresh only message ${index + 1}`,
      ),
    );

    const contextItems = assembleContext(
      db,
      mockConfig({ maxContextTokens: 15000 }),
      conversationId,
    );
    const transformedMessages = buildContextMessages(contextItems);

    expect(contextItems).toHaveLength(15);
    expect(contextItems.every((item) => item.type === "message")).toBe(true);
    expect(contextItems.map((item) => item.referenceId)).toEqual(messages.map((message) => message.id));
    expect(transformedMessages).toHaveLength(15);
    expect(transformedMessages[0]).toEqual({
      role: "assistant",
      content: messages[0].content,
    });
    expect(estimateContextTokens(contextItems)).toBe(
      messages.reduce((total, message) => total + message.tokenCount, 0),
    );
  });
});
