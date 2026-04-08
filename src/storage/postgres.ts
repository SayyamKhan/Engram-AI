import pg from 'pg';
import type { GetTurnsOptions, StorageAdapter } from './base.js';
import type { EngramStats, MemoryFact, MemorySummary, MessageTurn } from '../memory.js';
import { relevanceScore } from '../utils/similarity.js';
import { estimateTokens } from '../utils/tokens.js';

const { Pool } = pg;

// ── Helpers ──────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PgRow = Record<string, any>;

function rowToTurn(row: PgRow): MessageTurn {
  return {
    id: row.id as number,
    userId: row.userid as string,
    sessionId: row.sessionid as string,
    role: row.role as MessageTurn['role'],
    content: row.content as string,
    timestamp: Number(row.timestamp),
    tokenCount: Number(row.tokencount),
    compressed: Boolean(row.compressed),
  };
}

function rowToFact(row: PgRow): MemoryFact {
  return {
    id: row.id as number,
    userId: row.userid as string,
    key: row.key as string,
    value: row.value as string,
    confidence: Number(row.confidence),
    timestamp: Number(row.timestamp),
    source: row.source as string,
  };
}

function rowToSummary(row: PgRow): MemorySummary {
  return {
    id: row.id as number,
    userId: row.userid as string,
    sessionId: row.sessionid as string,
    content: row.content as string,
    turnIds: row.turnids as number[],
    timestamp: Number(row.timestamp),
    tokenCount: Number(row.tokencount),
  };
}

// ── PostgresStorage ──────────────────────────────────────────────────────────

/**
 * PostgreSQL storage adapter.
 * Requires a running PostgreSQL server. Pass a connection URL or set PG* env vars.
 *
 * @example
 * const storage = new PostgresStorage('postgresql://user:pass@localhost:5432/engram');
 */
export class PostgresStorage implements StorageAdapter {
  private pool: pg.Pool;

  constructor(connectionString?: string) {
    this.pool = new Pool(
      connectionString ? { connectionString } : undefined
    );
  }

  async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS turns (
        id          SERIAL  PRIMARY KEY,
        "userId"    TEXT    NOT NULL,
        "sessionId" TEXT    NOT NULL,
        role        TEXT    NOT NULL,
        content     TEXT    NOT NULL,
        timestamp   BIGINT  NOT NULL,
        "tokenCount" INTEGER NOT NULL DEFAULT 0,
        compressed  BOOLEAN NOT NULL DEFAULT FALSE
      );

      CREATE INDEX IF NOT EXISTS idx_turns_user
        ON turns ("userId", compressed, timestamp);

      CREATE TABLE IF NOT EXISTS facts (
        id          SERIAL  PRIMARY KEY,
        "userId"    TEXT    NOT NULL,
        key         TEXT    NOT NULL,
        value       TEXT    NOT NULL,
        confidence  REAL    NOT NULL DEFAULT 1.0,
        timestamp   BIGINT  NOT NULL,
        source      TEXT    NOT NULL DEFAULT '',
        UNIQUE ("userId", key)
      );

      CREATE INDEX IF NOT EXISTS idx_facts_user ON facts ("userId");

