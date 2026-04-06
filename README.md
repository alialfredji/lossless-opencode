# lossless-opencode

Lossless context management for OpenCode — DAG-based hierarchical summarization that never loses important information.

`bun test` | TypeScript | MIT

## What is LCM?

Lossless Context Management (LCM) addresses the fundamental limitation of fixed context windows in Large Language Models. As conversations grow, native compaction methods often discard older messages or replace them with flat, lossy summaries, leading to the "forgetting" of critical technical decisions, code changes, or error traces.

LCM solves this by using a Directed Acyclic Graph (DAG) of hierarchical summaries. Instead of a single flat summary, LCM maintains a structured history where every piece of information is preserved at some level of abstraction. This ensures that the model always has access to a high-level synopsis of the entire conversation while retaining the ability to "drill down" into specific details when needed.

The key benefit of LCM is that technical context remains intact regardless of conversation length. Decisions made hundreds of messages ago are still reachable through the summary hierarchy or via targeted retrieval tools, preventing the model from hallucinating or repeating past mistakes.

For a deeper theoretical understanding, refer to the original paper: [Lossless Context Management for Agentic AI](https://arxiv.org/abs/2502.14258).

## Installation

Install the package via bun:

```bash
bun add lossless-opencode
```

Or for local development:

```bash
bun add file:~/dev/projects/lossless-opencode
```

To enable the plugin in OpenCode, add it to your `~/.config/opencode/config.json`:

```json
{
  "plugins": [
    "lossless-opencode"
  ]
}
```

## How It Works

The LCM pipeline ensures that context is managed efficiently without losing data:

```
Messages → Persist to SQLite → Large File Check → FTS Index Update
    ↓
Compaction Check → Summarize → DAG Store → Assemble Context → Format XML
    ↓
Return to LLM (within token budget)
```

1.  **Persistence**: Every message is immediately stored in a local SQLite database.
2.  **Large File Check**: Content exceeding the `largeFileThreshold` is offloaded to specialized storage to save context space.
3.  **FTS Indexing**: Messages and summaries are indexed for fast full-text search.
4.  **Compaction**: When token limits are reached, the system triggers hierarchical summarization.
5.  **DAG Store**: Summaries are organized in a DAG, linking them to the original messages they cover.
6.  **Context Assembly**: The system dynamically selects the most relevant summaries and recent messages to fit the LLM's context window.

## Configuration

Configure LCM by adding an `lcm` object to your OpenCode configuration.

### Token Limits
| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `maxContextTokens` | `number` | `120000` | Maximum total tokens allowed in the context window. |
| `softTokenThreshold` | `number` | `100000` | Threshold to start considering compaction. |
| `hardTokenThreshold` | `number` | `150000` | Absolute limit where aggressive compaction is forced. |
| `freshTailSize` | `number` | `64` | Number of recent messages to keep as full text. |

### Compaction & Summarization
| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `maxLeafSummaryTokens` | `number` | `1200` | Target token count for depth-0 summaries. |
| `maxCondensedSummaryTokens` | `number` | `2000` | Target token count for higher-level summaries. |
| `leafSummaryBudget` | `number` | `1200` | Token budget for leaf summaries during assembly. |
| `condensedSummaryBudget` | `number` | `2000` | Token budget for condensed summaries during assembly. |
| `maxSummaryDepth` | `number` | `5` | Maximum depth of the summary hierarchy. |
| `summaryMaxOverageFactor` | `number` | `3` | Allowed multiplier for summary size before splitting. |
| `compactionBatchSize` | `number` | `10` | Number of messages to process in one compaction step. |
| `aggressiveThreshold` | `number` | `3` | Depth at which compaction becomes more aggressive. |
| `summarizeAfterMessages` | `number` | `20` | Trigger summarization after this many new messages. |
| `summarizeAfterTokens` | `number` | `20000` | Trigger summarization after this many new tokens. |
| `model` | `string` | `"anthropic:claude-sonnet-4-20250514"` | Model used for generating summaries. |

### Storage & Features
| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `dataDir` | `string` | `".lcm"` | Directory for storing database and large files. |
| `dbPath` | `string` | `".lcm/lcm.db"` | Path to the SQLite database file. |
| `enableIntegrity` | `boolean` | `true` | Enable background integrity checks for the DAG. |
| `enableFts` | `boolean` | `true` | Enable full-text search indexing. |
| `largeFileThreshold` | `number` | `50000` | Character limit before a message is treated as a large file. |

## Tools

### `lcm_grep`
Search the full conversation history (messages and summaries) using BM25 full-text search.

**Arguments:**
- `query` (string, required): The search terms.
- `limit` (number, optional): Maximum results to return (default: 10).
- `type` (enum, optional): What to search (`messages`, `summaries`, or `all`).

**Example:**
`lcm_grep(query="database migration error")`

### `lcm_describe`
Show the current state of the LCM system, including message counts, summary DAG structure, and token budget usage.

**Arguments:** None.

**Example:**
`lcm_describe()`

### `lcm_expand_query`
Retrieve the full content of a specific summary, message range, or search result.

**Arguments:**
- `target` (string, required): A summary UUID, a message range (e.g., `messages:10-25`), or a search query.
- `format` (enum, optional): Output verbosity (`full` or `condensed`).

**Example:**
`lcm_expand_query(target="messages:100-120")`

## Commands

- `/lcm_new`: Start a fresh session. This generates a new session ID and clears the active history.
- `/lcm_reset`: Alias for `/lcm_new`. Resets the current session state.

## Architecture

LCM is built around a modular architecture designed for reliability and performance:

- **Persistence Layer**: Uses SQLite for robust message and summary storage.
- **DAG Engine**: Manages the hierarchical relationships between summaries and their source messages.
- **Compaction Engine**: Determines when and how to summarize based on token pressure.
- **Context Assembler**: Intelligently selects items from the DAG and fresh tail to construct the LLM prompt.

### The Summary DAG
The core of LCM is the Directed Acyclic Graph:
- **Leaf Summaries (Depth 0)**: Direct summaries of a small batch of messages.
- **Condensed Summaries (Depth 1+)**: Summaries of multiple lower-level summaries.
- **Root Synopsis**: A high-level overview of the entire conversation.

### Compaction Levels
1.  **Normal**: Standard hierarchical summarization.
2.  **Aggressive**: Increased compression ratios when approaching hard limits.
3.  **Deterministic Truncation**: A safety fallback that removes the oldest summaries if the hard limit is exceeded.

For more details, see the [LCM Paper](https://arxiv.org/abs/2502.14258).

## Troubleshooting

- **Plugin doesn't activate**: Ensure `lossless-opencode` is correctly added to the `plugins` array in `~/.config/opencode/config.json`.
- **Native compaction still fires**: If OpenCode's built-in compaction triggers, try increasing `maxContextTokens` or `softTokenThreshold` in your LCM config.
- **FTS search returns nothing**: Verify that `enableFts` is set to `true` (default). If issues persist, a session reset may be required.
- **Summaries seem too aggressive**: If summaries lose too much detail, increase `summarizeAfterMessages` or `summarizeAfterTokens` to allow for larger context windows before summarization.

## Development

Install dependencies:
```bash
bun install
```

Run tests:
```bash
bun test
```

Type check:
```bash
bun run typecheck
```

### Project Structure
- `src/`: Source code (TypeScript).
- `tests/`: Comprehensive test suite (169 tests).
- `.lcm/`: Default runtime directory for database and storage.

## Credits

- **LCM Paper**: "Lossless Context Management for Agentic AI" — Ehrlich & Blackman, Voltropy PBC ([arXiv](https://arxiv.org/abs/2502.14258))
- **Reference Implementation**: [lossless-claw](https://github.com/martian-engineering/lossless-claw) by Martian Engineering.
- **OpenCode Plugin SDK**: [@opencode-ai/plugin](https://opencode.ai/docs/plugins).
