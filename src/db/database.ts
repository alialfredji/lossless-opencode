import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";

export function createDatabase(dbPath: string): Database {
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);

  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec("PRAGMA busy_timeout=5000");

  return db;
}

export function closeDatabase(db: Database): void {
  db.close();
}
