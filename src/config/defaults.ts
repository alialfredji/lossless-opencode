import { mkdirSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { Config } from "@opencode-ai/plugin";
import { DEFAULT_CONFIG, type LcmConfig, type SessionState } from "../types";

type NumericConfigKey = {
  [K in keyof LcmConfig]: LcmConfig[K] extends number ? K : never;
}[keyof LcmConfig];

const numericKeys: NumericConfigKey[] = [
  "maxContextTokens",
  "softTokenThreshold",
  "hardTokenThreshold",
  "freshTailSize",
  "maxLeafSummaryTokens",
  "maxCondensedSummaryTokens",
  "leafSummaryBudget",
  "condensedSummaryBudget",
  "maxSummaryDepth",
  "summaryMaxOverageFactor",
  "compactionBatchSize",
  "aggressiveThreshold",
  "largeFileThreshold",
  "summarizeAfterMessages",
  "summarizeAfterTokens",
];

const positiveNumber = (value: number, field: string): void => {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid ${field}: expected a positive number`);
  }
};

const validateConfig = (config: LcmConfig): void => {
  for (const key of numericKeys) {
    positiveNumber(config[key], key);
  }

  if (config.maxSummaryDepth < 1) {
    throw new Error("Invalid maxSummaryDepth: expected at least 1");
  }

  if (typeof config.model !== "string" || config.model.trim().length === 0) {
    throw new Error("Invalid model: expected a non-empty string");
  }
};

export { DEFAULT_CONFIG };

export const mergeConfig = (userConfig?: Partial<LcmConfig>): LcmConfig => {
  const merged: LcmConfig = {
    ...DEFAULT_CONFIG,
    ...userConfig,
  };

  validateConfig(merged);
  return merged;
};

export const resolveDataDir = (configDir: string, dataDir: string): string => {
  const absolutePath = isAbsolute(dataDir) ? dataDir : resolve(configDir, dataDir);
  mkdirSync(absolutePath, { recursive: true });
  return absolutePath;
};

export const createConfigHook = (state: SessionState) => {
  void state;

  return async (opencodeConfig: Config): Promise<void> => {
    (opencodeConfig as Config & { maxTokens: number }).maxTokens = 999999;
  };
};
