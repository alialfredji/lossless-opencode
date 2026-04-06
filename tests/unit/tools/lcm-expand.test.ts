import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { createTestDb, cleanupTestDb, seedTestMessages } from "../../helpers";
import { lcmExpandQuery } from "../../../src/tools/lcm-expand-query";
import { storeSummary, linkSummaryToMessages } from "../../../src/summaries/dag-store";

const CONV_ID = "conv-expand-test";

function seedConversation(db: Database, conversationId: string): void {
  db.query("INSERT OR IGNORE INTO conversations (id, session_id) VALUES (?, ?)").run(
    conversationId,
    `session-${conversationId}`,
  );
}

describe("lcmExpandQuery — summary by ID", () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
    seedConversation(db, CONV_ID);
  });

  afterEach(() => {
    cleanupTestDb(db);
  });

  it("expand summary by ID returns summary text and Covers messages header", () => {
    const messages = seedTestMessages(db, CONV_ID, 5);
    const messageIds = messages.map((m) => m.id);

    const summaryId = storeSummary(db, CONV_ID, {
      conversationId: CONV_ID,
      depth: 1,
      content: "This is a test summary covering five messages about debugging.",
      tokenCount: 20,
      parentIds: [],
      messageIds: [],
      compactionLevel: "normal",
    });
    linkSummaryToMessages(db, summaryId, messageIds);

    const result = lcmExpandQuery(db, CONV_ID, summaryId);

    expect(result).toContain("This is a test summary covering five messages about debugging.");
    expect(result).toContain("Covers messages:");
    expect(result).toContain(`Summary ${summaryId}`);
  });

  it("condensed format omits original message content", () => {
    const messages = seedTestMessages(db, CONV_ID, 3);
    const messageIds = messages.map((m) => m.id);

    const summaryId = storeSummary(db, CONV_ID, {
      conversationId: CONV_ID,
      depth: 0,
      content: "Condensed summary of three messages.",
      tokenCount: 10,
      parentIds: [],
      messageIds: [],
      compactionLevel: "normal",
    });
    linkSummaryToMessages(db, summaryId, messageIds);

    const result = lcmExpandQuery(db, CONV_ID, summaryId, { format: "condensed" });

    expect(result).toContain("Condensed summary of three messages.");
    expect(result).toContain("Covers messages:");
    expect(result).not.toContain("Original message content:");
  });
});

describe("lcmExpandQuery — invalid summary ID", () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
    seedConversation(db, CONV_ID);
  });

  afterEach(() => {
    cleanupTestDb(db);
  });

  it("returns Summary not found message for non-existent UUID", () => {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    const result = lcmExpandQuery(db, CONV_ID, fakeId);

    expect(result).toContain(`Summary not found: ${fakeId}`);
  });
});

describe("lcmExpandQuery — message range", () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
    seedTestMessages(db, CONV_ID, 20);
  });

  afterEach(() => {
    cleanupTestDb(db);
  });

  it("returns exactly 6 messages for range 10-15", () => {
    const result = lcmExpandQuery(db, CONV_ID, "messages:10-15");

    expect(result).toContain("=== Messages 10-15 ===");
    const seqMatches = result.match(/#\d+/g) ?? [];
    const seqNumbers = seqMatches.map((m) => parseInt(m.slice(1), 10));
    const inRange = seqNumbers.filter((n) => n >= 10 && n <= 15);
    expect(inRange.length).toBe(6);
  });

  it("off-by-one range returns only available messages 18-20", () => {
    const result = lcmExpandQuery(db, CONV_ID, "messages:18-25");

    expect(result).toContain("=== Messages 18-25 ===");
    const seqMatches = result.match(/#\d+/g) ?? [];
    const seqNumbers = seqMatches.map((m) => parseInt(m.slice(1), 10));
    const inRange = seqNumbers.filter((n) => n >= 18 && n <= 20);
    expect(inRange.length).toBe(3);

    const outOfRange = seqNumbers.filter((n) => n > 20);
    expect(outOfRange.length).toBe(0);
  });

  it("returns helpful message when no messages found in range", () => {
    const result = lcmExpandQuery(db, CONV_ID, "messages:50-60");

    expect(result).toContain("No messages found in range");
  });
});

describe("lcmExpandQuery — search query", () => {
  let db: Database;
  const searchConvId = "conv-expand-search";

  beforeEach(() => {
    db = createTestDb();
    seedConversation(db, searchConvId);

    db.query(
      `INSERT INTO messages (id, conversation_id, role, content, token_count, sequence_number, created_at)
       VALUES (?, ?, 'user', ?, 1, ?, datetime('now'))`,
    ).run("search-msg-001", searchConvId, "The Kubernetes orchestration system deploys containers", 1);
    db.query(
      `INSERT INTO messages (id, conversation_id, role, content, token_count, sequence_number, created_at)
       VALUES (?, ?, 'assistant', ?, 1, ?, datetime('now'))`,
    ).run("search-msg-002", searchConvId, "Kubernetes pods are managed by the scheduler component", 2);
  });

  afterEach(() => {
    cleanupTestDb(db);
  });

  it("returns full message content for a matching search term", () => {
    const result = lcmExpandQuery(db, searchConvId, "Kubernetes");

    expect(result).toContain(`=== Full content for: "Kubernetes" ===`);
    expect(result).toContain("Kubernetes");
    expect(
      result.includes("orchestration") || result.includes("scheduler")
    ).toBe(true);
  });

  it("returns no results message when query matches nothing", () => {
    const result = lcmExpandQuery(db, searchConvId, "xyzabcdefnonexistent");

    expect(result).toContain("No results found for:");
  });
});
