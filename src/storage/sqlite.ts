import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import type { GetTurnsOptions, StorageAdapter } from './base.js';
import type { EngramStats, MemoryFact, MemorySummary, MessageTurn } from '../memory.js';
import { relevanceScore } from '../utils/similarity.js';
import { estimateTokens } from '../utils/tokens.js';

// ── Row shapes returned by SQLite ────────────────────────────────────────────

interface TurnRow {
  id: number;
  userId: string;
  sessionId: string;
  role: string;
  content: string;
  timestamp: number;
  tokenCount: number;
  compressed: number;
}

interface FactRow {
  id: number;
  userId: string;
  key: string;
  value: string;
  confidence: number;
  timestamp: number;
  source: string;
}

interface SummaryRow {
  id: number;
  userId: string;
  sessionId: string;
  content: string;
  turnIds: string;
  timestamp: number;
  tokenCount: number;
}

interface StatsRow {
  totalTurns: number;
  compressedTurns: number;
  totalFacts: number;
  totalSummaries: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function rowToTurn(row: TurnRow): MessageTurn {
  return {
    id: row.id,
    userId: row.userId,
    sessionId: row.sessionId,
    role: row.role as MessageTurn['role'],
    content: row.content,
    timestamp: row.timestamp,
    tokenCount: row.tokenCount,
    compressed: row.compressed === 1,
  };
}

function rowToFact(row: FactRow): MemoryFact {
  return {
    id: row.id,
    userId: row.userId,
    key: row.key,
    value: row.value,
    confidence: row.confidence,
    timestamp: row.timestamp,
    source: row.source,
  };
}

function rowToSummary(row: SummaryRow): MemorySummary {
  return {
    id: row.id,
    userId: row.userId,
    sessionId: row.sessionId,
    content: row.content,
    turnIds: JSON.parse(row.turnIds) as number[],
    timestamp: row.timestamp,
    tokenCount: row.tokenCount,
  };
}

// ── SQLiteStorage ────────────────────────────────────────────────────────────

/**
 * SQLite-backed storage adapter using better-sqlite3.
 * Zero configuration — works out of the box with a local .db file.
 * Supports `:memory:` for in-memory databases (useful for testing).
 */
export class SQLiteStorage implements StorageAdapter {
  private db: DatabaseType;

  constructor(dbPath: string = './engram.db') {
    this.db = new Database(dbPath);
  }

