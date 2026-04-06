# LLM Map

## Project Overview
- Lossless Context Management plugin for OpenCode.
- Persists conversation history, indexes it with FTS5, compacts older messages into summaries, and rebuilds LLM context under token budgets.
- Install in OpenCode as a plugin; runtime data lives in `.lcm/` by default.

## Directory Structure
```text
src/
  index.ts — Plugin entry point; hook wiring, session state, tool registration
  pipeline.ts — Message transform pipeline
  types.ts — Shared TypeScript types, DEFAULT_CONFIG, LcmConfigSchema
  compaction/
    engine.ts — Compaction orchestration and depth handling
    index.ts — Re-exports compaction module
  config/
    defaults.ts — Config merge, validation, data-dir resolution
    index.ts — Re-exports config helpers
  context/
    assembler.ts — Context selection and prioritization
    formatter.ts — Context-to-message XML formatting
    index.ts — Re-exports context helpers
  db/
    database.ts — SQLite database creation
    migrations.ts — Schema migrations and FTS setup
    index.ts — Re-exports db helpers
  errors/
    handler.ts — Error wrappers, retry logic, LcmError
  files/
    large-file-handler.ts — Large content detection and storage
  hooks/
    index.ts — Hook helpers and exports
  integrity/
    checker.ts — Integrity checks and repair reporting
  messages/
    persistence.ts — Message persistence and retrieval
  search/
    indexer.ts — FTS indexing and search helpers
  session/
    manager.ts — Session lifecycle management
  store/
    index.ts — Store exports
  summaries/
    dag-store.ts — Summary DAG storage and lookup
    index.ts — Re-exports summary helpers
  summarization/
    summarizer.ts — LLM summarization and chunking
    index.ts — Re-exports summarization helpers
  tools/
    lcm-grep.ts — lcm_grep tool definition and search formatter
    lcm-describe.ts — lcm_describe tool definition and session state formatter
    lcm-expand-query.ts — lcm_expand_query tool definition and expansion formatter
  utils/
    tokens.ts — Token counting utility
tests/
  unit/ — Module-level unit tests
  integration/ — Hook and pipeline integration tests
  e2e/ — Full pipeline end-to-end tests
  bench/ — Performance benchmarks
  helpers/ — Shared test db and mocks
```

## Module Dependency Graph
```text
index.ts → pipeline.ts → messages/persistence.ts
                     → files/large-file-handler.ts
                     → search/indexer.ts
                     → compaction/engine.ts → summarization/summarizer.ts
                                            → summaries/dag-store.ts
                     → context/assembler.ts
                     → context/formatter.ts
                     → errors/handler.ts
index.ts → tools/lcm-grep.ts → search/indexer.ts
index.ts → tools/lcm-describe.ts → summaries/dag-store.ts
index.ts → tools/lcm-expand-query.ts → summaries/dag-store.ts
index.ts → session/manager.ts
index.ts → integrity/checker.ts
All modules → types.ts
All modules → db/database.ts
```

## Key Entry Points
- `src/index.ts` — default plugin factory returning `Hooks`
- `src/pipeline.ts` — `runPipeline(state, messages)`
- `src/compaction/engine.ts` — `compact(db, config, sessionId)`
- `src/context/assembler.ts` — `assembleContext(db, config, sessionId)`

## Data Flow
```text
1. OpenCode fires chat.message hook → state.sessionId set
2. OpenCode fires messages.transform hook
3. runPipeline(state, messages)
   a. persistMessage() → messages table
   b. extractAndStore() → large_files table when needed
   c. indexMessage() → FTS5 index
   d. shouldSummarize() → compact() → summarize() → storeSummary() → DAG
   e. assembleContext() → ContextItem[]
   f. formatContextAsMessages() → TransformMessage[]
4. Formatted messages return to OpenCode for LLM input
```

## Type Map
- `LcmConfig` — Plugin configuration shape
- `LcmMessage` — Persisted message record
- `CompactionLevel` — `normal | aggressive | deterministic`
- `Summary` — Summary DAG node
- `SummaryNode` — Nested summary tree node
- `ContextItem` — Assembled context item
- `CompactionResult` — Compaction output summary
- `LargeFile` — Offloaded large file record
- `IntegrityCheck` — Single integrity check result
- `IntegrityReport` — Aggregated integrity report
- `IntegrityCheckResult` — Repair-oriented integrity result
- `SessionState` — Session runtime state
- `RetrievalResult` — Search result wrapper

## Config Options
| Name | Type | Default |
|---|---:|---:|
| dataDir | string | `.lcm` |
| maxContextTokens | number | 120000 |
| softTokenThreshold | number | 100000 |
| hardTokenThreshold | number | 150000 |
| freshTailSize | number | 64 |
| maxLeafSummaryTokens | number | 1200 |
| maxCondensedSummaryTokens | number | 2000 |
| leafSummaryBudget | number | 1200 |
| condensedSummaryBudget | number | 2000 |
| maxSummaryDepth | number | 5 |
| summaryMaxOverageFactor | number | 3 |
| compactionBatchSize | number | 10 |
| aggressiveThreshold | number | 3 |
| model | string | `anthropic:claude-sonnet-4-20250514` |
| enableIntegrity | boolean | true |
| enableFts | boolean | true |
| largeFileThreshold | number | 50000 |
| dbPath | string | `.lcm/lcm.db` |
| summarizeAfterMessages | number | 20 |
| summarizeAfterTokens | number | 20000 |

## Tool Definitions
- `lcm_grep`
  - description: Search persisted conversation history with BM25 FTS over messages and summaries
  - args:
    - `query` (string, required)
    - `limit` (number, optional)
    - `type` (enum, optional: `messages` | `summaries` | `all`)
- `lcm_describe`
  - description: Show current LCM session state
  - args: none
- `lcm_expand_query`
  - description: Retrieve full content of a summary, message range, or search result
  - args:
    - `target` (string, required)
    - `format` (enum, optional: `full` | `condensed`)

## Database Schema
```text
conversations(id PK, session_id, created_at, archived)
messages(id PK, conversation_id FK→conversations, role, content, token_count, sequence_number, created_at, UNIQUE(conversation_id, sequence_number))
message_parts(id PK, message_id FK→messages, part_type, content, sequence_number)
summaries(id PK, conversation_id FK→conversations, depth, content, token_count, created_at, compaction_level)
summary_messages(summary_id FK→summaries, message_id FK→messages, PK(summary_id, message_id))
summary_parents(child_id FK→summaries, parent_id FK→summaries, PK(child_id, parent_id))
context_items(id PK, conversation_id FK→conversations, item_type, reference_id, depth, position, UNIQUE(conversation_id, position))
large_files(id PK, conversation_id FK→conversations, message_id FK→messages nullable, placeholder, original_path, token_count, structural_summary, content, created_at)
lcm_migrations(version PK, applied_at)
messages_fts FTS5(content) over messages
summaries_fts FTS5(content) over summaries
```

## Testing
```text
bun test                     # Run all tests
bun test tests/unit/         # Unit tests only
bun test tests/integration/  # Integration tests
bun test tests/e2e/          # E2E tests
bun run bench                # Performance benchmarks
bun run tsc --noEmit         # TypeScript type check

tests/unit/         — Module-level unit tests
tests/integration/  — Hook integration tests
tests/e2e/          — Full pipeline E2E tests
tests/bench/        — Performance benchmarks
tests/helpers/      — Shared test helpers and mocks
```
