import type { Hooks } from "@opencode-ai/plugin";
import { compact } from "./compaction/engine";
import { assembleContext } from "./context/assembler";
import { formatContextAsMessages } from "./context/formatter";
import { LcmError, retryWithBackoff, wrapAsync } from "./errors/handler";
import { detectLargeContent, extractAndStore } from "./files/large-file-handler";
import {
  getMessageCount,
  getUnsummarizedMessages,
  persistMessage,
} from "./messages/persistence";
import { indexMessage } from "./search/indexer";
import { shouldSummarize } from "./summarization/summarizer";
import { getRootSummaries } from "./summaries/dag-store";
import type { HookSessionState, LcmMessage } from "./types";
import { countTokens } from "./utils/tokens";

type TransformHook = NonNullable<Hooks["experimental.chat.messages.transform"]>;
type TransformMessage = Parameters<TransformHook>[1]["messages"][number];
type OpenCodeMessage = TransformMessage["info"];
type OpenCodePart = TransformMessage["parts"][number];

interface CountRow {
  count: number;
}

interface MaxDepthRow {
  maxDepth: number | null;
}

function ensureConversation(state: HookSessionState): void {
  state.db
    ?.query<void, [string, string]>(
      "INSERT OR IGNORE INTO conversations (id, session_id) VALUES (?, ?)",
    )
    .run(state.sessionId ?? "", state.sessionId ?? "");
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function partToText(part: OpenCodePart): string {
  switch (part.type) {
    case "text":
    case "reasoning":
      return part.text;
    case "file":
      return part.source?.text.value ?? part.filename ?? part.url;
    case "tool": {
      const input = stringifyUnknown(part.state.input);

      if (part.state.status === "completed") {
        return [
          `[Tool ${part.tool}]`,
          `Input: ${input}`,
          `Output: ${part.state.output}`,
        ].join("\n");
      }

      if (part.state.status === "error") {
        return [
          `[Tool ${part.tool}]`,
          `Input: ${input}`,
          `Error: ${part.state.error}`,
        ].join("\n");
      }

      return [`[Tool ${part.tool}]`, `Input: ${input}`].join("\n");
    }
    case "subtask":
      return [part.description, part.prompt].join("\n");
    case "step-start":
      return part.snapshot ?? "[Step started]";
    case "step-finish":
      return [part.reason, part.snapshot ?? ""].filter(Boolean).join("\n");
    case "snapshot":
      return part.snapshot;
    case "patch":
      return [`Patch ${part.hash}`, part.files.join("\n")].join("\n");
    case "agent":
      return part.source?.value ?? part.name;
    case "retry":
      return `Retry ${part.attempt}: ${part.error.data.message}`;
    case "compaction":
      return part.auto ? "[Automatic compaction]" : "[Compaction]";
    default:
      return "";
  }
}

function extractMessageContent(message: TransformMessage): string {
  return message.parts.map(partToText).filter((text) => text.trim().length > 0).join("\n\n").trim();
}

function toLcmMessage(sessionId: string, message: TransformMessage): LcmMessage {
  const content = extractMessageContent(message);

  return {
    id: message.info.id,
    role: message.info.role,
    content,
    timestamp: new Date(message.info.time.created).toISOString(),
    sessionId,
    tokenCount: countTokens(content),
    summarized: false,
    sequenceNumber: 0,
    conversationId: sessionId,
  };
}

function messageExists(state: HookSessionState, messageId: string): boolean {
  const row = state.db
    ?.query<{ id: string }, [string, string]>(
      "SELECT id FROM messages WHERE conversation_id = ? AND id = ?",
    )
    .get(state.sessionId ?? "", messageId);

  return row !== null && row !== undefined;
}

function withTextContent(message: TransformMessage, text: string): TransformMessage {
  const sessionID = message.info.sessionID;
  const messageID = message.info.id;

  return {
    info: message.info,
    parts: [
      {
        id: crypto.randomUUID(),
        sessionID,
        messageID,
        type: "text",
        text,
      },
    ],
  };
}

function deriveModelInfo(messages: TransformMessage[]): {
  providerID: string;
  modelID: string;
} {
  for (const message of messages) {
    if (message.info.role === "assistant") {
      return {
        providerID: message.info.providerID,
        modelID: message.info.modelID,
      };
    }

    return {
      providerID: message.info.model.providerID,
      modelID: message.info.model.modelID,
    };
  }

  return {
    providerID: "lcm",
    modelID: "lcm",
  };
}

function toTransformMessages(
  messages: Array<{ role: string; content: string }>,
  originalMessages: TransformMessage[],
  sessionId: string,
): TransformMessage[] {
  const model = deriveModelInfo(originalMessages);
  let parentID = originalMessages.at(-1)?.info.id ?? crypto.randomUUID();

  return messages.map((message) => {
    const infoId = crypto.randomUUID();
    const created = Date.now();
    const info: OpenCodeMessage = {
      id: infoId,
      sessionID: sessionId,
      role: "assistant",
      time: {
        created,
        completed: created,
      },
      parentID,
      modelID: model.modelID,
      providerID: model.providerID,
      mode: "default",
      path: {
        cwd: "",
        root: "",
      },
      summary: false,
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: {
          read: 0,
          write: 0,
        },
      },
    };

    parentID = infoId;

    return {
      info,
      parts: [
        {
          id: crypto.randomUUID(),
          sessionID: sessionId,
          messageID: infoId,
          type: "text",
          text: message.content,
        },
      ],
    };
  });
}

