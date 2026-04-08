/**
 * Lightweight keyword-based similarity and relevance scoring.
 *
 * No external dependencies — uses TF-IDF-inspired term overlap scoring
 * combined with a recency decay for ranking memory retrieval results.
 */

/** Common English stop words to exclude from keyword matching. */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'was', 'are', 'were', 'be', 'been',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'this', 'that', 'these', 'those',
  'i', 'you', 'he', 'she', 'we', 'they', 'it', 'my', 'your', 'his',
  'her', 'our', 'its', 'me', 'him', 'us', 'them', 'what', 'which',
  'who', 'how', 'when', 'where', 'why', 'not', 'no', 'so', 'if',
]);

/**
 * Tokenize text into normalized keywords, filtering stop words.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word));
}

/**
 * Compute keyword overlap similarity between a query and a text.
 * Returns a score in [0, 1].
 */
export function keywordSimilarity(query: string, text: string): number {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return 0;

  const textTokenSet = new Set(tokenize(text));
  if (textTokenSet.size === 0) return 0;

  const matches = queryTokens.filter((token) => textTokenSet.has(token)).length;
  return matches / queryTokens.length;
}

/**
 * Compute a recency score for a timestamp.
 * More recent timestamps score closer to 1; older ones decay toward 0.
 * Uses a 7-day half-life exponential decay.
 */
export function recencyScore(timestamp: number): number {
  const ageMs = Date.now() - timestamp;
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  const halfLifeDays = 7;
  return Math.pow(0.5, ageDays / halfLifeDays);
}

/**
 * Combined relevance score weighting keyword similarity and recency.
 */
export function relevanceScore(
  query: string,
  text: string,
  timestamp: number
): number {
  const kwScore = keywordSimilarity(query, text);
  const recScore = recencyScore(timestamp);
  return kwScore * 0.7 + recScore * 0.3;
}
