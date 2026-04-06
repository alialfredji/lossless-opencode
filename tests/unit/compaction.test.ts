import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Database } from "bun:sqlite";
import { storeSummary } from "../../src/summaries/dag-store";
import { createTestDb, cleanupTestDb, seedTestMessages } from "../helpers/db";
import { mockConfig } from "../helpers/mocks";

type SummarizerModule = typeof import("../../src/summarization/summarizer");
type EngineModule = typeof import("../../src/compaction/engine");

async function loadCompactionModule(
  overrides?: Partial<Pick<SummarizerModule, "summarize" | "batchSummarize">>,
): Promise<EngineModule> {
  mock.module("../../src/summarization/summarizer", () => ({
    shouldSummarize: (
      messageCount: number,
      tokenCount: number,
      thresholds: { summarizeAfterMessages: number; summarizeAfterTokens: number },
    ) =>
      messageCount >= thresholds.summarizeAfterMessages ||
      tokenCount >= thresholds.summarizeAfterTokens,
    splitIntoChunks: (messages: Awaited<ReturnType<typeof import("../helpers/db")["seedTestMessages"]>>, targetTokens: number) => {
      if (messages.length === 0) {
        return [];
      }

      const chunks: typeof messages[] = [];
      let chunk: typeof messages = [];
      let chunkTokens = 0;

      for (const message of messages) {
        if (chunk.length > 0 && chunkTokens + message.tokenCount > targetTokens) {
          chunks.push(chunk);
          chunk = [];
          chunkTokens = 0;
        }

        chunk.push(message);
        chunkTokens += message.tokenCount;
      }

      if (chunk.length > 0) {
        chunks.push(chunk);
      }

      return chunks;
    },
    summarize:
      overrides?.summarize ??
      (async (_config, messages, opts) => ({
        text: `leaf depth ${opts.depth}: ${messages.length}`,
        inputTokens: messages.reduce((total, message) => total + message.tokenCount, 0),
        outputTokens: 42,
      })),
    batchSummarize:
      overrides?.batchSummarize ??
      (async (_config, batches, opts = { depth: 0 }) =>
        batches.map((batch) => ({
          text: `condensed depth ${opts.depth}: ${batch.length}`,
          inputTokens: batch.reduce((total, message) => total + message.tokenCount, 0),
          outputTokens: 64,
        }))),
  }));

  return import(`../../src/compaction/engine.ts?test=${crypto.randomUUID()}`);
}

describe("compaction engine", () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    mock.restore();
    cleanupTestDb(db);
  });

  it("leaf summaries", async () => {
    const conversationId = "conv-leaf-summaries";
    seedTestMessages(db, conversationId, 25);

    const { compact } = await loadCompactionModule();
    const result = await compact(
      db,
      mockConfig({
        summarizeAfterMessages: 20,
        summarizeAfterTokens: 999999,
        leafSummaryBudget: 300,
      }),
      conversationId,
    );

    const summaries = db
      .query<{ depth: number }, [string]>(
        "SELECT depth FROM summaries WHERE conversation_id = ? ORDER BY created_at ASC",
      )
      .all(conversationId);

    expect(result.summariesCreated).toBeGreaterThan(0);
    expect(summaries.length).toBeGreaterThan(0);
    expect(summaries.every((summary) => summary.depth === 0 || summary.depth === 1)).toBeTrue();
    expect(summaries.some((summary) => summary.depth === 0)).toBeTrue();
  });

  it("condensation", async () => {
    const conversationId = "conv-condensation";
    db.query("INSERT OR IGNORE INTO conversations (id, session_id) VALUES (?, ?)").run(
      conversationId,
      conversationId,
    );

    for (let index = 0; index < 6; index += 1) {
      storeSummary(db, conversationId, {
        depth: 0,
        content: `Leaf summary ${index + 1}`,
        tokenCount: 25,
        parentIds: [],
        messageIds: [],
        compactionLevel: "normal",
        conversationId,
      });
    }

    const { compact } = await loadCompactionModule();

    await compact(
      db,
      mockConfig({
        summarizeAfterMessages: 20,
        summarizeAfterTokens: 20000,
      }),
      conversationId,
    );

    const depthOneCount = db
      .query<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM summaries WHERE conversation_id = ? AND depth = 1",
      )
      .get(conversationId)?.count;
    const parentLinks = db
      .query<{ count: number }, [string]>(
        `SELECT COUNT(*) AS count
         FROM summary_parents
         WHERE parent_id IN (
           SELECT id FROM summaries WHERE conversation_id = ? AND depth = 1
         )`,
      )
      .get(conversationId)?.count;

    expect(depthOneCount).toBe(1);
    expect(parentLinks).toBe(6);
  });

  it("escalation", async () => {
    const { determineCompactionLevel } = await loadCompactionModule();
    const config = mockConfig({ aggressiveThreshold: 3, maxSummaryDepth: 5 });

    const normalConversation = "conv-escalation-normal";
    db.query("INSERT OR IGNORE INTO conversations (id, session_id) VALUES (?, ?)").run(
      normalConversation,
      normalConversation,
    );
    storeSummary(db, normalConversation, {
      depth: 0,
      content: "Normal root",
      tokenCount: 10,
      parentIds: [],
      messageIds: [],
      compactionLevel: "normal",
      conversationId: normalConversation,
    });

    const aggressiveConversation = "conv-escalation-aggressive";
    db.query("INSERT OR IGNORE INTO conversations (id, session_id) VALUES (?, ?)").run(
      aggressiveConversation,
      aggressiveConversation,
    );
    storeSummary(db, aggressiveConversation, {
      depth: 3,
      content: "Aggressive root",
      tokenCount: 10,
      parentIds: [],
      messageIds: [],
      compactionLevel: "aggressive",
      conversationId: aggressiveConversation,
    });

    const deterministicConversation = "conv-escalation-deterministic";
    db.query("INSERT OR IGNORE INTO conversations (id, session_id) VALUES (?, ?)").run(
      deterministicConversation,
      deterministicConversation,
    );
    storeSummary(db, deterministicConversation, {
      depth: 5,
      content: "Deterministic root",
      tokenCount: 10,
      parentIds: [],
      messageIds: [],
      compactionLevel: "deterministic",
      conversationId: deterministicConversation,
    });

    expect(determineCompactionLevel(db, normalConversation, config)).toBe("normal");
    expect(determineCompactionLevel(db, aggressiveConversation, config)).toBe("aggressive");
    expect(determineCompactionLevel(db, deterministicConversation, config)).toBe(
      "deterministic",
    );
  });
});
