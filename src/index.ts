import type { Database } from "bun:sqlite";
import type { Hooks, Plugin, PluginInput, ToolDefinition } from "@opencode-ai/plugin";
import { createConfigHook, mergeConfig } from "./config/defaults";
import { createDatabase } from "./db/database";
import { runMigrations } from "./db/migrations";
import { persistMessage } from "./messages/persistence";
import { runPipeline } from "./pipeline";
import { createNewSessionCommand, createResetCommand } from "./session/manager";
import { createDescribeToolDefinition } from "./tools/lcm-describe";
import { createExpandQueryToolDefinition } from "./tools/lcm-expand-query";
import { createGrepToolDefinition } from "./tools/lcm-grep";
import { LcmConfigSchema, type HookSessionState, type LcmConfig, type LcmMessage } from "./types";
import { countTokens } from "./utils/tokens";
import { resolve } from "path";

export type { HookSessionState } from "./types";

type ChatMessageHook = NonNullable<Hooks["chat.message"]>;
type ChatMessageInput = Parameters<ChatMessageHook>[0];
type ChatMessageOutput = Parameters<ChatMessageHook>[1];
type ChatTransformHook = NonNullable<Hooks["experimental.chat.messages.transform"]>;
type ChatTransformOutput = Parameters<ChatTransformHook>[1];
type SessionCompactingHook = NonNullable<Hooks["experimental.session.compacting"]>;
type SessionCompactingInput = Parameters<SessionCompactingHook>[0];
type SessionCompactingOutput = Parameters<SessionCompactingHook>[1];

export function createSessionState(config?: Partial<LcmConfig>): HookSessionState {
  return {
    sessionId: null,
    db: null,
    config: mergeConfig(config),
    isCompacting: false,
    compactionCount: 0,
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

export function createSessionCompactingHandler(state: HookSessionState = createSessionState()) {
  return async (
    _input: SessionCompactingInput,
    output: SessionCompactingOutput,
  ): Promise<void> => {
    state.compactionCount = (state.compactionCount ?? 0) + 1;

    if (state.isCompacting) {
      output.prompt = "LCM compaction already running. Do not summarize.";
      return;
    }

    if (!state.db || !state.sessionId) {
      output.prompt = "Return only: LCM initializing. Do not summarize.";
      return;
    }

    state.isCompacting = true;

    try {
      const { compact } = await import("./compaction/engine");
      await compact(state.db, state.config, state.sessionId);
      let summaryCount = 0;

      try {
        const { assembleContext } = await import("./context/assembler");
        const contextItems = assembleContext(state.db, state.config, state.sessionId);
        summaryCount = contextItems.filter((item) => item.type === "summary").length;
      } catch {
        summaryCount = 0;
      }

      const maxDepthRow = state.db
        .query<{ max_depth: number | null }, [string]>(
          "SELECT MAX(depth) as max_depth FROM summaries WHERE conversation_id = ?",
        )
        .get(state.sessionId);
      const maxDepth = maxDepthRow?.max_depth ?? 0;

      output.prompt = `Return only: LCM active: ${summaryCount} summaries, depth ${maxDepth}. Do not summarize the conversation yourself.`;
    } catch {
      output.prompt = "LCM compaction failed, native compaction proceeding";
    } finally {
      state.isCompacting = false;
    }
  };
}

export function createConfigHandler(state: HookSessionState) {
  return createConfigHook(state);
}

export function createToolHooks(state: HookSessionState): Record<string, ToolDefinition> {
  return {
    lcm_grep: createGrepToolDefinition(state),
    lcm_describe: createDescribeToolDefinition(state),
    lcm_expand_query: createExpandQueryToolDefinition(state),
    lcm_new: createNewSessionCommand(state),
    lcm_reset: createResetCommand(state),
  };
}

function extractInitialConfig(options?: Record<string, unknown>): Partial<LcmConfig> | undefined {
  if (!options || typeof options !== "object") {
    return undefined;
  }

  const candidate =
    "lcm" in options && options.lcm && typeof options.lcm === "object" ? options.lcm : options;
  const parsed = LcmConfigSchema.parse(candidate);

  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

const plugin: Plugin = async (ctx: PluginInput, options) => {
  const state = createSessionState(extractInitialConfig(options));

  return {
    "chat.message": createChatMessageHandler(state, ctx.directory),
    "experimental.chat.messages.transform": createMessagesTransformHandler(state),
    "experimental.session.compacting": createSessionCompactingHandler(state),
    tool: createToolHooks(state),
    config: createConfigHandler(state),
  };
};

export default plugin;