      CREATE TABLE IF NOT EXISTS summaries (
        id          SERIAL  PRIMARY KEY,
        "userId"    TEXT    NOT NULL,
        "sessionId" TEXT    NOT NULL,
        content     TEXT    NOT NULL,
        "turnIds"   JSONB   NOT NULL,
        timestamp   BIGINT  NOT NULL,
        "tokenCount" INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_summaries_user ON summaries ("userId", timestamp);
    `);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  // ── Turns ─────────────────────────────────────────────────────────────────

  async storeTurn(turn: Omit<MessageTurn, 'id'>): Promise<number> {
    const result = await this.pool.query(
      `INSERT INTO turns ("userId", "sessionId", role, content, timestamp, "tokenCount", compressed)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [turn.userId, turn.sessionId, turn.role, turn.content, turn.timestamp, turn.tokenCount, turn.compressed]
    );
    return result.rows[0].id as number;
  }

  async getTurns(userId: string, options: GetTurnsOptions = {}): Promise<MessageTurn[]> {
    const { limit, includeCompressed = false, sessionId } = options;

    const conditions = [`"userId" = $1`];
    const params: (string | number | boolean)[] = [userId];
    let idx = 2;

    if (!includeCompressed) {
      conditions.push(`compressed = FALSE`);
    }
    if (sessionId !== undefined) {
      conditions.push(`"sessionId" = $${idx++}`);
      params.push(sessionId);
    }

    let sql = `SELECT * FROM turns WHERE ${conditions.join(' AND ')} ORDER BY timestamp ASC`;
    if (limit !== undefined) {
      sql += ` LIMIT $${idx}`;
      params.push(limit);
    }

    const result = await this.pool.query(sql, params);
    return result.rows.map((r) => rowToTurn(r as PgRow));
  }

  async markTurnsCompressed(ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
    await this.pool.query(
      `UPDATE turns SET compressed = TRUE WHERE id IN (${placeholders})`,
      ids
    );
  }

  // ── Facts ─────────────────────────────────────────────────────────────────

  async upsertFact(
    userId: string,
    key: string,
    value: string,
    confidence: number,
    source: string
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO facts ("userId", key, value, confidence, timestamp, source)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT ("userId", key) DO UPDATE SET
         value      = EXCLUDED.value,
         confidence = EXCLUDED.confidence,
         timestamp  = EXCLUDED.timestamp,
         source     = EXCLUDED.source`,
      [userId, key, value, confidence, Date.now(), source]
    );
  }

  async getFacts(userId: string): Promise<MemoryFact[]> {
    const result = await this.pool.query(
      `SELECT * FROM facts WHERE "userId" = $1 ORDER BY timestamp DESC`,
      [userId]
    );
    return result.rows.map((r) => rowToFact(r as PgRow));
  }

  // ── Summaries ─────────────────────────────────────────────────────────────

  async storeSummary(summary: Omit<MemorySummary, 'id'>): Promise<number> {
    const result = await this.pool.query(
      `INSERT INTO summaries ("userId", "sessionId", content, "turnIds", timestamp, "tokenCount")
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [summary.userId, summary.sessionId, summary.content, JSON.stringify(summary.turnIds), summary.timestamp, summary.tokenCount]
    );
    return result.rows[0].id as number;
  }

  async getSummaries(userId: string): Promise<MemorySummary[]> {
    const result = await this.pool.query(
      `SELECT * FROM summaries WHERE "userId" = $1 ORDER BY timestamp ASC`,
      [userId]
    );
    return result.rows.map((r) => rowToSummary(r as PgRow));
  }

  async getLatestSummary(userId: string): Promise<MemorySummary | null> {
    const result = await this.pool.query(
      `SELECT * FROM summaries WHERE "userId" = $1 ORDER BY timestamp DESC LIMIT 1`,
      [userId]
    );
    return result.rows.length > 0 ? rowToSummary(result.rows[0] as PgRow) : null;
  }

  // ── Search ────────────────────────────────────────────────────────────────

  async searchTurns(userId: string, query: string, limit: number = 10): Promise<MessageTurn[]> {
    const result = await this.pool.query(
      `SELECT * FROM turns WHERE "userId" = $1 ORDER BY timestamp DESC`,
      [userId]
    );

    const turns = result.rows.map((r) => rowToTurn(r as PgRow));
    const scored = turns.map((turn) => ({
      turn,
      score: relevanceScore(query, turn.content, turn.timestamp),
    }));

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((s) => s.turn);
  }

  // ── Management ────────────────────────────────────────────────────────────

  async clearUser(userId: string): Promise<void> {
    await this.pool.query('DELETE FROM turns     WHERE "userId" = $1', [userId]);
    await this.pool.query('DELETE FROM facts     WHERE "userId" = $1', [userId]);
    await this.pool.query('DELETE FROM summaries WHERE "userId" = $1', [userId]);
  }

  async getStats(userId: string): Promise<EngramStats> {
    const [turnsResult, factsResult, summariesResult, activeResult] = await Promise.all([
      this.pool.query(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN compressed THEN 1 ELSE 0 END) AS compressed
         FROM turns WHERE "userId" = $1`,
        [userId]
      ),
      this.pool.query(`SELECT COUNT(*) AS total FROM facts     WHERE "userId" = $1`, [userId]),
      this.pool.query(`SELECT COUNT(*) AS total FROM summaries WHERE "userId" = $1`, [userId]),
      this.pool.query(
        `SELECT content FROM turns WHERE "userId" = $1 AND compressed = FALSE`,
        [userId]
      ),
    ]);

    const totalTurns     = Number(turnsResult.rows[0].total)      || 0;
    const compressedTurns = Number(turnsResult.rows[0].compressed) || 0;
    const totalFacts     = Number(factsResult.rows[0].total)      || 0;
    const totalSummaries = Number(summariesResult.rows[0].total)  || 0;

    const estimatedTokens = (activeResult.rows as Array<{ content: string }>).reduce(
      (sum, row) => sum + estimateTokens(row.content),
      0
    );

    return {
      userId,
      totalTurns,
      compressedTurns,
      activeTurns: totalTurns - compressedTurns,
      totalFacts,
      totalSummaries,
      estimatedTokens,
    };
  }
}
