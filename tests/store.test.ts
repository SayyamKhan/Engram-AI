import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SQLiteStorage } from '../src/storage/sqlite.js';
import { store } from '../src/operations/store.js';
import { estimateTokens } from '../src/utils/tokens.js';

describe('store()', () => {
  let storage: SQLiteStorage;

  beforeEach(async () => {
    storage = new SQLiteStorage(':memory:');
    await storage.initialize();
  });

  afterEach(async () => {
    await storage.close();
  });

  it('stores a user message and returns a positive ID', async () => {
    const id = await store(storage, {
      userId: 'user_1',
      sessionId: 'session_1',
      role: 'user',
      content: 'Hello, I am Alice.',
    });

    expect(id).toBeTypeOf('number');
    expect(id).toBeGreaterThan(0);
  });

  it('persists the turn with correct fields', async () => {
    await store(storage, {
      userId: 'user_1',
      sessionId: 'session_1',
      role: 'user',
      content: 'My name is Bob and I love TypeScript.',
    });

    const turns = await storage.getTurns('user_1');
    expect(turns).toHaveLength(1);

    const turn = turns[0];
    expect(turn.userId).toBe('user_1');
    expect(turn.sessionId).toBe('session_1');
    expect(turn.role).toBe('user');
    expect(turn.content).toBe('My name is Bob and I love TypeScript.');
    expect(turn.compressed).toBe(false);
    expect(turn.timestamp).toBeGreaterThan(0);
  });

  it('auto-estimates token count', async () => {
    const content = 'This is a test message for token estimation.';
    await store(storage, { userId: 'u1', sessionId: 's1', role: 'user', content });

    const turns = await storage.getTurns('u1');
    expect(turns[0].tokenCount).toBe(estimateTokens(content));
  });

  it('stores multiple turns in order', async () => {
    await store(storage, { userId: 'u1', sessionId: 's1', role: 'user',      content: 'Turn 1' });
    await store(storage, { userId: 'u1', sessionId: 's1', role: 'assistant', content: 'Turn 2' });
    await store(storage, { userId: 'u1', sessionId: 's1', role: 'user',      content: 'Turn 3' });

    const turns = await storage.getTurns('u1');
    expect(turns).toHaveLength(3);
    expect(turns[0].content).toBe('Turn 1');
    expect(turns[1].content).toBe('Turn 2');
    expect(turns[2].content).toBe('Turn 3');
  });

  it('isolates turns by userId', async () => {
    await store(storage, { userId: 'alice', sessionId: 's1', role: 'user', content: 'Alice turn' });
    await store(storage, { userId: 'bob',   sessionId: 's1', role: 'user', content: 'Bob turn'   });

    expect(await storage.getTurns('alice')).toHaveLength(1);
    expect(await storage.getTurns('bob')).toHaveLength(1);
    expect((await storage.getTurns('alice'))[0].content).toBe('Alice turn');
  });

  it('stores assistant and system roles correctly', async () => {
    await store(storage, { userId: 'u1', sessionId: 's1', role: 'assistant', content: 'I can help.' });
    await store(storage, { userId: 'u1', sessionId: 's1', role: 'system',    content: 'You are helpful.' });

    const turns = await storage.getTurns('u1');
    expect(turns).toHaveLength(2);
    expect(turns[0].role).toBe('assistant');
    expect(turns[1].role).toBe('system');
  });
});

describe('SQLiteStorage.clearUser()', () => {
  let storage: SQLiteStorage;

  beforeEach(async () => {
    storage = new SQLiteStorage(':memory:');
    await storage.initialize();
  });

  afterEach(async () => {
    await storage.close();
  });

  it('deletes all turns for the user', async () => {
    await store(storage, { userId: 'u1', sessionId: 's1', role: 'user', content: 'hello' });
    await store(storage, { userId: 'u1', sessionId: 's1', role: 'user', content: 'world' });

    await storage.clearUser('u1');

    const turns = await storage.getTurns('u1');
    expect(turns).toHaveLength(0);
  });

  it('does not affect other users', async () => {
    await store(storage, { userId: 'alice', sessionId: 's1', role: 'user', content: 'hi' });
    await store(storage, { userId: 'bob',   sessionId: 's1', role: 'user', content: 'hey' });

    await storage.clearUser('alice');

    expect(await storage.getTurns('alice')).toHaveLength(0);
    expect(await storage.getTurns('bob')).toHaveLength(1);
  });
});
