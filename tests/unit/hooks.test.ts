import { afterEach, describe, expect, it } from "bun:test";
import type { Hooks, PluginInput } from "@opencode-ai/plugin";
import plugin, {
  createChatMessageHandler,
  createSessionCompactingHandler,
  createSessionState,
} from "../../src/index";
import { mockConfig } from "../helpers/mocks";

type ChatMessageOutput = Parameters<NonNullable<Hooks["chat.message"]>>[1];

function createPluginInput(directory: string): PluginInput {
  return {
    client: {} as PluginInput["client"],
    project: {} as PluginInput["project"],
    directory,
    worktree: directory,
    serverUrl: new URL("https://opencode.ai"),
    $: {} as PluginInput["$"],
  };
}

function createUserMessage(sessionID: string): ChatMessageOutput["message"] {
  return {
    id: crypto.randomUUID(),
    sessionID,
    role: "user",
    time: {
      created: Date.now(),
    },
    agent: "test-agent",
    model: {
      providerID: "test-provider",
      modelID: "test-model",
    },
  };
}

function createTextPart(
  sessionID: string,
  messageID: string,
  text: string,
): ChatMessageOutput["parts"][number] {
  return {
    id: crypto.randomUUID(),
    sessionID,
    messageID,
    type: "text",
    text,
  };
}

describe("hooks export", () => {
  it("export: default export is a function", () => {
    expect(typeof plugin).toBe("function");
  });
});

describe("hooks compacting", () => {
  it("compacting: sets LCM compaction prompt", async () => {
    const hooks = await plugin(createPluginInput(process.cwd()));
    const output: { context: string[]; prompt?: string } = { context: [] };

    await hooks["experimental.session.compacting"]?.({ sessionID: "session-1" }, output);

    expect(output.prompt).toContain("LCM");
  });

  it("compacting: named handler sets prompt", async () => {
    const handler = createSessionCompactingHandler();
    const output: { context: string[]; prompt?: string } = { context: [] };

    await handler({ sessionID: "session-2" }, output);

    expect(output.prompt).toContain("LCM");
  });
});

describe("hooks session", () => {
  const statesToClose = new Set<ReturnType<typeof createSessionState>>();

  afterEach(() => {
    for (const state of statesToClose) {
      state.db?.close();
    }

    statesToClose.clear();
  });

  it("session: chat.message stores the incoming sessionID", async () => {
    const state = createSessionState(mockConfig({ dbPath: ":memory:" }));
    statesToClose.add(state);

    const handler = createChatMessageHandler(state, process.cwd());
    const message = createUserMessage("test-123");

    await handler(
      { sessionID: "test-123" },
      {
        message,
        parts: [createTextPart("test-123", message.id, "Persist this message")],
      },
    );

    expect(state.sessionId).toBe("test-123");

    const count = state.db
      ?.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM messages")
      .get()?.count;

    expect(count).toBe(1);
  });
});
