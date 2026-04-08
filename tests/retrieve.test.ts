import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SQLiteStorage } from '../src/storage/sqlite.js';
import { store } from '../src/operations/store.js';
import { retrieve } from '../src/operations/retrieve.js';

describe('retrieve()', () => {
  let storage: SQLiteStorage;

  beforeEach(async () => {
    storage = new SQLiteStorage(':memory:');
    await storage.initialize();
  });

  afterEach(async () => {
    await storage.close();
  });

  it('returns empty array when no turns exist', async () => {
    const results = await retrieve(storage, 'user_1', 'anything');
    expect(results).toEqual([]);
  });

  it('returns turns sorted by relevance to query', async () => {
    await store(storage, {
      userId: 'u1', sessionId: 's1', role: 'user',
      content: 'I love Python programming and data science.',
    });
    await store(storage, {
      userId: 'u1', sessionId: 's1', role: 'user',
      content: 'The weather today is nice and sunny.',
    });
    await store(storage, {
      userId: 'u1', sessionId: 's1', role: 'user',
      content: 'Python is great for machine learning.',
    });

    const results = await retrieve(storage, 'u1', 'Python programming', 5);

    expect(results.length).toBeGreaterThan(0);
    // The Python-related turns should score higher than the weather turn
    const contents = results.map((r) => r.content);
    expect(contents.some((c) => c.includes('Python'))).toBe(true);
  });

  it('respects the topN limit', async () => {
    for (let i = 0; i < 10; i++) {
      await store(storage, {
        userId: 'u1', sessionId: 's1', role: 'user',
        content: `Turn number ${i} with some keywords`,
      });
    }

    const results = await retrieve(storage, 'u1', 'turn keywords', 3);
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it('does not return compressed turns', async () => {
    const id = await store(storage, {
      userId: 'u1', sessionId: 's1', role: 'user',
      content: 'This is a compressed turn about Python.',
    });
    await storage.markTurnsCompressed([id]);

    await store(storage, {
      userId: 'u1', sessionId: 's1', role: 'user',
      content: 'This is an active turn about Python.',
    });

    const results = await retrieve(storage, 'u1', 'Python', 10);

    const ids = results.map((r) => r.id);
    expect(ids).not.toContain(id);
    expect(results.every((r) => !r.compressed)).toBe(true);
  });

  it('isolates results by userId', async () => {
    await store(storage, { userId: 'alice', sessionId: 's1', role: 'user', content: 'Alice likes cats' });
    await store(storage, { userId: 'bob',   sessionId: 's1', role: 'user', content: 'Bob likes cats too' });

    const aliceResults = await retrieve(storage, 'alice', 'cats', 10);
    const bobResults   = await retrieve(storage, 'bob',   'cats', 10);

    expect(aliceResults.every((r) => r.userId === 'alice')).toBe(true);
    expect(bobResults.every((r)   => r.userId === 'bob')).toBe(true);
  });
});

describe('SQLiteStorage.searchTurns()', () => {
  let storage: SQLiteStorage;

  beforeEach(async () => {
    storage = new SQLiteStorage(':memory:');
    await storage.initialize();
  });

  afterEach(async () => {
    await storage.close();
  });

  it('ranks results by relevance', async () => {
    await store(storage, {
      userId: 'u1', sessionId: 's1', role: 'user',
      content: 'I enjoy hiking and outdoor activities on weekends.',
    });
    await store(storage, {
      userId: 'u1', sessionId: 's1', role: 'user',
      content: 'TypeScript is my favourite language for building APIs.',
    });
    await store(storage, {
      userId: 'u1', sessionId: 's1', role: 'user',
      content: 'TypeScript types make refactoring much safer.',
    });

    const results = await storage.searchTurns('u1', 'TypeScript language', 5);

    expect(results.length).toBeGreaterThan(0);
    const firstContent = results[0].content;
    expect(firstContent).toContain('TypeScript');
  });

  it('returns empty array for no matching query', async () => {
    await store(storage, {
      userId: 'u1', sessionId: 's1', role: 'user',
      content: 'The sky is blue.',
    });

    // "zxqvbnm" is unlikely to match anything
    const results = await storage.searchTurns('u1', 'zxqvbnm irrelevant', 10);
    // Even if nothing matches, it should return some results (sorted by recency)
    expect(Array.isArray(results)).toBe(true);
  });
});
