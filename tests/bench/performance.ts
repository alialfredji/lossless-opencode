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

type PipelineMessage = Parameters<typeof runPipeline>[1][number];

interface BenchMeasurement {
  name: string;
  durations: number[];
}

export interface BenchResult {
  name: string;
  min: number;
  max: number;
  avg: number;
  p95: number;
  unit: string;
}

function roundMs(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function summarizeDurations(name: string, durations: number[]): BenchResult {
  const sortedDurations = [...durations].sort((a, b) => a - b);
  const min = sortedDurations[0] ?? 0;
  const max = sortedDurations[sortedDurations.length - 1] ?? 0;
  const avg =
    sortedDurations.length === 0
      ? 0
      : sortedDurations.reduce((sum, duration) => sum + duration, 0) / sortedDurations.length;
  const p95Index = Math.min(
    sortedDurations.length - 1,
    Math.floor(sortedDurations.length * 0.95),
  );
  const p95 = sortedDurations[p95Index] ?? 0;

  return {
    name,
    min: roundMs(min),
    max: roundMs(max),
    avg: roundMs(avg),
    p95: roundMs(p95),
    unit: "ms",
  };
}

async function runBench(
  name: string,
  fn: () => Promise<void> | void,
  iterations = 100,
): Promise<BenchMeasurement> {
  const durations: number[] = [];

  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await fn();
    const end = performance.now();
    durations.push(end - start);
  }

  return { name, durations };
}

function toBenchResult(measurement: BenchMeasurement): BenchResult {
  return summarizeDurations(measurement.name, measurement.durations);
}

function combineMeasurements(name: string, measurements: BenchMeasurement[]): BenchResult {
  return summarizeDurations(
    name,
    measurements.flatMap((measurement) => measurement.durations),
  );
}

function pad(str: string, width: number, align: "left" | "right" = "left"): string {
  return align === "right" ? str.padStart(width) : str.padEnd(width);
}

function formatNum(value: number): string {
  return value.toFixed(3);
}

