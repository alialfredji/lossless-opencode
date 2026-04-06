import { describe, it, expect, beforeEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { createTestDb, cleanupTestDb, seedTestMessages } from "../../helpers/db";
import { lcmGrep } from "../../../src/tools/lcm-grep";
import { DEFAULT_CONFIG } from "../../../src/types";
import type { HookSessionState } from "../../../src/index";
import { createGrepToolDefinition } from "../../../src/tools/lcm-grep";

const CONVERSATION_ID = "test-conv-grep";

function insertSummary(db: Database, conversationId: string, content: string, depth = 1): string {
  const id = crypto.randomUUID();
  db.query(
    `INSERT INTO summaries (id, conversation_id, depth, content, token_count, created_at, compaction_level)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, conversationId, depth, content, 20, new Date().toISOString(), "normal");
  return id;
}

describe("lcmGrep", () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it("search returns formatted results", () => {
    seedTestMessages(db, CONVERSATION_ID, 5);

    const result = lcmGrep(db, CONVERSATION_ID, "TypeScript workflow");

    expect(result).toContain("[Message #");
    expect(result).toContain("user");
  });

  it("respects limit parameter", () => {
    seedTestMessages(db, CONVERSATION_ID, 20);

    const result = lcmGrep(db, CONVERSATION_ID, "TypeScript", { limit: 3 });

    const headerMatches = result.match(/\[Message #/g) ?? [];
    expect(headerMatches.length).toBeLessThanOrEqual(3);
  });

  it("handles no results gracefully", () => {
    seedTestMessages(db, CONVERSATION_ID, 5);

    const result = lcmGrep(db, CONVERSATION_ID, "xyznonexistent12345");

    expect(result).toBe("No results found for 'xyznonexistent12345'. Try different search terms.");
  });

  it('type filter "messages" only searches messages', () => {
    seedTestMessages(db, CONVERSATION_ID, 3);
    insertSummary(db, CONVERSATION_ID, "The turbofish syntax is unique to Rust not TypeScript");

    const result = lcmGrep(db, CONVERSATION_ID, "TypeScript", { type: "messages" });

    expect(result).toContain("[Message #");
    expect(result).not.toContain("[Summary");
  });

  it("empty query returns error", () => {
    const result = lcmGrep(db, CONVERSATION_ID, "");
    expect(result).toBe("Error: query cannot be empty");
  });

  it("whitespace-only query returns error", () => {
    const result = lcmGrep(db, CONVERSATION_ID, "   ");
    expect(result).toBe("Error: query cannot be empty");
  });

  it('type filter "summaries" only searches summaries', () => {
    seedTestMessages(db, CONVERSATION_ID, 3);
    insertSummary(db, CONVERSATION_ID, "The turbofish syntax is unique to Rust not TypeScript");

    const result = lcmGrep(db, CONVERSATION_ID, "turbofish", { type: "summaries" });

    expect(result).toContain("[Summary");
    expect(result).not.toContain("[Message #");
  });
});

describe("createGrepToolDefinition", () => {
  it("returns LCM not initialized when db is null", async () => {
    const state: HookSessionState = {
      sessionId: null,
      db: null,
      config: { ...DEFAULT_CONFIG },
      isCompacting: false,
    };
    const def = createGrepToolDefinition(state);
    const result = await def.execute({ query: "test" }, {} as never);
    expect(result).toBe("LCM not initialized yet");
  });

  it("returns LCM not initialized when sessionId is null", async () => {
    const db = createTestDb();
    const state: HookSessionState = {
      sessionId: null,
      db,
      config: { ...DEFAULT_CONFIG },
      isCompacting: false,
    };
    const def = createGrepToolDefinition(state);
    const result = await def.execute({ query: "test" }, {} as never);
    expect(result).toBe("LCM not initialized yet");
    cleanupTestDb(db);
  });

  it("delegates to lcmGrep when initialized", async () => {
    const db = createTestDb();
    seedTestMessages(db, CONVERSATION_ID, 3);
    const state: HookSessionState = {
      sessionId: CONVERSATION_ID,
      db,
      config: { ...DEFAULT_CONFIG },
      isCompacting: false,
    };
    const def = createGrepToolDefinition(state);
    const result = await def.execute({ query: "TypeScript" }, {} as never);
    expect(typeof result).toBe("string");
    cleanupTestDb(db);
  });
});
