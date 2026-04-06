import { describe, expect, it } from "bun:test";
import { mockMessage } from "../helpers";

type SummarizerModule = typeof import("../../src/summarization/summarizer");

async function loadSummarizer(tag: string): Promise<SummarizerModule> {
  return import(`../../src/summarization/summarizer?${tag}`) as Promise<SummarizerModule>;
}

describe("getPromptForDepth", () => {
  it("depth 0 prompt contains key phrases", async () => {
    const { getPromptForDepth } = await loadSummarizer(`depth0-${crypto.randomUUID()}`);
    const prompt = getPromptForDepth(0);
    expect(prompt).toContain("raw conversation messages");
    expect(prompt).toContain("technical decisions");
    expect(prompt).toContain("file paths");
    expect(prompt).toContain("code snippets");
  });

  it("depth 1 prompt mentions condensing", async () => {
    const { getPromptForDepth } = await loadSummarizer(`depth1-${crypto.randomUUID()}`);
    const prompt = getPromptForDepth(1);
    expect(prompt).toContain("condensing multiple summaries");
    expect(prompt).toContain("overarching decisions");
  });

  it("depth 2+ prompt mentions high-level synopsis", async () => {
    const { getPromptForDepth } = await loadSummarizer(`depth2plus-${crypto.randomUUID()}`);
    const prompt2 = getPromptForDepth(2);
    const prompt5 = getPromptForDepth(5);
    expect(prompt2).toContain("high-level project synopsis");
    expect(prompt2).toContain("major milestones");
    expect(prompt5).toContain("high-level project synopsis");
    expect(prompt5).toContain("major milestones");
  });

  it("aggressive mode adds compression instruction", async () => {
    const { getPromptForDepth } = await loadSummarizer(`aggressive-${crypto.randomUUID()}`);
    const aggressivePrompt = getPromptForDepth(0, true);
    const normalPrompt = getPromptForDepth(0, false);
    expect(aggressivePrompt).toContain("40%");
    expect(aggressivePrompt.length).toBeGreaterThan(normalPrompt.length);
  });
});

describe("formatMessagesForSummary", () => {
  it("depth 0 includes role, content, sequence numbers", async () => {
    const { formatMessagesForSummary } = await loadSummarizer(`fmt0-${crypto.randomUUID()}`);
    const messages = [
      mockMessage({ role: "user", content: "Hello world", sequenceNumber: 1 }),
      mockMessage({ role: "assistant", content: "Response text", sequenceNumber: 2 }),
    ];
    const output = formatMessagesForSummary(messages, 0);
    expect(output).toContain("user");
    expect(output).toContain("Hello world");
    expect(output).toContain("#1");
    expect(output).toContain("assistant");
    expect(output).toContain("Response text");
    expect(output).toContain("#2");
  });

  it("depth 1 uses Summary format", async () => {
    const { formatMessagesForSummary } = await loadSummarizer(`fmt1-${crypto.randomUUID()}`);
    const messages = [
      mockMessage({ role: "user", content: "Summary content A", sequenceNumber: 1 }),
      mockMessage({ role: "assistant", content: "Summary content B", sequenceNumber: 2 }),
    ];
    const output = formatMessagesForSummary(messages, 1);
    expect(output).toContain("Summary #1");
    expect(output).toContain("Summary #2");
    expect(output).toContain("Summary content A");
    expect(output).toContain("Summary content B");
  });
});

describe("createSummaryPrompt depth-aware", () => {
  it("uses depth-aware system prompt for depth 0 and depth 1", async () => {
    const { createSummaryPrompt } = await loadSummarizer(`csp-${crypto.randomUUID()}`);
    const messages = [
      mockMessage({ role: "user", content: "First message" }),
      mockMessage({ role: "assistant", content: "Second message" }),
    ];

    const depth0Prompt = createSummaryPrompt(messages, { depth: 0 });
    const depth1Prompt = createSummaryPrompt(messages, { depth: 1 });

    expect(depth0Prompt).toContain("raw conversation messages");
    expect(depth1Prompt).toContain("condensing multiple summaries");
    expect(depth0Prompt).not.toEqual(depth1Prompt);
  });
});
