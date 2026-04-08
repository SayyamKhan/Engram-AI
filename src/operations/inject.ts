import type { InjectedMessages } from '../memory.js';
import type { StorageAdapter } from '../storage/base.js';
import { estimateTokens } from '../utils/tokens.js';

/**
 * Build a memory-injected messages array ready to send to the Claude API.
 *
 * This function:
 * 1. Assembles a system prompt containing extracted user facts and the latest
 *    conversation summary.
 * 2. Includes recent raw conversation turns up to the token budget.
 * 3. Appends the new user message.
 *
 * Pass the returned `systemContext` as the `system` parameter and `messages`
 * as the `messages` parameter in your `client.messages.create()` call.
 *
 * @param storage          - The storage adapter to query.
 * @param userId           - The user whose memory to inject.
 * @param userMessage      - The new message the user just sent.
 * @param maxInjectTokens  - Maximum tokens to budget for injected context.
 */
export async function inject(
  storage: StorageAdapter,
  userId: string,
  userMessage: string,
  maxInjectTokens: number
): Promise<InjectedMessages> {
  const [facts, latestSummary, recentTurns] = await Promise.all([
    storage.getFacts(userId),
    storage.getLatestSummary(userId),
    storage.getTurns(userId, { includeCompressed: false }),
  ]);

  // Build the system context from facts + latest summary
  const contextParts: string[] = [];

  if (facts.length > 0) {
    const factLines = facts
      .map((f) => `- ${f.key}: ${f.value}`)
      .join('\n');
    contextParts.push(`## Known User Facts\n${factLines}`);
  }

  if (latestSummary) {
    contextParts.push(`## Previous Conversation Summary\n${latestSummary.content}`);
  }

  const systemContext =
    contextParts.length > 0
      ? `[ENGRAM MEMORY]\n${contextParts.join('\n\n')}\n[/ENGRAM MEMORY]`
      : '';

  // Calculate how many tokens we have left for recent history
  const reservedTokens =
    estimateTokens(systemContext) + estimateTokens(userMessage) + 8;
  const historyBudget = Math.max(0, maxInjectTokens - reservedTokens);

  // Walk recent turns from oldest to newest, filling the budget from the end
  // (most recent turns are highest priority)
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  let usedTokens = 0;

  // Iterate in reverse (newest first) to fill budget, then reverse the result
  for (let i = recentTurns.length - 1; i >= 0; i--) {
    const turn = recentTurns[i];
    if (turn.role === 'system') continue; // system turns go to systemContext, not messages

    const turnTokens = turn.tokenCount + 4;
    if (usedTokens + turnTokens > historyBudget) break;

    messages.unshift({ role: turn.role as 'user' | 'assistant', content: turn.content });
    usedTokens += turnTokens;
  }

  // Append the new user message
  messages.push({ role: 'user', content: userMessage });

  return { messages, systemContext };
}
