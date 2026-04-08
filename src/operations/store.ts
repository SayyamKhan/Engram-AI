import type { MessageRole, MessageTurn } from '../memory.js';
import type { StorageAdapter } from '../storage/base.js';
import { estimateTokens } from '../utils/tokens.js';

export interface StoreOptions {
  userId: string;
  sessionId: string;
  role: MessageRole;
  content: string;
}

/**
 * Store a conversation turn in persistent memory.
 * Automatically estimates and records the token count.
 *
 * @returns The ID assigned to the stored turn.
 */
export async function store(
  storage: StorageAdapter,
  options: StoreOptions
): Promise<number> {
  const turn: Omit<MessageTurn, 'id'> = {
    userId: options.userId,
    sessionId: options.sessionId,
    role: options.role,
    content: options.content,
    timestamp: Date.now(),
    tokenCount: estimateTokens(options.content),
    compressed: false,
  };

  return storage.storeTurn(turn);
}
