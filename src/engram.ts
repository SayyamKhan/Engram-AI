import Anthropic from '@anthropic-ai/sdk';
import type {
  EngramConfig,
  EngramStats,
  InjectedMessages,
  MemoryFact,
  MessageRole,
  MessageTurn,
} from './memory.js';
import type { StorageAdapter } from './storage/base.js';
import { SQLiteStorage } from './storage/sqlite.js';
import { PostgresStorage } from './storage/postgres.js';
import { store } from './operations/store.js';
import { retrieve } from './operations/retrieve.js';
import { compress } from './operations/compress.js';
import { extract } from './operations/extract.js';
import { inject } from './operations/inject.js';

/** Resolved configuration with all defaults applied. */
interface ResolvedConfig {
  apiKey: string;
  userId: string;
  storage: 'sqlite' | 'postgres';
  dbPath: string;
  postgresUrl: string;
  maxTokensBeforeCompress: number;
  maxInjectTokens: number;
  extractFacts: boolean;
  model: string;
  sessionId: string;
}

/**
 * Engram — persistent memory for Claude AI.
 *
 * Drop Engram into any Claude-powered application and your users will never
 * lose context again. Engram stores conversation history, extracts structured
 * facts, compresses old turns, and automatically injects the right context
 * into every new request.
 *
 * @example
 * ```ts
 * const engram = new Engram({
 *   apiKey: process.env.ANTHROPIC_API_KEY!,
 *   userId: 'user_123',
 * });
 *
 * await engram.store({ role: 'user', content: "I'm Alice, I love Python." });
 * await engram.store({ role: 'assistant', content: 'Nice to meet you, Alice!' });
 *
 * const { messages, systemContext } = await engram.inject('What language do I use?');
 *
 * const reply = await anthropic.messages.create({
 *   model: 'claude-sonnet-4-6',
 *   max_tokens: 1024,
 *   system: systemContext,
 *   messages,
 * });
 * ```
 */
export class Engram {
  private readonly client: Anthropic;
  private readonly storage: StorageAdapter;
  private readonly config: ResolvedConfig;
  private initialized = false;

  constructor(config: EngramConfig) {
    this.config = {
      storage: 'sqlite',
      dbPath: process.env['ENGRAM_DB_PATH'] ?? './engram.db',
      postgresUrl: '',
      maxTokensBeforeCompress: Number(process.env['ENGRAM_MAX_TOKENS'] ?? 4000),
      maxInjectTokens: 2000,
      extractFacts: true,
      model: 'claude-sonnet-4-6',
      sessionId: `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      ...config,
    };

    this.client = new Anthropic({ apiKey: this.config.apiKey });

    this.storage =
      this.config.storage === 'postgres'
        ? new PostgresStorage(this.config.postgresUrl || undefined)
        : new SQLiteStorage(this.config.dbPath);
  }

  /** @internal Lazily initialise the storage backend. */
  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.storage.initialize();
      this.initialized = true;
    }
  }

  /**
   * Store a conversation turn in persistent memory.
   *
   * Call this after every user message and assistant response to keep
   * Engram's history up to date.
   *
   * @returns The internal ID of the stored turn.
   */
  async store(message: { role: MessageRole; content: string }): Promise<number> {
    await this.ensureInitialized();
    return store(this.storage, {
      userId: this.config.userId,
      sessionId: this.config.sessionId,
      role: message.role,
      content: message.content,
    });
  }

  /**
   * Build a memory-injected messages array for the next Claude API call.
   *
   * Returns `{ messages, systemContext }`. Pass `systemContext` as the
   * `system` parameter and `messages` as the `messages` parameter.
   *
   * @param userMessage  The new message the user just sent.
   */
  async inject(userMessage: string): Promise<InjectedMessages> {
    await this.ensureInitialized();
    return inject(this.storage, this.config.userId, userMessage, this.config.maxInjectTokens);
  }

  /**
   * Compress old turns into a summary using Claude.
   *
   * Triggered automatically when total token count exceeds
   * `maxTokensBeforeCompress`. Can also be called manually.
   *
   * @returns `true` if compression was performed.
   */
  async compress(): Promise<boolean> {
    await this.ensureInitialized();
    return compress(
      this.storage,
      this.client,
      this.config.userId,
      this.config.sessionId,
      this.config.model,
      this.config.maxTokensBeforeCompress
    );
  }

  /**
   * Extract and persist structured facts about the user from recent turns.
   *
   * Facts are accumulated across sessions and injected into every future
   * request. Call this after storing new turns, or automate it via
   * `extractFacts: true` (default).
   */
  async extract(): Promise<void> {
    await this.ensureInitialized();
    return extract(this.storage, this.client, this.config.userId, this.config.model);
  }

  /**
   * Search stored memories by keyword.
   *
   * Uses relevance scoring (keyword overlap + recency) to rank results.
   *
   * @param query  Natural-language search query.
   * @param topN   Maximum number of results (default 10).
   */
  async search(query: string, topN: number = 10): Promise<MessageTurn[]> {
    await this.ensureInitialized();
    return retrieve(this.storage, this.config.userId, query, topN);
  }

  /**
   * Retrieve all extracted facts for this user.
   */
  async getFacts(): Promise<MemoryFact[]> {
    await this.ensureInitialized();
    return this.storage.getFacts(this.config.userId);
  }

  /**
   * Delete all stored memory for this user (turns, facts, summaries).
   * This action is irreversible.
   */
  async clear(): Promise<void> {
    await this.ensureInitialized();
    return this.storage.clearUser(this.config.userId);
  }

  /**
   * Return aggregate statistics for this user's memory.
   */
  async stats(): Promise<EngramStats> {
    await this.ensureInitialized();
    return this.storage.getStats(this.config.userId);
  }

  /**
   * Close the underlying storage connection.
   * Call this when your application shuts down.
   */
  async close(): Promise<void> {
    if (this.initialized) {
      await this.storage.close();
      this.initialized = false;
    }
  }

  /** The active session ID for this Engram instance. */
  get sessionId(): string {
    return this.config.sessionId;
  }

  /** The user ID this Engram instance manages memory for. */
  get userId(): string {
    return this.config.userId;
  }
}
