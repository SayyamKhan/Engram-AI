/**
 * Core type definitions for Engram's memory system.
 */

export type MessageRole = 'user' | 'assistant' | 'system';

/** A single conversation turn stored in memory. */
export interface MessageTurn {
  id?: number;
  userId: string;
  sessionId: string;
  role: MessageRole;
  content: string;
  timestamp: number;
  tokenCount: number;
  compressed: boolean;
}

/** An extracted fact about a user, derived from conversation. */
export interface MemoryFact {
  id?: number;
  userId: string;
  key: string;
  value: string;
  confidence: number;
  timestamp: number;
  source: string;
}

/** A compressed summary of multiple conversation turns. */
export interface MemorySummary {
  id?: number;
  userId: string;
  sessionId: string;
  content: string;
  turnIds: number[];
  timestamp: number;
  tokenCount: number;
}

/** Configuration for an Engram instance. */
export interface EngramConfig {
  /** Anthropic API key (required). */
  apiKey: string;
  /** Unique identifier for the user whose memory is being managed (required). */
  userId: string;
  /** Storage backend. Defaults to 'sqlite'. */
  storage?: 'sqlite' | 'postgres';
  /** Path to the SQLite database file. Defaults to './engram.db'. */
  dbPath?: string;
  /** PostgreSQL connection string (used when storage is 'postgres'). */
  postgresUrl?: string;
  /** Token count threshold before automatic compression. Defaults to 4000. */
  maxTokensBeforeCompress?: number;
  /** Maximum tokens to inject into a new request. Defaults to 2000. */
  maxInjectTokens?: number;
  /** Whether to extract structured facts after each store. Defaults to true. */
  extractFacts?: boolean;
  /** Claude model to use for compress/extract operations. */
  model?: string;
  /** Session identifier. Auto-generated if not provided. */
  sessionId?: string;
}

/** Runtime stats for a user's memory. */
export interface EngramStats {
  userId: string;
  totalTurns: number;
  compressedTurns: number;
  activeTurns: number;
  totalFacts: number;
  totalSummaries: number;
  estimatedTokens: number;
}

/** The result of injecting memory context into a conversation. */
export interface InjectedMessages {
  /** Conversation messages including history, ready to send to Claude. */
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** System prompt containing facts and summaries. Pass as the `system` param. */
  systemContext: string;
}