export function printBenchmarkTable(results: BenchResult[]): void {
  const colWidths = {
    category: Math.max(8, ...results.map((result) => result.name.length)),
    min: 8,
    max: 8,
    avg: 8,
    p95: 8,
  };

  const border = {
    topLeft: "+",
    topMid: "+",
    topRight: "+",
    midLeft: "+",
    midMid: "+",
    midRight: "+",
    bottomLeft: "+",
    bottomMid: "+",
    bottomRight: "+",
    horizontal: "-",
    vertical: "|",
  };

  const horizontalLine = (left: string, mid: string, right: string): string =>
    [
      left,
      border.horizontal.repeat(colWidths.category + 2),
      mid,
      border.horizontal.repeat(colWidths.min + 2),
      mid,
      border.horizontal.repeat(colWidths.max + 2),
      mid,
      border.horizontal.repeat(colWidths.avg + 2),
      mid,
      border.horizontal.repeat(colWidths.p95 + 2),
      right,
    ].join("");

  const row = (category: string, min: string, max: string, avg: string, p95: string): string =>
    [
      border.vertical,
      ` ${pad(category, colWidths.category)} `,
      border.vertical,
      ` ${pad(min, colWidths.min, "right")} `,
      border.vertical,
      ` ${pad(max, colWidths.max, "right")} `,
      border.vertical,
      ` ${pad(avg, colWidths.avg, "right")} `,
      border.vertical,
      ` ${pad(p95, colWidths.p95, "right")} `,
      border.vertical,
    ].join("");

  process.stdout.write(`${horizontalLine(border.topLeft, border.topMid, border.topRight)}\n`);
  process.stdout.write(
    `${row("Category", "Min (ms)", "Max (ms)", "Avg (ms)", "P95 (ms)")}\n`,
  );
  process.stdout.write(`${horizontalLine(border.midLeft, border.midMid, border.midRight)}\n`);

  for (const result of results) {
    process.stdout.write(
      `${row(
        result.name,
        formatNum(result.min),
        formatNum(result.max),
        formatNum(result.avg),
        formatNum(result.p95),
      )}\n`,
    );
  }

  process.stdout.write(
    `${horizontalLine(border.bottomLeft, border.bottomMid, border.bottomRight)}\n`,
  );
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

function seedConversation(db: ReturnType<typeof createTestDb>, conversationId: string, sessionId: string): void {
  db.query("INSERT OR IGNORE INTO conversations (id, session_id) VALUES (?, ?)").run(
    conversationId,
    sessionId,
  );
}

function seedDagSummaries(db: ReturnType<typeof createTestDb>, conversationId: string): void {
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
}

async function benchMessagePersistence(): Promise<BenchResult> {
  const db = createTestDb();
  const conversationId = crypto.randomUUID();
  const sessionId = `session-${conversationId}`;

  seedConversation(db, conversationId, sessionId);

  let msgIndex = 0;

  try {
    const measurement = await runBench(
      "Message Persistence",
      () => {
        const msg = makeLcmMessage(msgIndex++, conversationId, sessionId);
        persistMessage(db, conversationId, msg);
      },
      100,
    );

    return toBenchResult(measurement);
  } finally {
    db.close();
  }
}

async function benchDagQuery(): Promise<BenchResult> {
  const db = createTestDb();
  const conversationId = crypto.randomUUID();
  const sessionId = `session-${conversationId}`;

  seedConversation(db, conversationId, sessionId);
  seedDagSummaries(db, conversationId);

  try {
    const measurements = await Promise.all([
      runBench("DAG Leaf Query", () => {
        getLeafSummaries(db, conversationId);
      }),
      runBench("DAG Root Query", () => {
        getRootSummaries(db, conversationId);
      }),
      runBench("DAG Tree Query", () => {
        getSummaryTree(db, conversationId);
      }),
    ]);

    return combineMeasurements("DAG Query", measurements);
  } finally {
    db.close();
  }
}

async function benchFtsSearch(): Promise<BenchResult> {
  const db = createTestDb();
  const conversationId = crypto.randomUUID();
  const sessionId = `session-${conversationId}`;

  seedConversation(db, conversationId, sessionId);

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

  try {
    const measurement = await runBench(
      "FTS Search",
      () => {
        searchAll(db, conversationId, "TypeScript", { limit: 10 });
      },
      100,
    );

    return toBenchResult(measurement);
  } finally {
    db.close();
  }
}

async function benchContextAssembly(): Promise<BenchResult> {
  const db = createTestDb();
  const conversationId = crypto.randomUUID();
  const sessionId = `session-${conversationId}`;

  seedConversation(db, conversationId, sessionId);

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

  try {
    const measurement = await runBench(
      "Context Assembly",
      () => {
        assembleContext(db, config, conversationId);
      },
      100,
    );

    return toBenchResult(measurement);
  } finally {
    db.close();
  }
}

async function benchFullPipeline(): Promise<BenchResult> {
  globalThis.__lcm_bench_mock = true;

  const db = createTestDb();
  const conversationId = crypto.randomUUID();
  const sessionId = `session-${conversationId}`;

  const state = createSessionState({
    ...DEFAULT_CONFIG,
    dbPath: ":memory:",
    summarizeAfterMessages: 1000,
    summarizeAfterTokens: 9999999,
    enableFts: false,
  });
  state.db = db;
  state.sessionId = sessionId;

  seedConversation(db, conversationId, sessionId);

  function makeTransformMessages(count: number): PipelineMessage[] {
    const messages: PipelineMessage[] = [];

    for (let i = 0; i < count; i++) {
      const id = crypto.randomUUID();
      const parts: PipelineMessage["parts"] = [
        {
          id: crypto.randomUUID(),
          sessionID: sessionId,
          messageID: id,
          type: "text",
          text: `Pipeline bench message ${i}: testing full pipeline latency with realistic message content.`,
        },
      ];

      if (i % 2 === 0) {
        messages.push({
          info: {
            id,
            sessionID: sessionId,
            role: "user",
            time: { created: Date.now() - (count - i) * 1000 },
            agent: "benchmark",
            model: { providerID: "anthropic", modelID: "claude-3-5-sonnet-20241022" },
          },
          parts,
        });
        continue;
      }

      messages.push({
        info: {
          id,
          sessionID: sessionId,
          role: "assistant",
          time: { created: Date.now() - (count - i) * 1000, completed: Date.now() },
          parentID: i > 0 ? messages[i - 1]!.info.id : crypto.randomUUID(),
          modelID: "claude-3-5-sonnet-20241022",
          providerID: "anthropic",
          mode: "default",
          path: { cwd: "/tmp", root: "/tmp" },
          summary: false,
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts,
      });
    }

    return messages;
  }

  try {
    const warmupMessages = makeTransformMessages(5);
    await runPipeline(state, warmupMessages);

    const measurement = await runBench(
      "Full Pipeline",
      async () => {
        const messages = makeTransformMessages(10);

        for (const message of messages) {
          message.info.id = crypto.randomUUID();
          message.parts[0]!.messageID = message.info.id;
          message.parts[0]!.id = crypto.randomUUID();
        }

        await runPipeline(state, messages);
      },
      20,
    );

    return toBenchResult(measurement);
  } finally {
    globalThis.__lcm_bench_mock = undefined;
    db.close();
  }
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

async function benchTokenCounting(): Promise<BenchResult> {
  const cases = [
    { name: "Token Counting (10K chars)", text: makeRealisticText(10_000), iterations: 50 },
    { name: "Token Counting (50K chars)", text: makeRealisticText(50_000), iterations: 20 },
    { name: "Token Counting (100K chars)", text: makeRealisticText(100_000), iterations: 10 },
  ];

  for (const benchCase of cases) {
    countTokens(benchCase.text);
  }

  const measurements: BenchMeasurement[] = [];

  for (const benchCase of cases) {
    measurements.push(
      await runBench(
        benchCase.name,
        () => {
          countTokens(benchCase.text);
        },
        benchCase.iterations,
      ),
    );
  }

  return combineMeasurements("Token Counting", measurements);
}

export async function runAllBenchmarks(): Promise<BenchResult[]> {
  process.stdout.write("Running benchmarks...\n\n");

  const benches = [
    { name: "Message Persistence", fn: benchMessagePersistence },
    { name: "DAG Query", fn: benchDagQuery },
    { name: "FTS Search", fn: benchFtsSearch },
    { name: "Context Assembly", fn: benchContextAssembly },
    { name: "Full Pipeline", fn: benchFullPipeline },
    { name: "Token Counting", fn: benchTokenCounting },
  ];

  const results: BenchResult[] = [];

  for (const bench of benches) {
    process.stdout.write(`  Running: ${bench.name}...\n`);
    results.push(await bench.fn());
  }

  return results;
}

async function main(): Promise<void> {
  const startTime = performance.now();
  const results = await runAllBenchmarks();
  const totalMs = performance.now() - startTime;

  process.stdout.write("\n");
  printBenchmarkTable(results);
  process.stdout.write(`\nTotal runtime: ${(totalMs / 1000).toFixed(2)}s\n`);
}

if (import.meta.main) {
  await main();
}
