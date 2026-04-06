import * as ai from "ai";
import type { LcmConfig, LcmMessage } from "../types";
import { countTokens, estimateTokens } from "../utils/tokens";

const SUMMARIZER_SYSTEM_PROMPT = [
  "You are a lossless technical summarizer for engineering conversations.",
  "Produce dense, factual summaries that preserve implementation-critical detail.",
  "Do not invent details. If something was uncertain, mark it as uncertain.",
].join(" ");

type SummaryOptions = {
  depth: number;
  aggressive?: boolean;
};

type SummaryResult = {
  text: string;
  inputTokens: number;
  outputTokens: number;
};

function formatMessage(message: LcmMessage): string {
  return [
    `Message ID: ${message.id}`,
    `Role: ${message.role}`,
    `Timestamp: ${message.timestamp}`,
    `Sequence: ${message.sequenceNumber}`,
    `Conversation: ${message.conversationId}`,
    `Content:`,
    message.content,
  ].join("\n");
}

function getMessageTokenCount(message: LcmMessage): number {
  return Math.max(1, countTokens(message.content));
}

function findBoundaryIndex(messages: LcmMessage[], targetTokens: number, upperBound: number): number {
  const prefixTokens: number[] = [];
  let runningTotal = 0;

  for (const message of messages) {
    runningTotal += getMessageTokenCount(message);
    prefixTokens.push(runningTotal);
  }

  const userBoundaries = messages
    .map((message, index) => ({ message, index }))
    .filter(({ message, index }) => index > 0 && message.role === "user")
    .map(({ index }) => index);

  const bestPreferredBoundary = userBoundaries
    .filter((index) => prefixTokens[index - 1] <= upperBound)
    .sort((left, right) => {
      const leftDistance = Math.abs(prefixTokens[left - 1] - targetTokens);
      const rightDistance = Math.abs(prefixTokens[right - 1] - targetTokens);
      return leftDistance - rightDistance;
    })[0];

  if (bestPreferredBoundary !== undefined) {
    return bestPreferredBoundary;
  }

  for (let index = messages.length - 1; index > 0; index -= 1) {
    if (prefixTokens[index - 1] <= upperBound) {
      return index;
    }
  }

  return messages.length - 1;
}

export function createSummaryPrompt(messages: LcmMessage[], opts: SummaryOptions): string {
  const sourceType = opts.depth === 0 ? "raw conversation messages" : "existing summaries that need condensation";
  const compressionMode = opts.aggressive
    ? "Aggressive mode is enabled: you may lossy-compress repetitive or low-signal repetition, but preserve unique technical facts."
    : "Normal mode is enabled: preserve as much technical detail as possible.";

  const instructions = [
    `Summarize these ${sourceType}.`,
    "Preserve ALL technical decisions, file paths, code changes, and error messages.",
    "Maintain a chronological narrative from earliest to latest.",
    "Explicitly distinguish what was attempted, what failed, and what ultimately succeeded.",
    "Keep exact function signatures and variable names whenever they appear.",
    "Call out unresolved problems, follow-up work, constraints, and verification results.",
    compressionMode,
    "Return plain text only.",
  ];

  const renderedMessages = messages
    .map((message, index) => [`### Item ${index + 1}`, formatMessage(message)].join("\n"))
    .join("\n\n");

  return [
    "You are condensing an engineering conversation without losing critical implementation context.",
    ...instructions,
    "",
    `Depth: ${opts.depth}`,
    `Items: ${messages.length}`,
    "",
    "Source material:",
    renderedMessages,
  ].join("\n");
}

export async function summarize(
  config: LcmConfig,
  messages: LcmMessage[],
  opts: SummaryOptions,
): Promise<SummaryResult> {
  const prompt = createSummaryPrompt(messages, opts);
  const result = await ai.generateText({
    model: config.model,
    system: SUMMARIZER_SYSTEM_PROMPT,
    prompt,
  });

  const text = result.text.trim();

  return {
    text,
    inputTokens: result.usage.inputTokens ?? estimateTokens(prompt),
    outputTokens: result.usage.outputTokens ?? countTokens(text),
  };
}

export async function batchSummarize(
  config: LcmConfig,
  messageBatches: LcmMessage[][],
  opts: SummaryOptions = { depth: 0 },
): Promise<SummaryResult[]> {
  const results: SummaryResult[] = [];

  for (const batch of messageBatches) {
    results.push(await summarize(config, batch, opts));
  }

  return results;
}

export function shouldSummarize(
  messageCount: number,
  tokenCount: number,
  thresholds: { summarizeAfterMessages: number; summarizeAfterTokens: number },
): boolean {
  return (
    messageCount >= thresholds.summarizeAfterMessages || tokenCount >= thresholds.summarizeAfterTokens
  );
}

export function splitIntoChunks(messages: LcmMessage[], targetTokens: number): LcmMessage[][] {
  if (messages.length === 0) {
    return [];
  }

  if (targetTokens <= 0) {
    return [messages.slice()];
  }

  const upperBound = Math.ceil(targetTokens * 1.1);
  const chunks: LcmMessage[][] = [];
  let buffer: LcmMessage[] = [];
  let bufferTokens = 0;

  const flushAtBoundary = (): void => {
    if (buffer.length === 0) {
      return;
    }

    if (buffer.length === 1) {
      chunks.push(buffer);
      buffer = [];
      bufferTokens = 0;
      return;
    }

    const boundaryIndex = findBoundaryIndex(buffer, targetTokens, upperBound);
    const chunk = buffer.slice(0, boundaryIndex);
    const remainder = buffer.slice(boundaryIndex);

    chunks.push(chunk);
    buffer = remainder;
    bufferTokens = buffer.reduce((total, message) => total + getMessageTokenCount(message), 0);
  };

  for (const message of messages) {
    buffer.push(message);
    bufferTokens += getMessageTokenCount(message);

    while (bufferTokens > upperBound && buffer.length > 1) {
      flushAtBoundary();
    }
  }

  if (buffer.length > 0) {
    chunks.push(buffer);
  }

  return chunks;
}
