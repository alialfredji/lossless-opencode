import { createTestDb } from "../helpers/db";
import { persistMessage } from "../../src/messages/persistence";
import {
  storeSummary,
  getLeafSummaries,
  getRootSummaries,
  getSummaryTree,
} from "../../src/summaries/dag-store";
import { indexMessage, searchAll } from "../../src/search/indexer";
import { assembleContext } from "../../src/context/assembler";
import { countTokens } from "../../src/utils/tokens";
import { runPipeline } from "../../src/pipeline";
import { createSessionState } from "../../src/index";
import type { LcmMessage } from "../../src/types";
import { DEFAULT_CONFIG } from "../../src/types";

declare global {
  var __lcm_bench_mock: boolean | undefined;
}

export interface BenchResult {
  name: string;
  min: number;
  max: number;
  avg: number;
  p95: number;
  unit: string;
}

async function runBench(
  name: string,
  fn: () => Promise<void> | void,
  iterations = 100,
): Promise<BenchResult> {
  const durations: number[] = [];

  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await fn();
    const end = performance.now();
    durations.push(end - start);
  }

  durations.sort((a, b) => a - b);

  const min = durations[0]!;
  const max = durations[durations.length - 1]!;
  const avg = durations.reduce((sum, d) => sum + d, 0) / durations.length;
  const p95Index = Math.floor(durations.length * 0.95);
  const p95 = durations[p95Index]!;

  return {
    name,
    min: Math.round(min * 1000) / 1000,
    max: Math.round(max * 1000) / 1000,
    avg: Math.round(avg * 1000) / 1000,
    p95: Math.round(p95 * 1000) / 1000,
    unit: "ms",
  };
}

function makeLcmMessage(
  index: number,
  conversationId: string,
  sessionId: string,
): LcmMessage {
  const role = index % 2 === 0 ? "user" : ("assistant" as const);
  const content = `Benchmark message ${index}: This is a realistic message content for benchmarking purposes. It contains enough text to be representative of real conversations.`;
  return {
    id: crypto.randomUUID(),
    role,
    content,
    timestamp: new Date(Date.now() + index * 1000).toISOString(),
    sessionId,
    tokenCount: Math.max(8, Math.ceil(content.length / 4)),
    summarized: false,
    sequenceNumber: index + 1,
    conversationId,
  };
}

// Benchmark 1: Message Persistence Throughput
async function benchMessagePersistence(): Promise<BenchResult> {
  const db = createTestDb();
  const conversationId = crypto.randomUUID();
  const sessionId = `session-${conversationId}`;

  db.query("INSERT OR IGNORE INTO conversations (id, session_id) VALUES (?, ?)").run(
    conversationId,
    sessionId,
  );

  let msgIndex = 0;

  const result = await runBench(
    "Message Persistence",
    () => {
      const msg = makeLcmMessage(msgIndex++, conversationId, sessionId);
      persistMessage(db, conversationId, msg);
    },
    100,
  );

  db.close();
  return result;
}

// Benchmark 2a: DAG Leaf Query
async function benchDagLeafQuery(): Promise<BenchResult> {
  const db = createTestDb();
  const conversationId = crypto.randomUUID();
  const sessionId = `session-${conversationId}`;

  db.query("INSERT OR IGNORE INTO conversations (id, session_id) VALUES (?, ?)").run(
    conversationId,
    sessionId,
  );

  // Seed 50 summaries across 3 depths
  const depth0Ids: string[] = [];
  for (let i = 0; i < 20; i++) {
    const id = storeSummary(db, conversationId, {
      depth: 0,
      content: `Leaf summary ${i}: detailed message batch summary covering messages about TypeScript, async patterns, and state management.`,
      tokenCount: 40,
      parentIds: [],
      messageIds: [],
      compactionLevel: "normal",
      conversationId,
    });
    depth0Ids.push(id);
  }

  const depth1Ids: string[] = [];
  for (let i = 0; i < 20; i++) {
    const id = storeSummary(db, conversationId, {
      depth: 1,
      content: `Mid-level summary ${i}: condensed view of multiple leaf summaries covering core topics.`,
      tokenCount: 60,
      parentIds: [depth0Ids[i % depth0Ids.length]!],
      messageIds: [],
      compactionLevel: "normal",
      conversationId,
    });
    depth1Ids.push(id);
  }

  for (let i = 0; i < 10; i++) {
    storeSummary(db, conversationId, {
      depth: 2,
      content: `Root summary ${i}: high-level synopsis of entire conversation arc.`,
      tokenCount: 80,
      parentIds: [depth1Ids[i % depth1Ids.length]!],
      messageIds: [],
      compactionLevel: "normal",
      conversationId,
    });
  }

  const result = await runBench(
    "DAG Leaf Query",
    () => {
      getLeafSummaries(db, conversationId);
    },
    100,
  );

  db.close();
  return result;
}

