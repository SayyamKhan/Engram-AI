import type { EngramStats, MemoryFact, MemorySummary, MessageTurn } from '../memory.js';

/** Options for querying turns. */
export interface GetTurnsOptions {
  /** Maximum number of turns to return. */
  limit?: number;
  /** If true, include turns that have already been compressed. Defaults to false. */
  includeCompressed?: boolean;
  /** Filter turns to a specific session. */
  sessionId?: string;
}

/**
 * Abstract storage adapter interface.
 * Implement this to add new storage backends (Redis, DynamoDB, etc.).
 */
export interface StorageAdapter {
  /** Initialize the storage backend (create tables, run migrations, etc.). */
  initialize(): Promise<void>;

  /** Close connections and release resources. */
  close(): Promise<void>;

  // ── Turns ──────────────────────────────────────────────────────────────────

  /** Persist a new conversation turn. Returns the assigned ID. */
  storeTurn(turn: Omit<MessageTurn, 'id'>): Promise<number>;

  /**
   * Retrieve turns for a user.
   * Results are ordered oldest → newest.
   */
  getTurns(userId: string, options?: GetTurnsOptions): Promise<MessageTurn[]>;

  /** Mark turns as compressed so they are excluded from future injection. */
  markTurnsCompressed(ids: number[]): Promise<void>;

  // ── Facts ──────────────────────────────────────────────────────────────────

  /** Store or update a user fact. */
  upsertFact(
    userId: string,
    key: string,
    value: string,
    confidence: number,
    source: string
  ): Promise<void>;

  /** Retrieve all facts for a user. */
  getFacts(userId: string): Promise<MemoryFact[]>;

  // ── Summaries ──────────────────────────────────────────────────────────────

  /** Persist a new compression summary. Returns the assigned ID. */
  storeSummary(summary: Omit<MemorySummary, 'id'>): Promise<number>;

  /** Retrieve all summaries for a user, ordered oldest → newest. */
  getSummaries(userId: string): Promise<MemorySummary[]>;

  /** Retrieve the most recent summary for a user, or null if none exist. */
  getLatestSummary(userId: string): Promise<MemorySummary | null>;

  // ── Search ─────────────────────────────────────────────────────────────────

  /**
   * Full-text keyword search across stored turns.
   * Returns results ordered by relevance.
   */
  searchTurns(userId: string, query: string, limit?: number): Promise<MessageTurn[]>;

  // ── Management ────────────────────────────────────────────────────────────

  /** Delete all memory data for a user. */
  clearUser(userId: string): Promise<void>;

  /** Return aggregate memory statistics for a user. */
  getStats(userId: string): Promise<EngramStats>;
}
