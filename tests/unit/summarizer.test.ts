import { afterEach, describe, expect, it, mock } from "bun:test";
import { countTokens } from "../../src/utils/tokens";
import { mockConfig, mockMessage } from "../helpers";

afterEach(() => {
  mock.restore();
});

async function loadSummarizerModule() {
  return import("../../src/summarization/summarizer");
}

describe("shouldSummarize threshold", () => {
  it("returns false below both thresholds", async () => {
    const { shouldSummarize } = await loadSummarizerModule();

    expect(
      shouldSummarize(19, 19000, {
        summarizeAfterMessages: 20,
        summarizeAfterTokens: 20000,
      }),
    ).toBe(false);
  });

  it("returns true when message threshold is reached", async () => {
    const { shouldSummarize } = await loadSummarizerModule();

    expect(
      shouldSummarize(20, 15000, {
        summarizeAfterMessages: 20,
        summarizeAfterTokens: 20000,
      }),
    ).toBe(true);
  });

  it("returns true when token threshold is reached", async () => {
    const { shouldSummarize } = await loadSummarizerModule();

    expect(
      shouldSummarize(10, 20000, {
        summarizeAfterMessages: 20,
        summarizeAfterTokens: 20000,
      }),
    ).toBe(true);
  });
});

describe("createSummaryPrompt prompt", () => {
  it("includes all preservation requirements", async () => {
    const { createSummaryPrompt } = await loadSummarizerModule();
    const prompt = createSummaryPrompt(
      [
        mockMessage({ role: "user", content: "Update src/summarization/summarizer.ts and fix error TS2345" }),
        mockMessage({ role: "assistant", content: "Changed function summarize(config, messages, opts) and kept file paths." }),
      ],
      { depth: 0 },
    );

    expect(prompt).toContain("technical decisions");
    expect(prompt).toContain("file paths");
    expect(prompt).toContain("code changes");
    expect(prompt).toContain("error messages");
  });
});

describe("splitIntoChunks chunk", () => {
  it("creates chunks within ±10% budget and starts chunks at user messages when possible", async () => {
    const { splitIntoChunks } = await loadSummarizerModule();

    const messages = [
      mockMessage({ sequenceNumber: 1, role: "user", content: "user boundary alpha ".repeat(55) }),
      mockMessage({ sequenceNumber: 2, role: "assistant", content: "assistant reply alpha ".repeat(40) }),
      mockMessage({ sequenceNumber: 3, role: "user", content: "user boundary beta ".repeat(55) }),
      mockMessage({ sequenceNumber: 4, role: "assistant", content: "assistant reply beta ".repeat(40) }),
      mockMessage({ sequenceNumber: 5, role: "user", content: "user boundary gamma ".repeat(55) }),
      mockMessage({ sequenceNumber: 6, role: "assistant", content: "assistant reply gamma ".repeat(40) }),
    ];

    const targetTokens =
      countTokens(messages[0].content) +
      countTokens(messages[1].content);

    const chunks = splitIntoChunks(messages, targetTokens);

    expect(chunks).toHaveLength(3);

    for (const chunk of chunks) {
      const chunkTokens = chunk.reduce((total, message) => total + countTokens(message.content), 0);
      expect(chunkTokens).toBeGreaterThanOrEqual(targetTokens * 0.9);
      expect(chunkTokens).toBeLessThanOrEqual(targetTokens * 1.1);
    }

    expect(chunks[1][0]?.role).toBe("user");
    expect(chunks[2][0]?.role).toBe("user");
  });
});

describe("summarize and batchSummarize", () => {
  it("uses mocked generateText for single summarization and batching", async () => {
    const generateTextMock = mock(async () => ({
      text: "Condensed summary",
      usage: {
        inputTokens: 123,
        inputTokenDetails: {
          noCacheTokens: 123,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        outputTokens: 45,
        outputTokenDetails: {
          textTokens: 45,
          reasoningTokens: 0,
        },
        totalTokens: 168,
      },
    }));

    mock.module("ai", () => ({
      generateText: generateTextMock,
    }));

    const { batchSummarize, summarize } = await loadSummarizerModule();
    const config = mockConfig();
    const batchA = [mockMessage({ content: "First batch input" })];
    const batchB = [mockMessage({ content: "Second batch input", sequenceNumber: 2 })];

    const single = await summarize(config, batchA, { depth: 1, aggressive: true });
    const batched = await batchSummarize(config, [batchA, batchB]);

    expect(single).toEqual({
      text: "Condensed summary",
      inputTokens: 123,
      outputTokens: 45,
    });
    expect(batched).toHaveLength(2);
    expect(generateTextMock).toHaveBeenCalledTimes(3);
  });
});
