import type { Database } from "bun:sqlite";
import { assembleContext, estimateContextTokens } from "../context/assembler";
import { rebuildIndex } from "../search/indexer";
import {
  DEFAULT_CONFIG,
  type IntegrityCheck,
  type IntegrityReport,
  type LcmConfig,
} from "../types";

interface SequenceRow {
  sequence_number: number;
}

interface OrphanSummaryMessageRow {
  summary_id: string;
  message_id: string;
}

interface SummaryParentRow {
  parent_id: string;
  child_id: string;
}

interface DepthMismatchRow {
  parent_id: string;
  child_id: string;
  parent_depth: number;
  child_depth: number;
}

interface IsolatedSummaryRow {
  id: string;
  depth: number;
}

interface CountRow {
  count: number;
}

interface LargeFileMismatchRow {
  id: string;
  message_id: string;
}

const CHECK_NAMES = {
  messageOrdering: "message-ordering",
  summaryCoverage: "summary-coverage",
  dagAcyclicity: "dag-acyclicity",
  depthConsistency: "depth-consistency",
  orphanDetection: "orphan-detection",
  tokenBudget: "token-budget",
  ftsSync: "fts-sync",
  largeFileConsistency: "large-file-consistency",
} as const;

function passCheck(name: string, message: string, details?: string): IntegrityCheck {
  return { name, status: "pass", message, details };
}

function failCheck(name: string, message: string, details?: string): IntegrityCheck {
  return { name, status: "fail", message, details };
}

function warnCheck(name: string, message: string, details?: string): IntegrityCheck {
  return { name, status: "warn", message, details };
}

function formatPreview(values: string[], limit = 5): string {
  if (values.length <= limit) {
    return values.join(", ");
  }

  return `${values.slice(0, limit).join(", ")} (+${values.length - limit} more)`;
}

function getRelevantOrphanSummaryMessageRows(
  db: Database,
  conversationId: string,
): OrphanSummaryMessageRow[] {
  const missingMessages = db
    .query<OrphanSummaryMessageRow, [string, string]>(
      `SELECT sm.summary_id, sm.message_id
       FROM summary_messages sm
       JOIN summaries s ON s.id = sm.summary_id
       LEFT JOIN messages m ON m.id = sm.message_id
       WHERE s.conversation_id = ?
         AND (m.id IS NULL OR m.conversation_id != ?)`,
    )
    .all(conversationId, conversationId);

  const missingSummaries = db
    .query<OrphanSummaryMessageRow, [string]>(
      `SELECT sm.summary_id, sm.message_id
       FROM summary_messages sm
       LEFT JOIN summaries s ON s.id = sm.summary_id
       JOIN messages m ON m.id = sm.message_id
       WHERE s.id IS NULL
         AND m.conversation_id = ?`,
    )
    .all(conversationId);

  const rows = new Map<string, OrphanSummaryMessageRow>();
  for (const row of [...missingMessages, ...missingSummaries]) {
    rows.set(`${row.summary_id}:${row.message_id}`, row);
  }

  return Array.from(rows.values());
}

function checkMessageOrdering(db: Database, conversationId: string): IntegrityCheck {
  const rows = db
    .query<SequenceRow, [string]>(
      `SELECT sequence_number
       FROM messages
       WHERE conversation_id = ?
       ORDER BY sequence_number ASC`,
    )
    .all(conversationId);

  for (let index = 0; index < rows.length; index += 1) {
    const expected = index + 1;
    const actual = rows[index]?.sequence_number;

    if (actual !== expected) {
      return failCheck(
        CHECK_NAMES.messageOrdering,
        `Found a message sequence gap at position ${expected}.`,
        `Expected sequence ${expected}, found ${actual}.`,
      );
    }
  }

  return passCheck(
    CHECK_NAMES.messageOrdering,
    `Validated ${rows.length} messages with contiguous sequence numbers.`,
  );
}

