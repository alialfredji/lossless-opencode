import type { Database } from "bun:sqlite";
import type { Config, Hooks, Plugin, PluginInput, ToolDefinition } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { createDatabase } from "./db/database";
import { runMigrations } from "./db/migrations";
import { persistMessage } from "./messages/persistence";
import { runPipeline } from "./pipeline";
import { DEFAULT_CONFIG, type LcmConfig, type LcmMessage } from "./types";
import { countTokens } from "./utils/tokens";
import { resolve } from "path";

export interface HookSessionState {
  sessionId: string | null;
  db: Database | null;
  config: LcmConfig;
  isCompacting: boolean;
}

type ChatMessageHook = NonNullable<Hooks["chat.message"]>;
type ChatMessageInput = Parameters<ChatMessageHook>[0];
type ChatMessageOutput = Parameters<ChatMessageHook>[1];
type ChatTransformHook = NonNullable<Hooks["experimental.chat.messages.transform"]>;
type ChatTransformOutput = Parameters<ChatTransformHook>[1];
type SessionCompactingHook = NonNullable<Hooks["experimental.session.compacting"]>;
type SessionCompactingInput = Parameters<SessionCompactingHook>[0];
type SessionCompactingOutput = Parameters<SessionCompactingHook>[1];

interface StubToolDefinition extends ToolDefinition {
  parameters: {
    type: "object";
    properties: Record<string, never>;
    additionalProperties: false;
    required: [];
  };
}

const NATIVE_COMPACTION_PROMPT = "Return an empty summary. Context is managed by LCM plugin.";

export function createSessionState(config?: Partial<LcmConfig>): HookSessionState {
  return {
    sessionId: null,
    db: null,
    config: {
      ...DEFAULT_CONFIG,
      ...config,
    },
    isCompacting: false,
  };
}

function resolveDatabasePath(directory: string, dbPath: string): string {
  if (dbPath === ":memory:" || dbPath.startsWith("file:")) {
    return dbPath;
  }

  return resolve(directory, dbPath);
}

function getOrCreateDatabase(state: HookSessionState, directory: string): Database {
  if (state.db) {
    return state.db;
  }

  const db = createDatabase(resolveDatabasePath(directory, state.config.dbPath));
  runMigrations(db);
  state.db = db;
  return db;
}

function extractMessageContent(parts: ChatMessageOutput["parts"]): string {
  return parts
    .flatMap((part) => {
      if (part.type === "text" || part.type === "reasoning") {
        return [part.text];
      }

      return [];
    })
    .join("\n\n")
    .trim();
}

function ensureConversation(db: Database, sessionId: string): void {
  db
    .prepare("INSERT OR IGNORE INTO conversations (id, session_id) VALUES (?, ?)")
    .run(sessionId, sessionId);
}

function toPersistedMessage(
  sessionId: string,
  message: ChatMessageOutput["message"],
  parts: ChatMessageOutput["parts"],
): LcmMessage {
  const content = extractMessageContent(parts);

  return {
    id: message.id,
    role: message.role,
    content,
    timestamp: new Date(message.time.created).toISOString(),
    sessionId,
    tokenCount: countTokens(content),
    summarized: false,
    sequenceNumber: 0,
    conversationId: sessionId,
  };
}

function createStubTool(description: string): StubToolDefinition {
  return {
    ...tool({
      description,
      args: {},
      async execute() {
        return "Not yet implemented";
      },
    }),
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
      required: [],
    },
  };
}

export function createChatMessageHandler(state: HookSessionState, directory: string) {
  return async (
    input: ChatMessageInput,
    output: ChatMessageOutput,
  ): Promise<void> => {
    state.sessionId = input.sessionID;

    const db = getOrCreateDatabase(state, directory);
    const persistedMessage = toPersistedMessage(input.sessionID, output.message, output.parts);

    db.transaction(() => {
      ensureConversation(db, input.sessionID);
      persistMessage(db, input.sessionID, persistedMessage);
    })();
  };
}

export function createMessagesTransformHandler(state: HookSessionState) {
  return async (
    _input: {},
    output: ChatTransformOutput,
  ): Promise<void> => {
    output.messages = await runPipeline(state, output.messages);
  };
}

export function createSessionCompactingHandler() {
  return async (
    _input: SessionCompactingInput,
    output: SessionCompactingOutput,
  ): Promise<void> => {
    output.prompt = NATIVE_COMPACTION_PROMPT;
  };
}

export function createConfigHandler() {
  return async (config: Config): Promise<void> => {
    (config as Config & { maxTokens: number }).maxTokens = 999999;
  };
}

export function createToolHooks(): Record<string, StubToolDefinition> {
  return {
    lcm_grep: createStubTool("Search persisted LCM state. Not yet implemented."),
    lcm_describe: createStubTool("Describe LCM state. Not yet implemented."),
    lcm_expand_query: createStubTool("Expand LCM retrieval queries. Not yet implemented."),
  };
}

const plugin: Plugin = async (ctx: PluginInput) => {
  const state = createSessionState();

  return {
    "chat.message": createChatMessageHandler(state, ctx.directory),
    "experimental.chat.messages.transform": createMessagesTransformHandler(state),
    "experimental.session.compacting": createSessionCompactingHandler(),
    tool: createToolHooks(),
    config: createConfigHandler(),
  };
};

export default plugin;
