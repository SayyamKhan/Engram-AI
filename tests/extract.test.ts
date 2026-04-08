import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SQLiteStorage } from '../src/storage/sqlite.js';
import { store } from '../src/operations/store.js';
import { extract } from '../src/operations/extract.js';

// Mock the Anthropic SDK
vi.mock('@anthropic-ai/sdk', () => {
  const MockAnthropic = vi.fn().mockImplementation(() => ({
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              name: 'Alice',
              preferred_language: 'Python',
              current_goal: 'build a web app',
              expertise_level: 'intermediate',
            }),
          },
        ],
        usage: { input_tokens: 100, output_tokens: 30 },
      }),
    },
  }));
  return { default: MockAnthropic };
});

const { default: Anthropic } = await import('@anthropic-ai/sdk');

describe('extract()', () => {
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

  it('does nothing when no turns exist', async () => {
    await expect(
      extract(storage, mockClient, 'u1', 'claude-sonnet-4-6')
    ).resolves.not.toThrow();

    const facts = await storage.getFacts('u1');
    expect(facts).toHaveLength(0);
  });

  it('extracts and stores facts from conversation', async () => {
    await store(storage, {
      userId: 'u1', sessionId: 's1', role: 'user',
      content: "Hi! I'm Alice. I mainly code in Python and I'm building a web app.",
    });
    await store(storage, {
      userId: 'u1', sessionId: 's1', role: 'assistant',
      content: 'Great to meet you Alice! Python is excellent for web apps.',
    });

    await extract(storage, mockClient, 'u1', 'claude-sonnet-4-6');

    const facts = await storage.getFacts('u1');
    expect(facts.length).toBeGreaterThan(0);

    const factMap = Object.fromEntries(facts.map((f) => [f.key, f.value]));
    expect(factMap['name']).toBe('Alice');
    expect(factMap['preferred_language']).toBe('Python');
    expect(factMap['current_goal']).toBe('build a web app');
  });

  it('upserts facts (updates existing keys)', async () => {
    await store(storage, {
      userId: 'u1', sessionId: 's1', role: 'user',
      content: "My name is Alice.",
    });

    await extract(storage, mockClient, 'u1', 'claude-sonnet-4-6');

    // Extract again (mock returns same data)
    await extract(storage, mockClient, 'u1', 'claude-sonnet-4-6');

    const facts = await storage.getFacts('u1');

    // Should not have duplicate keys
    const keys = facts.map((f) => f.key);
    const uniqueKeys = [...new Set(keys)];
    expect(keys.length).toBe(uniqueKeys.length);
  });

  it('isolates facts by userId', async () => {
    await store(storage, { userId: 'alice', sessionId: 's1', role: 'user', content: 'I am alice.' });
    await store(storage, { userId: 'bob',   sessionId: 's1', role: 'user', content: 'I am bob.'   });

    await extract(storage, mockClient, 'alice', 'claude-sonnet-4-6');
    await extract(storage, mockClient, 'bob',   'claude-sonnet-4-6');

    const aliceFacts = await storage.getFacts('alice');
    const bobFacts   = await storage.getFacts('bob');

    expect(aliceFacts.every((f) => f.userId === 'alice')).toBe(true);
    expect(bobFacts.every((f)   => f.userId === 'bob')).toBe(true);
  });

  it('handles malformed JSON from Claude gracefully', async () => {
    // Override mock to return invalid JSON
    const createMock = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'not json at all' }],
    });
    (mockClient.messages.create as ReturnType<typeof vi.fn>) = createMock;

    await store(storage, {
      userId: 'u1', sessionId: 's1', role: 'user', content: 'hello',
    });

    // Should not throw
    await expect(
      extract(storage, mockClient, 'u1', 'claude-sonnet-4-6')
    ).resolves.not.toThrow();
  });

  it('handles JSON embedded in prose from Claude', async () => {
    const createMock = vi.fn().mockResolvedValue({
      content: [
        {
          type: 'text',
          text: 'Here are the facts I found:\n{"name": "Dave", "language": "Go"}\nHope that helps!',
        },
      ],
    });
    (mockClient.messages.create as ReturnType<typeof vi.fn>) = createMock;

    await store(storage, {
      userId: 'u1', sessionId: 's1', role: 'user', content: 'I am Dave and I use Go.',
    });

    await extract(storage, mockClient, 'u1', 'claude-sonnet-4-6');

    const facts = await storage.getFacts('u1');
    const factMap = Object.fromEntries(facts.map((f) => [f.key, f.value]));
    expect(factMap['name']).toBe('Dave');
    expect(factMap['language']).toBe('Go');
  });
});

describe('SQLiteStorage facts operations', () => {
  let storage: SQLiteStorage;

  beforeEach(async () => {
    storage = new SQLiteStorage(':memory:');
    await storage.initialize();
  });

  afterEach(async () => {
    await storage.close();
  });

  it('stores and retrieves a fact', async () => {
    await storage.upsertFact('u1', 'name', 'Alice', 1.0, 'manual');

    const facts = await storage.getFacts('u1');
    expect(facts).toHaveLength(1);
    expect(facts[0].key).toBe('name');
    expect(facts[0].value).toBe('Alice');
    expect(facts[0].confidence).toBe(1.0);
  });

  it('upserts (overwrites) existing fact with same key', async () => {
    await storage.upsertFact('u1', 'name', 'Alice', 1.0, 'turn:1');
    await storage.upsertFact('u1', 'name', 'Alicia', 0.9, 'turn:2');

    const facts = await storage.getFacts('u1');
    expect(facts).toHaveLength(1);
    expect(facts[0].value).toBe('Alicia');
    expect(facts[0].confidence).toBe(0.9);
  });

  it('stores multiple different facts', async () => {
    await storage.upsertFact('u1', 'name',     'Alice',  1.0, 'src');
    await storage.upsertFact('u1', 'language', 'Python', 1.0, 'src');
    await storage.upsertFact('u1', 'timezone', 'EST',    0.8, 'src');

    const facts = await storage.getFacts('u1');
    expect(facts).toHaveLength(3);
  });
});
