import Anthropic from '@anthropic-ai/sdk';
import type { StorageAdapter } from '../storage/base.js';

/**
 * Extract structured facts about the user from recent conversation turns.
 *
 * Uses Claude to analyse the latest turns and identify facts such as the user's
 * name, preferences, goals, technical skills, and decisions. Facts are upserted
 * into the facts table so they persist across sessions.
 *
 * @param recentTurnsCount  How many recent turns to analyse (default 20).
 */
export async function extract(
  storage: StorageAdapter,
  client: Anthropic,
  userId: string,
  model: string,
  recentTurnsCount: number = 20
): Promise<void> {
  const turns = await storage.getTurns(userId, {
    limit: recentTurnsCount,
    includeCompressed: false,
  });

  if (turns.length === 0) return;

  const conversationText = turns
    .map((t) => `${t.role.toUpperCase()}: ${t.content}`)
    .join('\n\n');

  const response = await client.messages.create({
    model,
    max_tokens: 512,
    system:
      'You are a fact-extraction system. Analyse a conversation and return a JSON object ' +
      'containing key-value pairs of facts about the USER only (not the assistant). ' +
      'Keys should be snake_case descriptors (e.g. "name", "preferred_language", "timezone", ' +
      '"current_goal", "expertise_level"). Values must be strings. ' +
      'Only include facts that are explicitly stated or strongly implied. ' +
      'Return ONLY the JSON object — no markdown, no explanation.',
    messages: [
      {
        role: 'user',
        content: `Extract user facts from this conversation:\n\n${conversationText}`,
      },
    ],
  });

  const firstContent = response.content[0];
  if (firstContent.type !== 'text') return;

  let facts: Record<string, unknown>;

  // Attempt to parse JSON, with a fallback that extracts the first {...} block
  try {
    facts = JSON.parse(firstContent.text) as Record<string, unknown>;
  } catch {
    const match = firstContent.text.match(/\{[\s\S]*?\}/);
    if (!match) return;
    try {
      facts = JSON.parse(match[0]) as Record<string, unknown>;
    } catch {
      return;
    }
  }

  const source = `turns:${turns.map((t) => t.id).join(',')}`;

  for (const [key, value] of Object.entries(facts)) {
    if (typeof value === 'string' && value.trim().length > 0) {
      await storage.upsertFact(userId, key.trim(), value.trim(), 1.0, source);
    }
  }
}