function checkSummaryCoverage(db: Database, conversationId: string): IntegrityCheck {
  const orphanRows = getRelevantOrphanSummaryMessageRows(db, conversationId);

  if (orphanRows.length > 0) {
    return failCheck(
      CHECK_NAMES.summaryCoverage,
      `Found ${orphanRows.length} orphaned summary_messages rows.`,
      formatPreview(orphanRows.map((row) => `${row.summary_id}->${row.message_id}`)),
    );
  }

  const countRow = db
    .query<CountRow, [string, string]>(
      `SELECT COUNT(*) AS count
       FROM summary_messages sm
       JOIN summaries s ON s.id = sm.summary_id
       JOIN messages m ON m.id = sm.message_id
       WHERE s.conversation_id = ?
         AND m.conversation_id = ?`,
    )
    .get(conversationId, conversationId);

  return passCheck(
    CHECK_NAMES.summaryCoverage,
    `Validated ${countRow?.count ?? 0} summary-to-message links.`,
  );
}

function detectCycle(relations: SummaryParentRow[]): string[] | null {
  const adjacency = new Map<string, string[]>();
  const nodeIds = new Set<string>();

  for (const relation of relations) {
    nodeIds.add(relation.parent_id);
    nodeIds.add(relation.child_id);
    const children = adjacency.get(relation.parent_id) ?? [];
    children.push(relation.child_id);
    adjacency.set(relation.parent_id, children);
  }

  const visited = new Set<string>();
  const inPath = new Set<string>();
  const path: string[] = [];

  const visit = (nodeId: string): string[] | null => {
    visited.add(nodeId);
    inPath.add(nodeId);
    path.push(nodeId);

    const children = adjacency.get(nodeId) ?? [];
    for (const childId of children) {
      if (inPath.has(childId)) {
        const cycleStart = path.indexOf(childId);
        return [...path.slice(cycleStart), childId];
      }

      if (!visited.has(childId)) {
        const cycle = visit(childId);
        if (cycle) {
          return cycle;
        }
      }
    }

    path.pop();
    inPath.delete(nodeId);
    return null;
  };

  for (const nodeId of nodeIds) {
    if (visited.has(nodeId)) {
      continue;
    }

    const cycle = visit(nodeId);
    if (cycle) {
      return cycle;
    }
  }

  return null;
}

function checkDagAcyclicity(db: Database, conversationId: string): IntegrityCheck {
  const relations = db
    .query<SummaryParentRow, [string, string]>(
      `SELECT sp.parent_id, sp.child_id
       FROM summary_parents sp
       JOIN summaries parent_summary ON parent_summary.id = sp.parent_id
       JOIN summaries child_summary ON child_summary.id = sp.child_id
       WHERE parent_summary.conversation_id = ?
         AND child_summary.conversation_id = ?`,
    )
    .all(conversationId, conversationId);

  const cycle = detectCycle(relations);
  if (cycle) {
    return failCheck(
      CHECK_NAMES.dagAcyclicity,
      "Detected a cycle in summary_parents.",
      cycle.join(" -> "),
    );
  }

  return passCheck(
    CHECK_NAMES.dagAcyclicity,
    `Validated ${relations.length} parent-child summary edges without cycles.`,
  );
}

function checkDepthConsistency(db: Database, conversationId: string): IntegrityCheck {
  const mismatches = db
    .query<DepthMismatchRow, [string, string]>(
      `SELECT sp.parent_id,
              sp.child_id,
              parent_summary.depth AS parent_depth,
              child_summary.depth AS child_depth
       FROM summary_parents sp
       JOIN summaries parent_summary ON parent_summary.id = sp.parent_id
       JOIN summaries child_summary ON child_summary.id = sp.child_id
       WHERE parent_summary.conversation_id = ?
         AND child_summary.conversation_id = ?
         AND parent_summary.depth != child_summary.depth + 1`,
    )
    .all(conversationId, conversationId);

  if (mismatches.length > 0) {
    return failCheck(
      CHECK_NAMES.depthConsistency,
      `Found ${mismatches.length} depth inconsistencies in summary_parents.`,
      formatPreview(
        mismatches.map(
          (row) =>
            `${row.parent_id}(${row.parent_depth}) -> ${row.child_id}(${row.child_depth})`,
        ),
      ),
    );
  }

  return passCheck(
    CHECK_NAMES.depthConsistency,
    "All summary parent-child depth relationships are consistent.",
  );
}

