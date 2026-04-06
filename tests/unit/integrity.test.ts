import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { runIntegrityChecks, autoRepair } from "../../src/integrity/checker";
import { linkSummaryToMessages, linkSummaryToParent, storeSummary } from "../../src/summaries/dag-store";
import { cleanupTestDb, createTestDb, seedTestMessages } from "../helpers";

const CONVERSATION_ID = "conv-integrity-001";

function seedConversation(db: Database, conversationId: string): void {
  db.query("INSERT OR IGNORE INTO conversations (id, session_id) VALUES (?, ?)").run(
    conversationId,
    conversationId,
  );
}

function createSummary(
  db: Database,
  conversationId: string,
  depth: number,
  content: string,
  messageIds: string[] = [],
): string {
  const summaryId = storeSummary(db, conversationId, {
    depth,
    content,
    tokenCount: Math.max(1, Math.ceil(content.length / 4)),
    parentIds: [],
    messageIds,
    compactionLevel: "normal",
    conversationId,
  });

  if (messageIds.length > 0) {
    linkSummaryToMessages(db, summaryId, messageIds);
  }

  return summaryId;
}

function getCheckStatus(report: ReturnType<typeof runIntegrityChecks>, name: string): string | undefined {
  return report.checks.find((check) => check.name === name)?.status;
}

describe("integrity checker", () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
    seedConversation(db, CONVERSATION_ID);
  });

  afterEach(() => {
    cleanupTestDb(db);
  });

  it("clean database", () => {
    const messages = seedTestMessages(db, CONVERSATION_ID, 4);
    const leafA = createSummary(
      db,
      CONVERSATION_ID,
      0,
      "Leaf summary A covering messages one and two.",
      [messages[0]!.id, messages[1]!.id],
    );
    const leafB = createSummary(
      db,
      CONVERSATION_ID,
      0,
      "Leaf summary B covering messages three and four.",
      [messages[2]!.id, messages[3]!.id],
    );
    const root = createSummary(db, CONVERSATION_ID, 1, "Root summary combining both leaf summaries.");

    linkSummaryToParent(db, leafA, root);
    linkSummaryToParent(db, leafB, root);

    const report = runIntegrityChecks(db, CONVERSATION_ID);

    expect(report.failed).toBe(0);
    expect(report.warnings).toBe(0);
    expect(report.passed).toBe(8);
    expect(report.checks.every((check) => check.status === "pass")).toBe(true);
  });

  it("detect message gap", () => {
    db.query(
      `INSERT INTO messages (id, conversation_id, role, content, token_count, sequence_number, created_at)
       VALUES (?, ?, 'user', ?, 5, ?, datetime('now'))`,
    ).run("gap-1", CONVERSATION_ID, "message one", 1);
    db.query(
      `INSERT INTO messages (id, conversation_id, role, content, token_count, sequence_number, created_at)
       VALUES (?, ?, 'assistant', ?, 5, ?, datetime('now'))`,
    ).run("gap-2", CONVERSATION_ID, "message two", 2);
    db.query(
      `INSERT INTO messages (id, conversation_id, role, content, token_count, sequence_number, created_at)
       VALUES (?, ?, 'user', ?, 5, ?, datetime('now'))`,
    ).run("gap-4", CONVERSATION_ID, "message four", 4);

    const report = runIntegrityChecks(db, CONVERSATION_ID);

    expect(getCheckStatus(report, "message-ordering")).toBe("fail");
  });

  it("detect DAG cycle", () => {
    const summaryA = createSummary(db, CONVERSATION_ID, 0, "Summary A.");
    const summaryB = createSummary(db, CONVERSATION_ID, 1, "Summary B.");

    linkSummaryToParent(db, summaryA, summaryB);
    linkSummaryToParent(db, summaryB, summaryA);

    const report = runIntegrityChecks(db, CONVERSATION_ID);

    expect(getCheckStatus(report, "dag-acyclicity")).toBe("fail");
  });

  it("detect depth inconsistency", () => {
    const child = createSummary(db, CONVERSATION_ID, 0, "Child summary.");
    const parent = createSummary(db, CONVERSATION_ID, 3, "Parent summary with wrong depth.");

    linkSummaryToParent(db, child, parent);

    const report = runIntegrityChecks(db, CONVERSATION_ID);

    expect(getCheckStatus(report, "depth-consistency")).toBe("fail");
  });

  it("FTS desync detection and repair", () => {
    seedTestMessages(db, CONVERSATION_ID, 3);

    const rows = db
      .query<{ rowid: number; content: string }, [string]>(
        "SELECT rowid, content FROM messages WHERE conversation_id = ?",
      )
      .all(CONVERSATION_ID);

    for (const row of rows) {
      db.query(
        "INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', ?, ?)",
      ).run(row.rowid, row.content);
    }

    const beforeRepair = runIntegrityChecks(db, CONVERSATION_ID);
    expect(getCheckStatus(beforeRepair, "fts-sync")).toBe("fail");

    const actions = autoRepair(db, CONVERSATION_ID, beforeRepair);
    expect(actions).toContain("Rebuilt full-text indexes.");

    const afterRepair = runIntegrityChecks(db, CONVERSATION_ID);
    expect(afterRepair.failed).toBe(0);
    expect(afterRepair.warnings).toBe(0);
    expect(afterRepair.passed).toBe(8);
  });
});
