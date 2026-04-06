# LLM Map

## Overview
- `lossless-opencode` is an OpenCode plugin that persists chat history, compacts it into a summary DAG, and reconstructs bounded context for the model.
- Runtime data lives in `.lcm/` by default: SQLite database, FTS indexes, and error log output.
- Plugin entrypoint: `src/index.ts`. Runtime path: package `main` is `src/index.ts`.

## Directory Tree
```text
src/
  index.ts
  pipeline.ts
  types.ts
  compaction/
    engine.ts
  config/
    defaults.ts
  context/
    assembler.ts
    formatter.ts
  db/
    database.ts
    index.ts
    migrations.ts
  errors/
    handler.ts
  files/
    large-file-handler.ts
  integrity/
    checker.ts
  messages/
    persistence.ts
  search/
    indexer.ts
  session/
    manager.ts
  summaries/
    dag-store.ts
  summarization/
    summarizer.ts
  tools/
    lcm-describe.ts
    lcm-expand-query.ts
    lcm-grep.ts
  utils/
    tokens.ts
tests/
  bench/run.ts
  e2e/full-pipeline.test.ts
  helpers/db.ts
  integration/compacting-hook.test.ts
  integration/config.test.ts
  integration/transform-hook.test.ts
  unit/chunks.test.ts
  unit/compaction.test.ts
  unit/context.test.ts
  unit/context-formatter.test.ts
  unit/error-handling.test.ts
  unit/integrity.test.ts
  unit/large-file-handler.test.ts
  unit/lcm-grep.test.ts
  unit/messages.test.ts
  unit/search.test.ts
  unit/session.test.ts
  unit/summary-prompts.test.ts
  unit/summaries.test.ts
  unit/token-counting.test.ts
  unit/tools/lcm-describe.test.ts
  unit/tools/lcm-expand-query.test.ts
```

## Dependency Graph
```text
src/index.ts
  -> src/config/defaults.ts
  -> src/db/database.ts
  -> src/db/migrations.ts
  -> src/messages/persistence.ts
  -> src/pipeline.ts
  -> src/session/manager.ts
  -> src/tools/lcm-describe.ts
  -> src/tools/lcm-expand-query.ts
  -> src/tools/lcm-grep.ts
  -> src/types.ts
  -> src/utils/tokens.ts

src/pipeline.ts
  -> src/compaction/engine.ts
  -> src/context/assembler.ts
  -> src/context/formatter.ts
  -> src/errors/handler.ts
  -> src/files/large-file-handler.ts
  -> src/messages/persistence.ts
  -> src/search/indexer.ts
  -> src/summarization/summarizer.ts
  -> src/summaries/dag-store.ts
  -> src/types.ts
  -> src/utils/tokens.ts

src/compaction/engine.ts -> messages/persistence, summarization/summarizer, summaries/dag-store, types
src/context/assembler.ts -> messages/persistence, search/indexer, summaries/dag-store, types, utils/tokens
src/context/formatter.ts -> types
src/integrity/checker.ts -> context/assembler, search/indexer, types
src/tools/lcm-grep.ts -> search/indexer, types
src/tools/lcm-describe.ts -> messages/persistence, compaction/engine, types
src/tools/lcm-expand-query.ts -> messages/persistence, search/indexer, summaries/dag-store, types
src/session/manager.ts -> types
src/config/defaults.ts -> types
src/db/index.ts -> db/database, db/migrations
```

## Entry Points
- `src/index.ts`
  - default export: plugin factory
  - `createSessionState(config?)`
  - `createChatMessageHandler(state, directory)`
  - `createMessagesTransformHandler(state)`
  - `createSessionCompactingHandler(state?)`
  - `createConfigHandler(state)`
  - `createToolHooks(state)`
- `src/pipeline.ts`
  - `runPipeline(state, messages)`
- `src/db/index.ts`
  - `createDatabase`, `closeDatabase`, `runMigrations`

