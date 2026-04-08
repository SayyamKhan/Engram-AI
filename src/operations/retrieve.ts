import type { MessageTurn } from '../memory.js';
import type { StorageAdapter } from '../storage/base.js';
import { relevanceScore } from '../utils/similarity.js';

/**
 * Retrieve the most relevant past conversation turns for a given query.
 *
 * Scores each turn using a combination of keyword overlap and recency,
 * then returns the top-N results ordered by relevance descending.
 *
 * @param storage  - The storage adapter to query.
 * @param userId   - The user whose turns to search.
 * @param query    - The natural-language query to match against.
 * @param topN     - Maximum number of turns to return (default 10).
 */
export async function retrieve(
  storage: StorageAdapter,
  userId: string,
  query: string,
  topN: number = 10
): Promise<MessageTurn[]> {
  // Fetch all active (non-compressed) turns
  const turns = await storage.getTurns(userId, { includeCompressed: false });

  if (turns.length === 0) return [];

  // Score each turn for relevance to the query
  const scored = turns.map((turn) => ({
    turn,
    score: relevanceScore(query, turn.content, turn.timestamp),
  }));

  // Sort by score descending; break ties by recency
  scored.sort((a, b) => {
    const diff = b.score - a.score;
    if (Math.abs(diff) > 0.001) return diff;
    return b.turn.timestamp - a.turn.timestamp;
  });

  return scored.slice(0, topN).map((s) => s.turn);
}