function checkOrphanDetection(db: Database, conversationId: string): IntegrityCheck {
  const summaryCount =
    db
      .query<CountRow, [string]>(
        "SELECT COUNT(*) AS count FROM summaries WHERE conversation_id = ?",
      )
      .get(conversationId)?.count ?? 0;

  const isolatedSummaries = db
    .query<IsolatedSummaryRow, [string]>(
      `SELECT s.id, s.depth
       FROM summaries s
       WHERE s.conversation_id = ?
         AND s.id NOT IN (SELECT child_id FROM summary_parents)
         AND s.id NOT IN (SELECT parent_id FROM summary_parents)
       ORDER BY s.created_at ASC`,
    )
    .all(conversationId)
    .filter(() => summaryCount > 1);

  const orphanRows = getRelevantOrphanSummaryMessageRows(db, conversationId).filter(
    (row) =>
      db
        .query<CountRow, [string, string]>(
          "SELECT COUNT(*) AS count FROM messages WHERE id = ? AND conversation_id = ?",
        )
        .get(row.message_id, conversationId)?.count === 0,
  );

  if (isolatedSummaries.length > 0 || orphanRows.length > 0) {
    const detailParts: string[] = [];
    if (isolatedSummaries.length > 0) {
      detailParts.push(
        `isolated summaries: ${formatPreview(
          isolatedSummaries.map((summary) => `${summary.id}(depth=${summary.depth})`),
        )}`,
      );
    }
    if (orphanRows.length > 0) {
      detailParts.push(
        `broken summary_messages refs: ${formatPreview(
          orphanRows.map((row) => `${row.summary_id}->${row.message_id}`),
        )}`,
      );
    }

    return failCheck(
      CHECK_NAMES.orphanDetection,
      "Detected isolated summaries or orphaned message references.",
      detailParts.join("; "),
    );
  }

  return passCheck(
    CHECK_NAMES.orphanDetection,
    "No isolated summaries or orphaned message references detected.",
  );
}

function checkTokenBudget(
  db: Database,
  conversationId: string,
  config: LcmConfig,
): IntegrityCheck {
  const contextItems = assembleContext(db, config, conversationId);
  const totalTokens = estimateContextTokens(contextItems);

  if (totalTokens > config.maxContextTokens) {
    return failCheck(
      CHECK_NAMES.tokenBudget,
      `Assembled context exceeds token budget by ${totalTokens - config.maxContextTokens} tokens.`,
      `estimated=${totalTokens}, max=${config.maxContextTokens}`,
    );
  }

  return passCheck(
    CHECK_NAMES.tokenBudget,
    `Assembled context stays within budget at ${totalTokens}/${config.maxContextTokens} tokens.`,
  );
}

function checkFtsSync(db: Database, conversationId: string): IntegrityCheck {
  const messageCount =
    db
      .query<CountRow, [string]>(
        "SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?",
      )
      .get(conversationId)?.count ?? 0;

  const ftsCount =
    db
      .query<CountRow, []>("SELECT COUNT(*) AS count FROM messages_fts")
      .get()?.count ?? 0;

  const searchableCount =
    db
      .query<CountRow, []>("SELECT COUNT(*) AS count FROM messages_fts_docsize")
      .get()?.count ?? 0;

  if (ftsCount !== messageCount || searchableCount !== messageCount) {
    return failCheck(
      CHECK_NAMES.ftsSync,
      `Message FTS index is out of sync for conversation ${conversationId}.`,
      `messages=${messageCount}, messages_fts=${ftsCount}, searchable=${searchableCount}`,
    );
  }

  return passCheck(
    CHECK_NAMES.ftsSync,
    `Message FTS index is synchronized at ${messageCount} rows.`,
  );
}

