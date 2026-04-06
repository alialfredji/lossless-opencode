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

export function getPromptForDepth(depth: number, aggressive?: boolean): string {
  let base: string;

  if (depth === 0) {
    base =
      "You are summarizing raw conversation messages. Preserve ALL: technical decisions, file paths, code snippets, error messages, tool usage results. Maintain chronological narrative. This summary is the first compression — nothing else captures this content.";
  } else if (depth === 1) {
    base =
      "You are condensing multiple summaries into a higher-level overview. Each input is already a summary. Focus on: overarching decisions, project trajectory, key outcomes. Individual code snippets can be referenced rather than reproduced. Maintain enough detail that specific events can be located via search tools.";
  } else {
    base =
      "You are creating a high-level project synopsis from condensed summaries. Focus on: major milestones, architectural decisions, current project state, unresolved issues. This is the most compressed view — prioritize what's essential for understanding the project's current state.";
  }

  if (aggressive === true) {
    return (
      base +
      "\n\nApply aggressive compression. Reduce token count by 40%. Prioritize: decisions > code > discussion. Remove: greetings, acknowledgments, repeated context, verbose explanations."
    );
  }

  return base;
}

export function formatMessagesForSummary(messages: LcmMessage[], depth: number): string {
  if (depth === 0) {
    return messages
      .map((message, index) => {
        const header = `[#${index + 1} | ${message.role} | ${message.timestamp}]`;
        return `${header}\n${message.content}`;
      })
      .join("\n---\n");
  }

  return messages
    .map((message, index) => {
      const header = `[Summary #${index + 1} | depth]`;
      return `${header}\n${message.content}`;
    })
    .join("\n---\n");
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
  const systemPrompt = getPromptForDepth(opts.depth, opts.aggressive ?? false);
  const formattedBody = formatMessagesForSummary(messages, opts.depth);

  return [
    systemPrompt,
    "",
    "Preserve ALL technical decisions, file paths, code changes, and error messages.",
    "Maintain a chronological narrative from earliest to latest.",
    "Explicitly distinguish what was attempted, what failed, and what ultimately succeeded.",
    "Keep exact function signatures and variable names whenever they appear.",
    "Call out unresolved problems, follow-up work, constraints, and verification results.",
    "Return plain text only.",
    "",
    `Depth: ${opts.depth}`,
    `Items: ${messages.length}`,
    "",
    "Source material:",
    formattedBody,
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
