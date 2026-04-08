import Anthropic from '@anthropic-ai/sdk';
import type { StorageAdapter } from '../storage/base.js';
import { estimateTokens } from '../utils/tokens.js';

/**
 * Compress old conversation turns into a single summary using Claude.
 *
 * When the total token count of active turns exceeds `maxTokensBeforeCompress`,
 * the oldest half of turns are summarised by Claude, stored as a summary entry,
 * and then marked as compressed so they are excluded from future injection.
 *
 * @returns `true` if compression was performed, `false` if not needed.
 */
export async function compress(
  storage: StorageAdapter,
  client: Anthropic,
  userId: string,
  sessionId: string,
  model: string,
  maxTokensBeforeCompress: number
): Promise<boolean> {
  const turns = await storage.getTurns(userId, { includeCompressed: false });
  if (turns.length === 0) return false;

  const totalTokens = turns.reduce((sum, t) => sum + t.tokenCount, 0);
  if (totalTokens <= maxTokensBeforeCompress) return false;

  // Compress the older half of turns, keeping the recent half as raw context
  const splitIndex = Math.max(1, Math.floor(turns.length / 2));
  const turnsToCompress = turns.slice(0, splitIndex);
  if (turnsToCompress.length === 0) return false;

  const conversationText = turnsToCompress
    .map((t) => `${t.role.toUpperCase()}: ${t.content}`)
    .join('\n\n');

  const response = await client.messages.create({
    model,
    max_tokens: 1024,
    system:
      'You are a conversation summarizer. Produce a concise but comprehensive summary ' +
      'that preserves all key facts, decisions, preferences, and important context. ' +
      'Write in third-person present tense. Be specific and include details that would ' +
      'help a future conversation continue seamlessly.',
    messages: [
      {
        role: 'user',
        content: `Please summarize the following conversation history:\n\n${conversationText}`,
      },
    ],
  });

  const firstContent = response.content[0];
  if (firstContent.type !== 'text') return false;

  const summaryText = firstContent.text;
  const turnIds = turnsToCompress.map((t) => t.id as number);

  await storage.storeSummary({
    userId,
    sessionId,
    content: summaryText,
    turnIds,
    timestamp: Date.now(),
    tokenCount: estimateTokens(summaryText),
  });

  await storage.markTurnsCompressed(turnIds);

  return true;
}