function checkLargeFileConsistency(db: Database, conversationId: string): IntegrityCheck {
  const mismatches = db
    .query<LargeFileMismatchRow, [string, string]>(
      `SELECT lf.id, lf.message_id
       FROM large_files lf
       LEFT JOIN messages m ON m.id = lf.message_id
       WHERE lf.conversation_id = ?
         AND lf.message_id IS NOT NULL
         AND (m.id IS NULL OR m.conversation_id != ?)`,
    )
    .all(conversationId, conversationId);

  if (mismatches.length > 0) {
    return failCheck(
      CHECK_NAMES.largeFileConsistency,
      `Found ${mismatches.length} large_files rows referencing missing messages.`,
      formatPreview(mismatches.map((row) => `${row.id}->${row.message_id}`)),
    );
  }

  return passCheck(
    CHECK_NAMES.largeFileConsistency,
    "All large file references point to existing messages.",
  );
}

function safelyRunCheck(name: string, fn: () => IntegrityCheck): IntegrityCheck {
  try {
    return fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return warnCheck(name, "Integrity check could not be completed.", message);
  }
}

export function runIntegrityChecks(
  db: Database,
  conversationId: string,
  config: LcmConfig = DEFAULT_CONFIG,
): IntegrityReport {
  const checks = [
    safelyRunCheck(CHECK_NAMES.messageOrdering, () => checkMessageOrdering(db, conversationId)),
    safelyRunCheck(CHECK_NAMES.summaryCoverage, () => checkSummaryCoverage(db, conversationId)),
    safelyRunCheck(CHECK_NAMES.dagAcyclicity, () => checkDagAcyclicity(db, conversationId)),
    safelyRunCheck(CHECK_NAMES.depthConsistency, () => checkDepthConsistency(db, conversationId)),
    safelyRunCheck(CHECK_NAMES.orphanDetection, () => checkOrphanDetection(db, conversationId)),
    safelyRunCheck(CHECK_NAMES.tokenBudget, () => checkTokenBudget(db, conversationId, config)),
    safelyRunCheck(CHECK_NAMES.ftsSync, () => checkFtsSync(db, conversationId)),
    safelyRunCheck(CHECK_NAMES.largeFileConsistency, () =>
      checkLargeFileConsistency(db, conversationId),
    ),
  ];

  return {
    checks,
    passed: checks.filter((check) => check.status === "pass").length,
    failed: checks.filter((check) => check.status === "fail").length,
    warnings: checks.filter((check) => check.status === "warn").length,
  };
}

export function autoRepair(
  db: Database,
  conversationId: string,
  report: IntegrityReport,
): string[] {
  const actions: string[] = [];
  const failedChecks = new Set(
    report.checks.filter((check) => check.status === "fail").map((check) => check.name),
  );

  if (failedChecks.has(CHECK_NAMES.summaryCoverage)) {
    const result = db
      .query<{ deleted: number }, [string, string, string]>(
        `WITH orphan_rows AS (
           SELECT sm.rowid AS rowid
           FROM summary_messages sm
           LEFT JOIN summaries s ON s.id = sm.summary_id
           LEFT JOIN messages m ON m.id = sm.message_id
           WHERE (s.conversation_id = ? AND (m.id IS NULL OR m.conversation_id != ?))
              OR (m.conversation_id = ? AND s.id IS NULL)
         )
         DELETE FROM summary_messages
         WHERE rowid IN (SELECT rowid FROM orphan_rows)
         RETURNING 1 AS deleted`,
      )
      .all(conversationId, conversationId, conversationId);

    if (result.length > 0) {
      actions.push(`Deleted ${result.length} orphaned summary_messages rows.`);
    }
  }

  if (failedChecks.has(CHECK_NAMES.ftsSync)) {
    rebuildIndex(db, conversationId);
    actions.push("Rebuilt full-text indexes.");
  }

  return actions;
}