function getSummaryCount(state: HookSessionState): number {
  const row = state.db
    ?.query<CountRow, [string]>(
      "SELECT COUNT(*) AS count FROM summaries WHERE conversation_id = ?",
    )
    .get(state.sessionId ?? "");

  return row?.count ?? 0;
}

function getMaxSummaryDepth(state: HookSessionState): number {
  const row = state.db
    ?.query<MaxDepthRow, [string]>(
      "SELECT MAX(depth) AS maxDepth FROM summaries WHERE conversation_id = ?",
    )
    .get(state.sessionId ?? "");

  return row?.maxDepth ?? 0;
}

export async function runPipeline(
  state: HookSessionState,
  messages: TransformMessage[],
): Promise<TransformMessage[]> {
  const originalMessages = messages;

  try {
    if (!state.db || !state.sessionId) {
      return originalMessages;
    }

    ensureConversation(state);

    if (state.config.model === "") {
      const { providerID, modelID } = deriveModelInfo(messages);

      if (
        providerID !== "" &&
        modelID !== "" &&
        providerID !== "lcm" &&
        modelID !== "lcm"
      ) {
        state.config.model = `${providerID}:${modelID}`;
      }
    }

    const preExistingMessageCount = getMessageCount(state.db, state.sessionId);
    const preExistingSummaries = getRootSummaries(state.db, state.sessionId);

    const transformedMessages = [...messages];
    const newlyPersistedMessages: LcmMessage[] = [];

    for (const [index, message] of transformedMessages.entries()) {
      const lcmMessage = toLcmMessage(state.sessionId, message);

      if (messageExists(state, lcmMessage.id)) {
        continue;
      }

      await wrapAsync(
        async () => {
          persistMessage(state.db!, state.sessionId!, lcmMessage);
        },
        undefined,
        "pipeline:persistNewMessages",
      );
      newlyPersistedMessages.push(lcmMessage);

      await wrapAsync(
        async () => {
          if (detectLargeContent(lcmMessage, state.config.largeFileThreshold).isLarge) {
            const extractedMessage = extractAndStore(
              state.db!,
              state.sessionId!,
              lcmMessage,
              state.config.largeFileThreshold,
            );
            transformedMessages[index] = withTextContent(message, extractedMessage.content);
          }
        },
        undefined,
        "pipeline:detectAndHandleLargeFiles",
      );
    }

    for (const message of newlyPersistedMessages) {
      await wrapAsync(
        async () => {
          indexMessage(state.db!, message.id, message.content, state.sessionId!);
        },
        undefined,
        "pipeline:updateFtsIndex",
      );
    }

    const unsummarizedMessages = getUnsummarizedMessages(state.db, state.sessionId);
    const unsummarizedTokenCount = unsummarizedMessages.reduce(
      (total, message) => total + message.tokenCount,
      0,
    );
    const hasLargeContent = transformedMessages.some(
      (message) => detectLargeContent(toLcmMessage(state.sessionId!, message), state.config.largeFileThreshold).isLarge,
    );

    if (
      shouldSummarize(
        unsummarizedMessages.length,
        unsummarizedTokenCount,
        state.config,
      ) &&
      !state.isCompacting &&
      !hasLargeContent
    ) {
      state.isCompacting = true;

      await wrapAsync(
        async () => {
          await retryWithBackoff(
            () => compact(state.db!, state.config, state.sessionId!),
            {
              maxRetries: 2,
              initialDelay: 1000,
              maxDelay: 5000,
              retryIf: (err) => err instanceof LcmError && err.recoverable,
            },
          );
        },
        undefined,
        "pipeline:compact",
      );

      state.isCompacting = false;
    }

    const rootSummaries = getRootSummaries(state.db, state.sessionId);

    if (preExistingMessageCount === 0 && preExistingSummaries.length === 0 && rootSummaries.length === 0) {
      return originalMessages;
    }

    const contextItems = assembleContext(state.db, state.config, state.sessionId);
    const formattedMessages = formatContextAsMessages(contextItems, {
      totalMessages: getMessageCount(state.db, state.sessionId),
      summariesCount: getSummaryCount(state),
      dagDepth: getMaxSummaryDepth(state),
      freshTailSize: contextItems.filter((item) => item.type === "message").length,
    });

    return toTransformMessages(formattedMessages, transformedMessages, state.sessionId);
  } catch {
    state.isCompacting = false;
    return originalMessages;
  }
}
