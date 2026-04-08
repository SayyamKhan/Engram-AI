/**
 * Token estimation utilities.
 *
 * Uses a character-based heuristic (~4 chars per token for English text),
 * which is accurate enough for budget calculations without requiring a
 * full tokenizer dependency.
 */

/** Estimate the token count of a string. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // Approximate: 4 characters ≈ 1 token for English text
  return Math.ceil(text.length / 4);
}

/** Estimate the total token count of an array of messages. */
export function estimateMessageTokens(
  messages: ReadonlyArray<{ role: string; content: string }>
): number {
  // Each message has ~4 overhead tokens for role/formatting
  return messages.reduce((total, msg) => total + estimateTokens(msg.content) + 4, 0);
}

/** Check whether a text string fits within a token budget. */
export function fitsInBudget(text: string, budget: number): boolean {
  return estimateTokens(text) <= budget;
}

/** Truncate text to fit within a token budget (word boundary). */
export function truncateToTokenBudget(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;

  // Truncate at word boundary
  const truncated = text.slice(0, maxChars);
  const lastSpace = truncated.lastIndexOf(' ');
  return lastSpace > 0 ? truncated.slice(0, lastSpace) + '...' : truncated + '...';
}
