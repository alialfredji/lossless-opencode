import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfigHook, DEFAULT_CONFIG, mergeConfig, resolveDataDir } from "../../src/config/defaults";
import type { SessionState } from "../../src/types";

describe("defaults", () => {
  it("matches the requested default values", () => {
    expect(DEFAULT_CONFIG.dataDir).toBe(".lcm");
    expect(DEFAULT_CONFIG.maxContextTokens).toBe(120000);
    expect(DEFAULT_CONFIG.summarizeAfterMessages).toBe(20);
    expect(DEFAULT_CONFIG.summarizeAfterTokens).toBe(20000);
    expect(DEFAULT_CONFIG.leafSummaryBudget).toBe(1200);
    expect(DEFAULT_CONFIG.condensedSummaryBudget).toBe(2000);
    expect(DEFAULT_CONFIG.maxSummaryDepth).toBe(5);
    expect(DEFAULT_CONFIG.aggressiveThreshold).toBe(3);
    expect(DEFAULT_CONFIG.model).toBe("anthropic:claude-sonnet-4-20250514");
    expect(DEFAULT_CONFIG.enableIntegrity).toBe(true);
    expect(DEFAULT_CONFIG.enableFts).toBe(true);
    expect(DEFAULT_CONFIG.largeFileThreshold).toBe(50000);
  });
});

describe("merge", () => {
  it("only overrides the provided field", () => {
    const merged = mergeConfig({ maxContextTokens: 80000 });

    expect(merged.maxContextTokens).toBe(80000);
    expect(merged.dataDir).toBe(DEFAULT_CONFIG.dataDir);
    expect(merged.model).toBe(DEFAULT_CONFIG.model);
    expect(merged.enableFts).toBe(DEFAULT_CONFIG.enableFts);
  });
});

describe("validation", () => {
  it("rejects invalid numeric values", () => {
    expect(() => mergeConfig({ maxContextTokens: 0 })).toThrow("maxContextTokens");
  });

  it("rejects an empty model", () => {
    expect(() => mergeConfig({ model: "   " })).toThrow("model");
  });

  it("rejects maxSummaryDepth below 1", () => {
    expect(() => mergeConfig({ maxSummaryDepth: 0 })).toThrow("maxSummaryDepth");
  });
});

describe("config hook", () => {
  it("sets maxTokens to 999999", async () => {
    const state: SessionState = {
      sessionId: "session-1",
      conversationId: "conversation-1",
      messageCount: 0,
      lastCompactionAt: null,
      totalTokens: 0,
    };

    const hook = createConfigHook(state);
    const opencodeConfig = {} as Parameters<typeof hook>[0] & { maxTokens: number };
    opencodeConfig.maxTokens = 0;

    await hook(opencodeConfig);

    expect(opencodeConfig.maxTokens).toBe(999999);
  });
});

describe("resolveDataDir", () => {
  it("resolves relative data directories against config dir", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "lcm-config-"));
    const dataDir = resolveDataDir(baseDir, ".lcm");

    expect(dataDir).toBe(join(baseDir, ".lcm"));
    rmSync(baseDir, { recursive: true, force: true });
  });
});
