/**
 * Engram — Persistent memory for Claude AI.
 *
 * @example
 * ```ts
 * import { Engram } from 'engram';
 *
 * const engram = new Engram({
 *   apiKey: process.env.ANTHROPIC_API_KEY!,
 *   userId: 'user_123',
 * });
 * ```
 *
 * @packageDocumentation
 */

// Main class
export { Engram } from './engram.js';

// Types
export type {
  EngramConfig,
  EngramStats,
  InjectedMessages,
  MemoryFact,
  MemorySummary,
  MessageRole,
  MessageTurn,
} from './memory.js';

// Storage adapters (for custom integrations)
export type { GetTurnsOptions, StorageAdapter } from './storage/base.js';
export { SQLiteStorage } from './storage/sqlite.js';
export { PostgresStorage } from './storage/postgres.js';

// Low-level operation functions (for advanced use cases)
export { store } from './operations/store.js';
export { retrieve } from './operations/retrieve.js';
export { compress } from './operations/compress.js';
export { extract } from './operations/extract.js';
export { inject } from './operations/inject.js';

// Utilities
export { estimateTokens, estimateMessageTokens, truncateToTokenBudget } from './utils/tokens.js';
export { keywordSimilarity, relevanceScore, tokenize } from './utils/similarity.js';
