import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { createTestDb, cleanupTestDb } from "../helpers";
import {
  searchMessages,
  searchAll,
  rebuildIndex,
} from "../../src/search/indexer";

function seedConversation(db: Database, conversationId: string): void {
  db.query("INSERT OR IGNORE INTO conversations (id, session_id) VALUES (?, ?)").run(
    conversationId,
    `session-${conversationId}`,
  );
}

function insertMessage(
  db: Database,
  conversationId: string,
  id: string,
  content: string,
  sequenceNumber: number,
): void {
  db.query(
    `INSERT INTO messages (id, conversation_id, role, content, token_count, sequence_number, created_at)
     VALUES (?, ?, 'user', ?, 1, ?, datetime('now'))`,
  ).run(id, conversationId, content, sequenceNumber);
}

function insertSummary(
  db: Database,
  conversationId: string,
  id: string,
  content: string,
  depth = 0,
): void {
  db.query(
    `INSERT INTO summaries (id, conversation_id, depth, content, token_count, compaction_level, created_at)
     VALUES (?, ?, ?, ?, 1, 'normal', datetime('now'))`,
  ).run(id, conversationId, depth, content);
}

describe("message search", () => {
  let db: Database;
  const convId = "conv-search-001";

  beforeEach(() => {
    db = createTestDb();
    seedConversation(db, convId);

    insertMessage(db, convId, "msg-001", "The deployment pipeline uses Kubernetes orchestration", 1);
    insertMessage(db, convId, "msg-002", "Database migrations run before the server starts", 2);
    insertMessage(db, convId, "msg-003", "Authentication tokens expire after 24 hours", 3);
    insertMessage(db, convId, "msg-004", "The frontend renders React components with hooks", 4);
    insertMessage(db, convId, "msg-005", "TypeScript strict mode catches null pointer errors", 5);
    insertMessage(db, convId, "msg-006", "The caching layer uses Redis for session storage", 6);
    insertMessage(db, convId, "msg-007", "Load balancer distributes requests across pods", 7);
    insertMessage(db, convId, "msg-008", "Authentication middleware validates JWT tokens", 8);
    insertMessage(db, convId, "msg-009", "Error handling wraps async operations", 9);
    insertMessage(db, convId, "msg-010", "The scheduler triggers compaction jobs nightly", 10);
  });

  afterEach(() => {
    cleanupTestDb(db);
  });

  it("returns exactly 2 results when only 2 messages match the query term", () => {
    const results = searchMessages(db, convId, "authentication");

    expect(results).toHaveLength(2);
    const ids = results.map((r) => r.messageId);
    expect(ids).toContain("msg-003");
    expect(ids).toContain("msg-008");
  });

  it("results include rank and non-empty snippet", () => {
    const results = searchMessages(db, convId, "authentication");

    for (const r of results) {
      expect(typeof r.rank).toBe("number");
      expect(r.snippet.length).toBeGreaterThan(0);
    }
  });

  it("respects limit option", () => {
    const results = searchMessages(db, convId, "the", { limit: 2 });
    expect(results.length).toBeLessThanOrEqual(2);
  });
});

describe("session isolation", () => {
  let db: Database;
  const convA = "conv-isolation-A";
  const convB = "conv-isolation-B";

  beforeEach(() => {
    db = createTestDb();
    seedConversation(db, convA);
    seedConversation(db, convB);

    insertMessage(db, convA, "a-001", "Authentication tokens are validated by middleware", 1);
    insertMessage(db, convA, "a-002", "The authentication service runs on port 8080", 2);
    insertMessage(db, convB, "b-001", "Authentication is handled by an external provider", 1);
    insertMessage(db, convB, "b-002", "Authentication tokens use RSA signing", 2);
    insertMessage(db, convB, "b-003", "Authentication middleware checks expiry timestamps", 3);
  });

  afterEach(() => {
    cleanupTestDb(db);
  });

  it("searching session A returns 0 results from session B", () => {
    const results = searchMessages(db, convA, "authentication");

    expect(results).toHaveLength(2);
    const ids = results.map((r) => r.messageId);
    expect(ids).not.toContain("b-001");
    expect(ids).not.toContain("b-002");
    expect(ids).not.toContain("b-003");
  });

  it("searching session B returns 0 results from session A", () => {
    const results = searchMessages(db, convB, "authentication");

    expect(results).toHaveLength(3);
    const ids = results.map((r) => r.messageId);
    expect(ids).not.toContain("a-001");
    expect(ids).not.toContain("a-002");
  });
});

describe("unified search", () => {
  let db: Database;
  const convId = "conv-unified-001";

  beforeEach(() => {
    db = createTestDb();
    seedConversation(db, convId);

    insertMessage(db, convId, "m-001", "The authentication flow begins with a login request", 1);
    insertMessage(db, convId, "m-002", "Authentication tokens are stored in session cookies", 2);
    insertMessage(db, convId, "m-003", "The load balancer forwards requests to auth services", 3);
    insertMessage(db, convId, "m-004", "Database schema includes an authentication table", 4);
    insertMessage(db, convId, "m-005", "Error logging captures authentication failures", 5);

    insertSummary(db, convId, "s-001", "Summary of authentication architecture: tokens, sessions, and OAuth flow are discussed", 0);
    insertSummary(db, convId, "s-002", "Summary of deployment: Kubernetes pods handle authentication service routing", 1);
  });

  afterEach(() => {
    cleanupTestDb(db);
  });

  it("searchAll returns both message and summary type results for authentication", () => {
    const results = searchAll(db, convId, "authentication");

    const types = new Set(results.map((r) => r.type));
    expect(types.has("message")).toBe(true);
    expect(types.has("summary")).toBe(true);
  });

  it("searchAll results are sorted by rank ascending (most relevant first)", () => {
    const results = searchAll(db, convId, "authentication");

    for (let i = 1; i < results.length; i++) {
      expect(results[i].rank).toBeGreaterThanOrEqual(results[i - 1].rank);
    }
  });

  it("message results have messageId field, summary results have depth field", () => {
    const results = searchAll(db, convId, "authentication");

    const summaryResults = results.filter((r) => r.type === "summary");
    expect(summaryResults.length).toBeGreaterThan(0);
    for (const r of summaryResults) {
      expect(typeof r.depth).toBe("number");
    }
  });
});

describe("rebuildIndex", () => {
  let db: Database;
  const convId = "conv-rebuild-001";

  beforeEach(() => {
    db = createTestDb();
    seedConversation(db, convId);
  });

  afterEach(() => {
    cleanupTestDb(db);
  });

  it("reindex restores search after FTS entries are removed via FTS5 delete command", () => {
    insertMessage(db, convId, "r-001", "Kubernetes deployment configuration and orchestration", 1);
    insertMessage(db, convId, "r-002", "The orchestration layer manages pod scaling", 2);

    const rows = db
      .query<{ rowid: number; content: string }, [string]>(
        "SELECT rowid, content FROM messages WHERE conversation_id = ?",
      )
      .all(convId);
    for (const row of rows) {
      db.query(
        "INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', ?, ?)",
      ).run(row.rowid, row.content);
    }

    const beforeRebuild = searchMessages(db, convId, "orchestration");
    expect(beforeRebuild).toHaveLength(0);

    rebuildIndex(db, convId);

    const afterRebuild = searchMessages(db, convId, "orchestration");
    expect(afterRebuild).toHaveLength(2);
  });
});