## Data Flow
1. `chat.message` persists raw messages into `conversations`, `messages`, and `message_parts`.
2. `experimental.chat.messages.transform` calls `runPipeline()`.
3. `runPipeline()` persists unseen messages, extracts oversized content into `large_files`, and updates `messages_fts`.
4. When thresholds are crossed, `compact()` creates depth-0 summaries, then condenses them through parent links in `summary_parents`.
5. `assembleContext()` selects summaries plus fresh unsummarized messages under `maxContextTokens`.
6. `formatContextAsMessages()` returns a system preamble plus `<context_summary>` blocks for model consumption.
7. Retrieval tools query `messages_fts`, `summaries_fts`, stored messages, and DAG links to recover exact history.

## Type Map
- `src/types.ts`
  - `LcmConfig`
  - `HookSessionState`
  - `LcmMessage`
  - `CompactionLevel`
  - `Summary`
  - `SummaryNode`
  - `ContextItem`
  - `CompactionResult`
  - `LargeFile`
  - `IntegrityCheck`
  - `IntegrityReport`
  - `IntegrityCheckResult`
  - `SessionState`
  - `RetrievalResult`
  - `DEFAULT_CONFIG`
  - `LcmConfigSchema`

## Config Reference
Source of truth: `src/types.ts` `DEFAULT_CONFIG`, validated/merged in `src/config/defaults.ts`.

| Key | Type | Default |
|---|---|---|
| `dataDir` | string | `.lcm` |
| `maxContextTokens` | number | `120000` |
| `softTokenThreshold` | number | `100000` |
| `hardTokenThreshold` | number | `150000` |
| `freshTailSize` | number | `64` |
| `maxLeafSummaryTokens` | number | `1200` |
| `maxCondensedSummaryTokens` | number | `2000` |
| `leafSummaryBudget` | number | `1200` |
| `condensedSummaryBudget` | number | `2000` |
| `maxSummaryDepth` | number | `5` |
| `summaryMaxOverageFactor` | number | `3` |
| `compactionBatchSize` | number | `10` |
| `aggressiveThreshold` | number | `3` |
| `model` | string | `""` |
| `enableIntegrity` | boolean | `true` |
| `enableFts` | boolean | `true` |
| `largeFileThreshold` | number | `50000` |
| `dbPath` | string | `.lcm/lcm.db` |
| `summarizeAfterMessages` | number | `20` |
| `summarizeAfterTokens` | number | `20000` |

## Tool Reference
- `src/tools/lcm-grep.ts`
  - name: `lcm_grep`
  - args: `query: string`, `limit?: number`, `type?: "messages" | "summaries" | "all"`
  - purpose: BM25 search over messages and/or summaries
- `src/tools/lcm-describe.ts`
  - name: `lcm_describe`
  - args: none
  - purpose: summarize session state, DAG depth, budgets, FTS counts
- `src/tools/lcm-expand-query.ts`
  - name: `lcm_expand_query`
  - args: `target: string`, `format?: "full" | "condensed"`
  - purpose: expand summary UUIDs, `messages:N-M`, or free-text search targets
- `src/session/manager.ts`
  - command-like tool registrations: `lcm_new`, `lcm_reset`

## Schema Reference
Defined in `src/db/migrations.ts`.

- `conversations(id, session_id, created_at, archived)`
- `messages(id, conversation_id, role, content, token_count, sequence_number, created_at)`
- `message_parts(id, message_id, part_type, content, sequence_number)`
- `summaries(id, conversation_id, depth, content, token_count, created_at, compaction_level)`
- `summary_parents(child_id, parent_id)`
- `summary_messages(summary_id, message_id)`
- `context_items(id, conversation_id, item_type, reference_id, depth, position)`
- `large_files(id, conversation_id, message_id, placeholder, original_path, token_count, structural_summary, content, created_at)`
- `lcm_migrations(version, applied_at)`
- `messages_fts` and `summaries_fts` FTS5 virtual tables plus insert triggers

## Testing Reference
- `bun test` — full test suite
- `bun test tests/e2e/full-pipeline.test.ts` — end-to-end pipeline coverage
- `bun run typecheck` — TypeScript verification
- `bun run bench` — benchmark runner in `tests/bench/run.ts`
- `tests/helpers/db.ts` provides in-memory SQLite helpers for unit/integration/e2e tests