// Benchmark 2b: DAG Root Query
async function benchDagRootQuery(): Promise<BenchResult> {
  const db = createTestDb();
  const conversationId = crypto.randomUUID();
  const sessionId = `session-${conversationId}`;

  db.query("INSERT OR IGNORE INTO conversations (id, session_id) VALUES (?, ?)").run(
    conversationId,
    sessionId,
  );

  const depth0Ids: string[] = [];
  for (let i = 0; i < 20; i++) {
    const id = storeSummary(db, conversationId, {
      depth: 0,
      content: `Leaf summary ${i}: detailed batch summary.`,
      tokenCount: 40,
      parentIds: [],
      messageIds: [],
      compactionLevel: "normal",
      conversationId,
    });
    depth0Ids.push(id);
  }

  const depth1Ids: string[] = [];
  for (let i = 0; i < 20; i++) {
    const id = storeSummary(db, conversationId, {
      depth: 1,
      content: `Mid summary ${i}: condensed view.`,
      tokenCount: 60,
      parentIds: [depth0Ids[i % depth0Ids.length]!],
      messageIds: [],
      compactionLevel: "normal",
      conversationId,
    });
    depth1Ids.push(id);
  }

  for (let i = 0; i < 10; i++) {
    storeSummary(db, conversationId, {
      depth: 2,
      content: `Root summary ${i}: high-level synopsis.`,
      tokenCount: 80,
      parentIds: [depth1Ids[i % depth1Ids.length]!],
      messageIds: [],
      compactionLevel: "normal",
      conversationId,
    });
  }

  const result = await runBench(
    "DAG Root Query",
    () => {
      getRootSummaries(db, conversationId);
    },
    100,
  );

  db.close();
  return result;
}

// Benchmark 2c: DAG Tree Query
async function benchDagTreeQuery(): Promise<BenchResult> {
  const db = createTestDb();
  const conversationId = crypto.randomUUID();
  const sessionId = `session-${conversationId}`;

  db.query("INSERT OR IGNORE INTO conversations (id, session_id) VALUES (?, ?)").run(
    conversationId,
    sessionId,
  );

  const depth0Ids: string[] = [];
  for (let i = 0; i < 20; i++) {
    const id = storeSummary(db, conversationId, {
      depth: 0,
      content: `Leaf summary ${i}: detailed batch summary.`,
      tokenCount: 40,
      parentIds: [],
      messageIds: [],
      compactionLevel: "normal",
      conversationId,
    });
    depth0Ids.push(id);
  }

  const depth1Ids: string[] = [];
  for (let i = 0; i < 20; i++) {
    const id = storeSummary(db, conversationId, {
      depth: 1,
      content: `Mid summary ${i}: condensed view.`,
      tokenCount: 60,
      parentIds: [depth0Ids[i % depth0Ids.length]!],
      messageIds: [],
      compactionLevel: "normal",
      conversationId,
    });
    depth1Ids.push(id);
  }

  for (let i = 0; i < 10; i++) {
    storeSummary(db, conversationId, {
      depth: 2,
      content: `Root summary ${i}: high-level synopsis.`,
      tokenCount: 80,
      parentIds: [depth1Ids[i % depth1Ids.length]!],
      messageIds: [],
      compactionLevel: "normal",
      conversationId,
    });
  }

  const result = await runBench(
    "DAG Tree Query",
    () => {
      getSummaryTree(db, conversationId);
    },
    100,
  );

  db.close();
  return result;
}

