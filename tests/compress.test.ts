import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SQLiteStorage } from '../src/storage/sqlite.js';
import { store } from '../src/operations/store.js';
import { compress } from '../src/operations/compress.js';

// Mock the Anthropic SDK so tests don't require a real API key
vi.mock('@anthropic-ai/sdk', () => {
  const MockAnthropic = vi.fn().mockImplementation(() => ({
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'This is a mock conversation summary.' }],
        usage: { input_tokens: 100, output_tokens: 20 },
      }),
    },
  }));
  return { default: MockAnthropic };
});

// Import after mock is set up
const { default: Anthropic } = await import('@anthropic-ai/sdk');

describe('compress()', () => {
  let storage: SQLiteStorage;
  let mockClient: InstanceType<typeof Anthropic>;

  beforeEach(async () => {
    storage = new SQLiteStorage(':memory:');
    await storage.initialize();
    mockClient = new Anthropic({ apiKey: 'test-key' });
  });

  afterEach(async () => {
    await storage.close();
    vi.clearAllMocks();
  });

  it('returns false when token count is below threshold', async () => {
    // Store a small amount of content
    await store(storage, { userId: 'u1', sessionId: 's1', role: 'user', content: 'Short message.' });
    await store(storage, { userId: 'u1', sessionId: 's1', role: 'assistant', content: 'Short reply.' });

    const result = await compress(storage, mockClient, 'u1', 's1', 'claude-sonnet-4-6', 4000);

    expect(result).toBe(false);
  });

  it('returns false when no turns exist', async () => {
    const result = await compress(storage, mockClient, 'u1', 's1', 'claude-sonnet-4-6', 100);
    expect(result).toBe(false);
  });

  it('compresses turns when token count exceeds threshold', async () => {
    // Store enough content to exceed a very low threshold
    for (let i = 0; i < 10; i++) {
      await store(storage, {
        userId: 'u1',
        sessionId: 's1',
        role: i % 2 === 0 ? 'user' : 'assistant',
        // Each message is ~125 tokens (500 chars)
        content: 'A'.repeat(500),
      });
    }

    // Use a threshold of 100 tokens (very low) to force compression
    const result = await compress(storage, mockClient, 'u1', 's1', 'claude-sonnet-4-6', 100);

    expect(result).toBe(true);
  });

  it('stores a summary after compression', async () => {
    for (let i = 0; i < 6; i++) {
      await store(storage, {
        userId: 'u1', sessionId: 's1',
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: 'A'.repeat(500),
      });
    }

    await compress(storage, mockClient, 'u1', 's1', 'claude-sonnet-4-6', 100);

    const summaries = await storage.getSummaries('u1');
    expect(summaries.length).toBeGreaterThan(0);
    expect(summaries[0].content).toBe('This is a mock conversation summary.');
    expect(summaries[0].userId).toBe('u1');
  });

  it('marks compressed turns as compressed', async () => {
    for (let i = 0; i < 6; i++) {
      await store(storage, {
        userId: 'u1', sessionId: 's1',
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: 'A'.repeat(500),
      });
    }

    await compress(storage, mockClient, 'u1', 's1', 'claude-sonnet-4-6', 100);

    // After compression, some turns should be marked as compressed
    const allTurns = await storage.getTurns('u1', { includeCompressed: true });
    const activeTurns = await storage.getTurns('u1', { includeCompressed: false });

    expect(allTurns.length).toBeGreaterThan(activeTurns.length);
    expect(allTurns.some((t) => t.compressed)).toBe(true);
  });

  it('calls Claude with the conversation text', async () => {
    await store(storage, { userId: 'u1', sessionId: 's1', role: 'user',      content: 'A'.repeat(800) });
    await store(storage, { userId: 'u1', sessionId: 's1', role: 'assistant', content: 'A'.repeat(800) });

    await compress(storage, mockClient, 'u1', 's1', 'claude-sonnet-4-6', 100);

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(mockClient.messages.create).toHaveBeenCalledOnce();
  });
});

describe('SQLiteStorage.markTurnsCompressed()', () => {
  let storage: SQLiteStorage;

  beforeEach(async () => {
    storage = new SQLiteStorage(':memory:');
    await storage.initialize();
  });

  afterEach(async () => {
    await storage.close();
  });

  it('marks specified turns as compressed', async () => {
    const id1 = await store(storage, { userId: 'u1', sessionId: 's1', role: 'user', content: 'turn 1' });
    const id2 = await store(storage, { userId: 'u1', sessionId: 's1', role: 'user', content: 'turn 2' });
    await store(storage, { userId: 'u1', sessionId: 's1', role: 'user', content: 'turn 3' });

    await storage.markTurnsCompressed([id1, id2]);

    const activeTurns = await storage.getTurns('u1', { includeCompressed: false });
    const allTurns    = await storage.getTurns('u1', { includeCompressed: true  });

    expect(allTurns).toHaveLength(3);
    expect(activeTurns).toHaveLength(1);
    expect(activeTurns[0].content).toBe('turn 3');
  });

  it('handles empty ids array gracefully', async () => {
    await expect(storage.markTurnsCompressed([])).resolves.not.toThrow();
  });
});
