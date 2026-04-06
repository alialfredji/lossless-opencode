# lossless-opencode

Lossless context management plugin for OpenCode with hierarchical summaries, DAG history, and BM25 retrieval.

## What is LCM?

LCM stands for Lossless Context Management. Instead of destructively truncating old context, it compresses history into a hierarchy of summaries stored as a DAG at increasing depths while keeping the original data retrievable.

BM25 retrieval keeps relevant prior details accessible, so the model can recover exact context when summaries alone are not enough.

## Installation

Install the plugin package:

```bash
bun add lossless-opencode
```

Register it in your OpenCode config as a plugin:

```json
{
  "plugin": [
    [
      "lossless-opencode",
      {
        "lcm": {
          "dataDir": ".lcm"
        }
      }
    ]
  ]
}
```

For local development, point OpenCode at this repository according to your local plugin-loading setup.

## How It Works

LCM stores every conversation message in SQLite, indexes message and summary text with FTS5/BM25, and compacts older history into a summary DAG instead of a single flat summary.

High-level flow:

1. Persist incoming messages to SQLite.
2. Detect oversized content and replace it with a large-file placeholder.
3. Index messages and summaries for BM25 search.
4. Summarize unsummarized history once message or token thresholds are crossed.
5. Condense summaries upward into a DAG as depth grows.
6. Reassemble context from root summaries, leaf summaries, and the fresh tail under the token budget.
7. Expose retrieval tools so the model can drill back into exact history when needed.

Core ideas:

- Hierarchical summarization: leaf summaries cover raw messages, deeper summaries condense earlier summaries.
- DAG history: parent-child summary links preserve structure instead of flattening everything.
- BM25 retrieval: `lcm_grep` and `lcm_expand_query` recover exact prior details from persisted history.

## Configuration

Configure the plugin under the `lcm` key. Defaults come from `DEFAULT_CONFIG` in `src/types.ts` and are re-exported via `src/config/defaults.ts`.

| Key | Type | Default | Notes |
|---|---|---|---|
| `dataDir` | `string` | `".lcm"` | Runtime directory for SQLite DB and log/output files. |
| `maxContextTokens` | `number` | `120000` | Global context budget for assembled LCM context. |
| `softTokenThreshold` | `number` | `100000` | Preferred threshold before compaction pressure increases. |
| `hardTokenThreshold` | `number` | `150000` | Aggressive threshold before harder compaction behavior. |
| `freshTailSize` | `number` | `64` | Max recent unsummarized messages kept in full text. |
| `maxLeafSummaryTokens` | `number` | `1200` | Target size for depth-0 summaries. |
| `maxCondensedSummaryTokens` | `number` | `2000` | Target size for condensed summaries. |
| `leafSummaryBudget` | `number` | `1200` | Token budget used when chunking raw messages for summarization. |
| `condensedSummaryBudget` | `number` | `2000` | Budget used for deterministic truncation / higher-level compaction. |
| `maxSummaryDepth` | `number` | `5` | Maximum DAG depth before deterministic truncation. |
| `summaryMaxOverageFactor` | `number` | `3` | Allowed summary overage factor. Present in config shape for tuning. |
| `compactionBatchSize` | `number` | `10` | Batch size config key exposed by the plugin. |
| `aggressiveThreshold` | `number` | `3` | Depth at or above which compaction becomes aggressive. |
| `model` | `string` | `""` | Empty string means derive the model from the active OpenCode session. Non-empty values must look like `provider:model` or `provider/model`. |
| `enableIntegrity` | `boolean` | `true` | Enables integrity-related config state. |
| `enableFts` | `boolean` | `true` | Enables full-text-search-related config state. |
| `largeFileThreshold` | `number` | `50000` | Token threshold for large-file extraction. |
| `dbPath` | `string` | `".lcm/lcm.db"` | SQLite database path. Relative paths resolve from the plugin config directory. |
| `summarizeAfterMessages` | `number` | `20` | Trigger summarization after this many unsummarized messages. |
| `summarizeAfterTokens` | `number` | `20000` | Trigger summarization after this many unsummarized tokens. |

## Tools

### `lcm_grep`

BM25 full-text search across persisted conversation history.

Args:

- `query: string` required
- `limit?: number` default `10`
- `type?: "messages" | "summaries" | "all"` default `"all"`

Examples:

```text
lcm_grep(query="foreign key failure")
lcm_grep(query="reset session", type="summaries", limit=5)
```

### `lcm_describe`

Shows session state: total messages, fresh tail, summary DAG counts, token budget usage, FTS counts, and compaction level.

Args: none.

Example:

```text
lcm_describe()
```

### `lcm_expand_query`

Expands a summary, a message range, or a search query into full stored content.

Args:

- `target: string` required. Accepts a summary UUID, `messages:N-M`, or a free-text search query.
- `format?: "full" | "condensed"` default `"full"`

Examples:

```text
lcm_expand_query(target="messages:10-25")
lcm_expand_query(target="550e8400-e29b-41d4-a716-446655440000", format="condensed")
lcm_expand_query(target="migration error")
```

## Commands

The plugin registers two session-management commands through the OpenCode tool hook:

- `lcm_new` — generates a new session ID and starts a fresh tracked session.
- `lcm_reset` — deletes messages, summaries, and large-file records for the current session.

## Architecture

Module overview:

- `src/index.ts` — plugin entry point, hook wiring, tool registration.
- `src/pipeline.ts` — main message transform pipeline.
- `src/messages/persistence.ts` — message persistence and unsummarized-message queries.
- `src/compaction/engine.ts` — summarization orchestration, condensation, deterministic truncation.
- `src/context/assembler.ts` — context selection under budget.
- `src/context/formatter.ts` — XML-style summary and large-file formatting.
- `src/search/indexer.ts` — FTS5 indexing and BM25 retrieval.
- `src/summaries/dag-store.ts` — summary storage, edges, and DAG tree reconstruction.
- `src/files/large-file-handler.ts` — oversized content detection and storage.
- `src/session/manager.ts` — session lifecycle helpers plus `lcm_new` and `lcm_reset`.
- `src/db/database.ts` / `src/db/migrations.ts` — SQLite setup and schema.
- `src/integrity/checker.ts` — integrity checks and repair helpers.
- `src/summarization/summarizer.ts` — prompt construction, chunking, LLM summarization calls.
- `src/errors/handler.ts` — retry, fallback, and error logging helpers.

## Troubleshooting

- Plugin loads but config is ignored: use the `plugin` array with a `lossless-opencode` entry and put settings under `lcm`.
- Unexpected model validation error: `model` must be empty or match `provider:model` / `provider/model`.
- `.lcm` keeps showing up in git: add `.lcm/` to `.gitignore` in consuming repos too if needed.
- Search returns no useful results: confirm the session has persisted history and FTS is enabled in config.
- Native compaction still happens: LCM sets a high OpenCode token budget, but OpenCode still needs the plugin loaded for custom compaction to run.
- Session reset fails on old runtime data: delete the local `.lcm/` directory and start a fresh session.

## Development

Install:

```bash
bun install
```

Run tests:

```bash
bun test
```

Run typecheck:

```bash
bun run typecheck
```

Run benchmarks:

```bash
bun run bench
```

There is no separate build step. Bun runs the TypeScript entrypoint directly via `main: "src/index.ts"`.

## Credits/License

- Inspired by the LCM paper: [Lossless Context Management for Agentic AI](https://arxiv.org/abs/2502.14258)
- Reference implementation inspiration: [lossless-claw](https://github.com/martian-engineering/lossless-claw)
- License: MIT