// Benchmark 3: FTS Search Latency
async function benchFtsSearch(): Promise<BenchResult> {
  const db = createTestDb();
  const conversationId = crypto.randomUUID();
  const sessionId = `session-${conversationId}`;

  db.query("INSERT OR IGNORE INTO conversations (id, session_id) VALUES (?, ?)").run(
    conversationId,
    sessionId,
  );

  // Index 200 messages
  const topics = [
    "TypeScript async patterns and promise handling",
    "database migration strategies for SQLite",
    "context window management in large language models",
    "DAG-based hierarchical summarization techniques",
    "performance optimization in Bun runtime",
  ];

  for (let i = 0; i < 200; i++) {
    const msgId = crypto.randomUUID();
    const content = `Message ${i}: ${topics[i % topics.length]} — detailed analysis and implementation notes`;

    db.query(
      `INSERT INTO messages (id, conversation_id, role, content, token_count, sequence_number, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(msgId, conversationId, "user", content, 20, i + 1, new Date().toISOString());

    indexMessage(db, msgId, content, conversationId);
  }

  const result = await runBench(
    "FTS Search (200 msgs)",
    () => {
      searchAll(db, conversationId, "TypeScript", { limit: 10 });
    },
    100,
  );

  db.close();
  return result;
}

// Benchmark 4: Context Assembly Time
async function benchContextAssembly(): Promise<BenchResult> {
  const db = createTestDb();
  const conversationId = crypto.randomUUID();
  const sessionId = `session-${conversationId}`;

  db.query("INSERT OR IGNORE INTO conversations (id, session_id) VALUES (?, ?)").run(
    conversationId,
    sessionId,
  );

  // Seed messages and summaries
  for (let i = 0; i < 20; i++) {
    const msgId = crypto.randomUUID();
    const content = `Message ${i}: context assembly benchmark content with realistic text length for token counting purposes.`;
    db.query(
      `INSERT INTO messages (id, conversation_id, role, content, token_count, sequence_number, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(msgId, conversationId, i % 2 === 0 ? "user" : "assistant", content, 20, i + 1, new Date().toISOString());
  }

  for (let i = 0; i < 10; i++) {
    storeSummary(db, conversationId, {
      depth: 0,
      content: `Summary ${i}: condensed batch summary of messages ${i * 2} and ${i * 2 + 1}.`,
      tokenCount: 30,
      parentIds: [],
      messageIds: [],
      compactionLevel: "normal",
      conversationId,
    });
  }

  const config = { ...DEFAULT_CONFIG, maxContextTokens: 4000 };

  const result = await runBench(
    "Context Assembly",
    () => {
      assembleContext(db, config, conversationId);
    },
    100,
  );

  db.close();
  return result;
}

// Benchmark 5: Full Pipeline Latency (mocked LLM)
async function benchFullPipeline(): Promise<BenchResult> {
  // Mock the AI module to avoid real LLM calls
  globalThis.__lcm_bench_mock = true;

  const db = createTestDb();
  const conversationId = crypto.randomUUID();
  const sessionId = `session-${conversationId}`;

  const state = createSessionState({
    ...DEFAULT_CONFIG,
    dbPath: ":memory:",
    summarizeAfterMessages: 1000, // prevent actual compaction
    summarizeAfterTokens: 9999999,
    enableFts: false,
  });
  state.db = db;
  state.sessionId = sessionId;

  db.query("INSERT OR IGNORE INTO conversations (id, session_id) VALUES (?, ?)").run(
    conversationId,
    sessionId,
  );

  // Build 10 mock TransformMessages
  function makeTransformMessages(count: number) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const msgs: any[] = [];
    for (let i = 0; i < count; i++) {
      const id = crypto.randomUUID();
      msgs.push({
        info: {
          id,
          sessionID: sessionId,
          role: i % 2 === 0 ? "user" : "assistant",
          time: { created: Date.now() - (count - i) * 1000, completed: Date.now() },
          parentID: i > 0 ? msgs[i - 1]!.info.id : crypto.randomUUID(),
          modelID: "claude-3-5-sonnet-20241022",
          providerID: "anthropic",
          mode: "default",
          path: { cwd: "/tmp", root: "/tmp" },
          summary: false,
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          model: { providerID: "anthropic", modelID: "claude-3-5-sonnet-20241022" },
        },
        parts: [
          {
            id: crypto.randomUUID(),
            sessionID: sessionId,
            messageID: id,
            type: "text" as const,
            text: `Pipeline bench message ${i}: testing full pipeline latency with realistic message content.`,
          },
        ],
      });
    }
    return msgs;
  }

  // Pre-warm by running once
  const warmupMsgs = makeTransformMessages(5);
  await runPipeline(state, warmupMsgs);

  let callCount = 0;
  const result = await runBench(
    "Full Pipeline (10 msgs)",
    async () => {
      // Each iteration creates a fresh batch of new messages (new UUIDs each time)
      const msgs = makeTransformMessages(10);
      // Assign unique IDs on each call so pipeline persists them
      for (const m of msgs) {
        m.info.id = crypto.randomUUID();
        m.parts[0].messageID = m.info.id;
        m.parts[0].id = crypto.randomUUID();
      }
      callCount++;
      await runPipeline(state, msgs);
    },
    20, // fewer iterations since pipeline does more work
  );

  db.close();
  return result;
}

function makeRealisticText(targetChars: number): string {
  const words =
    "the quick brown fox jumps over the lazy dog TypeScript async await function class interface export import const let var return promise resolve reject error catch finally try ";
  let result = "";
  while (result.length < targetChars) {
    result += words;
  }
  return result.slice(0, targetChars);
}

async function benchTokenCounting10K(): Promise<BenchResult> {
  const text = makeRealisticText(10_000);
  countTokens(text);

  return await runBench(
    "Token Counting (10K chars)",
    () => {
      countTokens(text);
    },
    50,
  );
}

async function benchTokenCounting50K(): Promise<BenchResult> {
  const text = makeRealisticText(50_000);
  countTokens(text);

  return await runBench(
    "Token Counting (50K chars)",
    () => {
      countTokens(text);
    },
    20,
  );
}

async function benchTokenCounting100K(): Promise<BenchResult> {
  const text = makeRealisticText(100_000);
  countTokens(text);

  return await runBench(
    "Token Counting (100K chars)",
    () => {
      countTokens(text);
    },
    10,
  );
}

export async function runAllBenchmarks(): Promise<BenchResult[]> {
  const results: BenchResult[] = [];

  process.stdout.write("Running benchmarks...\n\n");

  const benches = [
    { name: "Message Persistence", fn: benchMessagePersistence },
    { name: "DAG Leaf Query", fn: benchDagLeafQuery },
    { name: "DAG Root Query", fn: benchDagRootQuery },
    { name: "DAG Tree Query", fn: benchDagTreeQuery },
    { name: "FTS Search", fn: benchFtsSearch },
    { name: "Context Assembly", fn: benchContextAssembly },
    { name: "Full Pipeline", fn: benchFullPipeline },
    { name: "Token Counting 10K", fn: benchTokenCounting10K },
    { name: "Token Counting 50K", fn: benchTokenCounting50K },
    { name: "Token Counting 100K", fn: benchTokenCounting100K },
  ];

  for (const bench of benches) {
    process.stdout.write(`  Running: ${bench.name}...\n`);
    const result = await bench.fn();
    results.push(result);
  }

  return results;
}
