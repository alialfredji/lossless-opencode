import { mkdirSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { Config } from "@opencode-ai/plugin";
import { DEFAULT_CONFIG, LcmConfigSchema, type HookSessionState, type LcmConfig, type SessionState } from "../types";

type ConfigHookState = SessionState | Pick<HookSessionState, "config">;

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

const MODEL_PATTERN = /^[^\s:/]+[:/][^\s].*$/;

const validateConfig = (config: LcmConfig): void => {
  for (const key of numericKeys) {
    positiveNumber(config[key], key);
  }

  if (config.maxSummaryDepth < 1) {
    throw new Error("Invalid maxSummaryDepth: expected at least 1");
  }

  if (typeof config.model !== "string") {
    throw new Error("Invalid model: expected a string");
  }

  if (config.model.length > 0 && !MODEL_PATTERN.test(config.model)) {
    throw new Error("Invalid model: expected provider:model or provider/model");
  }
};

export { DEFAULT_CONFIG };

export const mergeConfig = (userConfig?: Partial<LcmConfig>): LcmConfig => {
  if (
    typeof userConfig?.model === "string" &&
    userConfig.model !== "" &&
    userConfig.model.trim().length === 0
  ) {
    throw new Error("Invalid model: expected provider:model or provider/model");
  }

  const merged: LcmConfig = {
    ...DEFAULT_CONFIG,
    ...userConfig,
  };

  merged.model = merged.model.trim();

  validateConfig(merged);
  return merged;
};

export const resolveDataDir = (configDir: string, dataDir: string): string => {
  const absolutePath = isAbsolute(dataDir) ? dataDir : resolve(configDir, dataDir);
  mkdirSync(absolutePath, { recursive: true });
  return absolutePath;
};

export const createConfigHook = (state: ConfigHookState) => {
  const parsePluginConfig = (opencodeConfig: Config): Partial<LcmConfig> | undefined => {
    const pluginEntry = opencodeConfig.plugin?.find(
      (entry): entry is [string, Record<string, unknown>] => Array.isArray(entry) && entry[0] === "lossless-opencode",
    );

    if (!pluginEntry) {
      return undefined;
    }

    const [, options] = pluginEntry;
    if (!options || typeof options !== "object" || !("lcm" in options)) {
      return undefined;
    }

    const candidate = options.lcm;
    if (!candidate || typeof candidate !== "object") {
      throw new Error("Invalid lcm config: expected an object");
    }

    return LcmConfigSchema.parse(candidate) as Partial<LcmConfig>;
  };

  return async (opencodeConfig: Config): Promise<void> => {
    (opencodeConfig as Config & { maxTokens: number }).maxTokens = 999999;

    const userConfig = parsePluginConfig(opencodeConfig);
    if (!("config" in state)) {
      return;
    }

    if (!userConfig) {
      state.config = mergeConfig(state.config);
      return;
    }

    state.config = mergeConfig({
      ...state.config,
      ...userConfig,
      model:
        typeof userConfig.model === "string" && userConfig.model.trim().length > 0
          ? userConfig.model
          : state.config.model,
    });

    if (state.config.model.length > 0) {
      opencodeConfig.model = state.config.model;
    }
  };
};
