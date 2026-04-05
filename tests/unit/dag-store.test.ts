import { describe, expect, it, beforeEach } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  storeSummary,
  linkSummaryToMessages,
  linkSummaryToParent,
  getSummariesAtDepth,
  getLeafSummaries,
  getRootSummaries,
  getSummaryTree,
  getMessagesForSummary,
} from "../../src/summaries/dag-store";
import { createTestDb, seedTestMessages, cleanupTestDb } from "../helpers";

describe("simple DAG", () => {
  let db: Database;
  const conversationId = "conv-dag-test";

  beforeEach(() => {
    db = createTestDb();
    db.query("INSERT OR IGNORE INTO conversations (id, session_id) VALUES (?, ?)").run(
      conversationId,
      "session-dag-test",
    );
    const msgs = seedTestMessages(db, conversationId, 9);
    const msgIds = msgs.map((m) => m.id);

    const leaf1 = storeSummary(db, conversationId, {
      depth: 0,
      content: "Leaf summary 1",
      tokenCount: 10,
      compactionLevel: "normal",
      conversationId,
      parentIds: [],
      messageIds: [],
    });
    linkSummaryToMessages(db, leaf1, msgIds.slice(0, 3));

    const leaf2 = storeSummary(db, conversationId, {
      depth: 0,
      content: "Leaf summary 2",
      tokenCount: 10,
      compactionLevel: "normal",
      conversationId,
      parentIds: [],
      messageIds: [],
    });
    linkSummaryToMessages(db, leaf2, msgIds.slice(3, 6));

    const leaf3 = storeSummary(db, conversationId, {
      depth: 0,
      content: "Leaf summary 3",
      tokenCount: 10,
      compactionLevel: "normal",
      conversationId,
      parentIds: [],
      messageIds: [],
    });
    linkSummaryToMessages(db, leaf3, msgIds.slice(6, 9));

    const parent = storeSummary(db, conversationId, {
      depth: 1,
      content: "Parent summary condensing all 3 leaves",
      tokenCount: 20,
      compactionLevel: "normal",
      conversationId,
      parentIds: [],
      messageIds: [],
    });

    linkSummaryToParent(db, leaf1, parent);
    linkSummaryToParent(db, leaf2, parent);
    linkSummaryToParent(db, leaf3, parent);
  });

  it("getSummariesAtDepth returns 3 summaries at depth 0", () => {
    const leaves = getSummariesAtDepth(db, conversationId, 0);
    expect(leaves).toHaveLength(3);
    for (const s of leaves) {
      expect(s.depth).toBe(0);
    }
  });

  it("getSummariesAtDepth returns 1 summary at depth 1", () => {
    const parents = getSummariesAtDepth(db, conversationId, 1);
    expect(parents).toHaveLength(1);
    expect(parents[0].depth).toBe(1);
  });

  it("getLeafSummaries returns 0 (all condensed into parent)", () => {
    const leaves = getLeafSummaries(db, conversationId);
    expect(leaves).toHaveLength(0);
  });

  it("getRootSummaries returns 1 (the parent)", () => {
    const roots = getRootSummaries(db, conversationId);
    expect(roots).toHaveLength(1);
    expect(roots[0].depth).toBe(1);
  });

  it("getSummaryTree returns 1 root node with 3 children", () => {
    const tree = getSummaryTree(db, conversationId);
    expect(tree).toHaveLength(1);
    expect(tree[0].summary.depth).toBe(1);
    expect(tree[0].children).toHaveLength(3);
    for (const child of tree[0].children) {
      expect(child.summary.depth).toBe(0);
      expect(child.children).toHaveLength(0);
    }
  });

  it("getSummaryTree root node depth equals summary depth", () => {
    const tree = getSummaryTree(db, conversationId);
    expect(tree[0].depth).toBe(1);
  });

  it("storeSummary returns a valid UUID string", () => {
    const id = storeSummary(db, conversationId, {
      depth: 0,
      content: "Extra leaf",
      tokenCount: 5,
      compactionLevel: "normal",
      conversationId,
      parentIds: [],
      messageIds: [],
    });
    expect(typeof id).toBe("string");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

describe("simple DAG - before parent linkage", () => {
  let db: Database;
  const conversationId = "conv-before-parent";

  beforeEach(() => {
    db = createTestDb();
    db.query("INSERT OR IGNORE INTO conversations (id, session_id) VALUES (?, ?)").run(
      conversationId,
      "session-before-parent",
    );
    seedTestMessages(db, conversationId, 3);

    storeSummary(db, conversationId, {
      depth: 0,
      content: "Leaf A",
      tokenCount: 8,
      compactionLevel: "normal",
      conversationId,
      parentIds: [],
      messageIds: [],
    });
    storeSummary(db, conversationId, {
      depth: 0,
      content: "Leaf B",
      tokenCount: 8,
      compactionLevel: "normal",
      conversationId,
      parentIds: [],
      messageIds: [],
    });
    storeSummary(db, conversationId, {
      depth: 0,
      content: "Leaf C",
      tokenCount: 8,
      compactionLevel: "normal",
      conversationId,
      parentIds: [],
      messageIds: [],
    });
  });

  it("getLeafSummaries returns 3 before condensation", () => {
    const leaves = getLeafSummaries(db, conversationId);
    expect(leaves).toHaveLength(3);
  });

  it("getRootSummaries returns 3 before condensation", () => {
    const roots = getRootSummaries(db, conversationId);
    expect(roots).toHaveLength(3);
  });
});

describe("message linkage", () => {
  let db: Database;
  const conversationId = "conv-msg-linkage";

  beforeEach(() => {
    db = createTestDb();
    db.query("INSERT OR IGNORE INTO conversations (id, session_id) VALUES (?, ?)").run(
      conversationId,
      "session-msg-linkage",
    );
  });

  it("getMessagesForSummary returns exact 3 message IDs", () => {
    const msgs = seedTestMessages(db, conversationId, 3);
    const msgIds = msgs.map((m) => m.id);

    const summaryId = storeSummary(db, conversationId, {
      depth: 0,
      content: "Summary covering 3 messages",
      tokenCount: 15,
      compactionLevel: "normal",
      conversationId,
      parentIds: [],
      messageIds: [],
    });

    linkSummaryToMessages(db, summaryId, msgIds);

    const result = getMessagesForSummary(db, summaryId);
    expect(result).toHaveLength(3);
    expect(result.sort()).toEqual(msgIds.sort());
  });

  it("getMessagesForSummary returns empty array for summary with no linked messages", () => {
    const summaryId = storeSummary(db, conversationId, {
      depth: 0,
      content: "Unlinked summary",
      tokenCount: 5,
      compactionLevel: "normal",
      conversationId,
      parentIds: [],
      messageIds: [],
    });

    const result = getMessagesForSummary(db, summaryId);
    expect(result).toHaveLength(0);
  });

  it("linkSummaryToMessages is a no-op for empty array", () => {
    const summaryId = storeSummary(db, conversationId, {
      depth: 0,
      content: "No messages",
      tokenCount: 3,
      compactionLevel: "normal",
      conversationId,
      parentIds: [],
      messageIds: [],
    });

    linkSummaryToMessages(db, summaryId, []);
    const result = getMessagesForSummary(db, summaryId);
    expect(result).toHaveLength(0);
  });
});

describe("message linkage - parentIds loaded correctly", () => {
  let db: Database;
  const conversationId = "conv-parent-ids";

  beforeEach(() => {
    db = createTestDb();
    db.query("INSERT OR IGNORE INTO conversations (id, session_id) VALUES (?, ?)").run(
      conversationId,
      "session-parent-ids",
    );
  });

  it("loaded summary has parentIds populated after linkSummaryToParent", () => {
    const childId = storeSummary(db, conversationId, {
      depth: 0,
      content: "Child",
      tokenCount: 5,
      compactionLevel: "normal",
      conversationId,
      parentIds: [],
      messageIds: [],
    });

    const parentId = storeSummary(db, conversationId, {
      depth: 1,
      content: "Parent",
      tokenCount: 8,
      compactionLevel: "normal",
      conversationId,
      parentIds: [],
      messageIds: [],
    });

    linkSummaryToParent(db, childId, parentId);

    const childSummaries = getSummariesAtDepth(db, conversationId, 0);
    expect(childSummaries[0].parentIds).toEqual([parentId]);
  });
});
