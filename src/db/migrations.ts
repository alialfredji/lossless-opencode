import type { Database } from "bun:sqlite";

interface Migration {
  version: number;
  up: (db: Database) => void;
}

const migrations: Migration[] = [
  {
    version: 1,
    up(db) {
      db.exec(`
        CREATE TABLE conversations (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          archived INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE messages (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES conversations(id),
          role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system', 'tool')),
          content TEXT NOT NULL,
          token_count INTEGER NOT NULL,
          sequence_number INTEGER NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(conversation_id, sequence_number)
        );

        CREATE TABLE message_parts (
          id TEXT PRIMARY KEY,
          message_id TEXT NOT NULL REFERENCES messages(id),
          part_type TEXT NOT NULL,
          content TEXT NOT NULL,
          sequence_number INTEGER NOT NULL
        );

        CREATE TABLE summaries (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES conversations(id),
          depth INTEGER NOT NULL DEFAULT 0,
          content TEXT NOT NULL,
          token_count INTEGER NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          compaction_level TEXT NOT NULL DEFAULT 'normal'
        );

        CREATE TABLE summary_parents (
          child_id TEXT NOT NULL REFERENCES summaries(id),
          parent_id TEXT NOT NULL REFERENCES summaries(id),
          PRIMARY KEY (child_id, parent_id)
        );

        CREATE TABLE summary_messages (
          summary_id TEXT NOT NULL REFERENCES summaries(id),
          message_id TEXT NOT NULL REFERENCES messages(id),
          PRIMARY KEY (summary_id, message_id)
        );

        CREATE TABLE context_items (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES conversations(id),
          item_type TEXT NOT NULL CHECK(item_type IN ('summary', 'message', 'system')),
          reference_id TEXT NOT NULL,
          depth INTEGER NOT NULL DEFAULT 0,
          position INTEGER NOT NULL,
          UNIQUE(conversation_id, position)
        );

        CREATE TABLE large_files (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES conversations(id),
          message_id TEXT REFERENCES messages(id),
          placeholder TEXT NOT NULL UNIQUE,
          original_path TEXT,
          token_count INTEGER NOT NULL,
          structural_summary TEXT,
          content TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX idx_messages_conversation ON messages(conversation_id, sequence_number);
        CREATE INDEX idx_summaries_depth ON summaries(depth);
        CREATE INDEX idx_summaries_conversation ON summaries(conversation_id);
        CREATE INDEX idx_summary_messages_message ON summary_messages(message_id);
        CREATE INDEX idx_context_items_conversation ON context_items(conversation_id, position);
        CREATE INDEX idx_large_files_conversation ON large_files(conversation_id);
      `);
    },
  },
  {
    version: 2,
    up(db) {
      db.exec(`
        CREATE VIRTUAL TABLE messages_fts USING fts5(content, content=messages, content_rowid=rowid);
        CREATE VIRTUAL TABLE summaries_fts USING fts5(content, content=summaries, content_rowid=rowid);

        CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
          INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
        END;
        CREATE TRIGGER summaries_ai AFTER INSERT ON summaries BEGIN
          INSERT INTO summaries_fts(rowid, content) VALUES (new.rowid, new.content);
        END;
      `);
    },
  },
];

export function runMigrations(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lcm_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const applied = new Set(
    (db.query("SELECT version FROM lcm_migrations").all() as { version: number }[]).map(
      (r) => r.version,
    ),
  );

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;

    db.transaction(() => {
      migration.up(db);
      db.exec(`INSERT INTO lcm_migrations(version) VALUES(${migration.version})`);
    })();
  }
}