  async initialize(): Promise<void> {
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('synchronous = NORMAL');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS turns (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        userId      TEXT    NOT NULL,
        sessionId   TEXT    NOT NULL,
        role        TEXT    NOT NULL,
        content     TEXT    NOT NULL,
        timestamp   INTEGER NOT NULL,
        tokenCount  INTEGER NOT NULL DEFAULT 0,
        compressed  INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_turns_user
        ON turns (userId, compressed, timestamp);

      CREATE TABLE IF NOT EXISTS facts (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        userId      TEXT    NOT NULL,
        key         TEXT    NOT NULL,
        value       TEXT    NOT NULL,
        confidence  REAL    NOT NULL DEFAULT 1.0,
        timestamp   INTEGER NOT NULL,
        source      TEXT    NOT NULL DEFAULT '',
        UNIQUE (userId, key)
      );

      CREATE INDEX IF NOT EXISTS idx_facts_user ON facts (userId);

      CREATE TABLE IF NOT EXISTS summaries (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        userId      TEXT    NOT NULL,
        sessionId   TEXT    NOT NULL,
        content     TEXT    NOT NULL,
        turnIds     TEXT    NOT NULL,
        timestamp   INTEGER NOT NULL,
        tokenCount  INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_summaries_user ON summaries (userId, timestamp);
    `);
  }

  async close(): Promise<void> {
    this.db.close();
  }

  // ── Turns ─────────────────────────────────────────────────────────────────

  async storeTurn(turn: Omit<MessageTurn, 'id'>): Promise<number> {
    const stmt = this.db.prepare(`
      INSERT INTO turns (userId, sessionId, role, content, timestamp, tokenCount, compressed)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      turn.userId,
      turn.sessionId,
      turn.role,
      turn.content,
      turn.timestamp,
      turn.tokenCount,
      turn.compressed ? 1 : 0
    );
    return result.lastInsertRowid as number;
  }

  async getTurns(userId: string, options: GetTurnsOptions = {}): Promise<MessageTurn[]> {
    const { limit, includeCompressed = false, sessionId } = options;

    let sql = 'SELECT * FROM turns WHERE userId = ?';
    const params: (string | number)[] = [userId];

    if (!includeCompressed) {
      sql += ' AND compressed = 0';
    }
    if (sessionId !== undefined) {
      sql += ' AND sessionId = ?';
      params.push(sessionId);
    }

    sql += ' ORDER BY timestamp ASC';

    if (limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(limit);
    }

    const rows = this.db.prepare(sql).all(...params) as TurnRow[];
    return rows.map(rowToTurn);
  }

  async markTurnsCompressed(ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(', ');
    this.db
      .prepare(`UPDATE turns SET compressed = 1 WHERE id IN (${placeholders})`)
      .run(...ids);
  }

  // ── Facts ─────────────────────────────────────────────────────────────────

  async upsertFact(
    userId: string,
    key: string,
    value: string,
    confidence: number,
    source: string
  ): Promise<void> {
    this.db
      .prepare(`
        INSERT INTO facts (userId, key, value, confidence, timestamp, source)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (userId, key) DO UPDATE SET
          value      = excluded.value,
          confidence = excluded.confidence,
          timestamp  = excluded.timestamp,
          source     = excluded.source
      `)
      .run(userId, key, value, confidence, Date.now(), source);
  }

  async getFacts(userId: string): Promise<MemoryFact[]> {
    const rows = this.db
      .prepare('SELECT * FROM facts WHERE userId = ? ORDER BY timestamp DESC')
      .all(userId) as FactRow[];
    return rows.map(rowToFact);
  }

  // ── Summaries ─────────────────────────────────────────────────────────────

  async storeSummary(summary: Omit<MemorySummary, 'id'>): Promise<number> {
    const result = this.db
      .prepare(`
        INSERT INTO summaries (userId, sessionId, content, turnIds, timestamp, tokenCount)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        summary.userId,
        summary.sessionId,
        summary.content,
        JSON.stringify(summary.turnIds),
        summary.timestamp,
        summary.tokenCount
      );
    return result.lastInsertRowid as number;
  }

  async getSummaries(userId: string): Promise<MemorySummary[]> {
    const rows = this.db
      .prepare('SELECT * FROM summaries WHERE userId = ? ORDER BY timestamp ASC')
      .all(userId) as SummaryRow[];
    return rows.map(rowToSummary);
  }

  async getLatestSummary(userId: string): Promise<MemorySummary | null> {
    const row = this.db
      .prepare('SELECT * FROM summaries WHERE userId = ? ORDER BY timestamp DESC LIMIT 1')
      .get(userId) as SummaryRow | undefined;
    return row ? rowToSummary(row) : null;
  }

  // ── Search ────────────────────────────────────────────────────────────────

  async searchTurns(userId: string, query: string, limit: number = 10): Promise<MessageTurn[]> {
    const rows = this.db
      .prepare('SELECT * FROM turns WHERE userId = ? ORDER BY timestamp DESC')
      .all(userId) as TurnRow[];

    const turns = rows.map(rowToTurn);

    // Score and sort by relevance
    const scored = turns.map((turn) => ({
      turn,
      score: relevanceScore(query, turn.content, turn.timestamp),
    }));

    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, limit).map((s) => s.turn);
  }

  // ── Management ────────────────────────────────────────────────────────────

  async clearUser(userId: string): Promise<void> {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM turns WHERE userId = ?').run(userId);
      this.db.prepare('DELETE FROM facts WHERE userId = ?').run(userId);
      this.db.prepare('DELETE FROM summaries WHERE userId = ?').run(userId);
    })();
  }

  async getStats(userId: string): Promise<EngramStats> {
    const statsRow = this.db
      .prepare(`
        SELECT
          COUNT(*)                          AS totalTurns,
          SUM(CASE WHEN compressed = 1 THEN 1 ELSE 0 END) AS compressedTurns,
          (SELECT COUNT(*) FROM facts    WHERE userId = ?) AS totalFacts,
          (SELECT COUNT(*) FROM summaries WHERE userId = ?) AS totalSummaries
        FROM turns
        WHERE userId = ?
      `)
      .get(userId, userId, userId) as StatsRow;

    const activeTurns = (statsRow.totalTurns ?? 0) - (statsRow.compressedTurns ?? 0);

    // Estimate tokens for active turns
    const activeTurnRows = this.db
      .prepare('SELECT content FROM turns WHERE userId = ? AND compressed = 0')
      .all(userId) as Array<{ content: string }>;

    const estimatedTokens = activeTurnRows.reduce(
      (sum, row) => sum + estimateTokens(row.content),
      0
    );

    return {
      userId,
      totalTurns: statsRow.totalTurns ?? 0,
      compressedTurns: statsRow.compressedTurns ?? 0,
      activeTurns,
      totalFacts: statsRow.totalFacts ?? 0,
      totalSummaries: statsRow.totalSummaries ?? 0,
      estimatedTokens,
    };
  }
}
