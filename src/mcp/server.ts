#!/usr/bin/env node
/**
 * Engram MCP Server
 *
 * Exposes Engram's memory capabilities as MCP tools so any MCP-compatible
 * client (Claude Desktop, Claude.ai, etc.) can give Claude persistent memory.
 *
 * Run with:
 *   npx engram-mcp
 * or add to claude_desktop_config.json:
 *   {
 *     "mcpServers": {
 *       "engram": {
 *         "command": "node",
 *         "args": ["/path/to/dist/mcp/server.js"],
 *         "env": {
 *           "ANTHROPIC_API_KEY": "your-key-here",
 *           "ENGRAM_DEFAULT_USER_ID": "your-name-here"
 *         }
 *       }
 *     }
 *   }
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { Engram } from '../engram.js';

// ── Environment config ────────────────────────────────────────────────────────

const DEFAULT_USER_ID = process.env['ENGRAM_DEFAULT_USER_ID'] ?? 'default_user';
const AUTO_EXTRACT_INTERVAL = Number(process.env['ENGRAM_AUTO_EXTRACT_INTERVAL'] ?? 5);
const AUTO_COMPRESS = process.env['ENGRAM_AUTO_COMPRESS'] !== 'false';

// ── Input schemas ─────────────────────────────────────────────────────────────

/** userId is optional in every tool — falls back to DEFAULT_USER_ID. */
const UserIdField = z
  .string()
  .min(1)
  .optional()
  .describe('User identifier (omit to use the configured default)');

const StoreSchema = z.object({
  userId:    UserIdField,
  role:      z.enum(['user', 'assistant', 'system']).describe('Message role'),
  content:   z.string().min(1).describe('Message content'),
  sessionId: z.string().optional().describe('Optional session identifier'),
});

const InjectSchema = z.object({
  userId:    UserIdField,
  message:   z.string().min(1).describe('New user message to inject memory into'),
  sessionId: z.string().optional().describe('Optional session identifier'),
});

const SearchSchema = z.object({
  userId: UserIdField,
  query:  z.string().min(1).describe('Keyword search query'),
  limit:  z.number().int().positive().max(50).optional().default(10).describe('Maximum results'),
});

const UserIdOnlySchema = z.object({
  userId: UserIdField,
});

const RetrieveSchema = z.object({
  userId:            UserIdField,
  limit:             z.number().int().positive().max(100).optional().default(20).describe('Number of recent turns (default 20, max 100)'),
  includeCompressed: z.boolean().optional().default(false).describe('Include compressed turns (default false)'),
});

// ── Instance & store-count caches ─────────────────────────────────────────────

const instances  = new Map<string, Engram>();
const storeCounts = new Map<string, number>();

function resolveUserId(userId: string | undefined): string {
  const resolved = userId?.trim() || DEFAULT_USER_ID;
  if (!resolved) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'userId is required — either pass it or set ENGRAM_DEFAULT_USER_ID in the server env'
    );
  }
  return resolved;
}

function getEngram(userId: string, sessionId?: string): Engram {
  const key = sessionId ? `${userId}:${sessionId}` : userId;

  if (!instances.has(key)) {
    const apiKey = process.env['ANTHROPIC_API_KEY'];
    if (!apiKey) {
      throw new McpError(
        ErrorCode.InternalError,
        'ANTHROPIC_API_KEY environment variable is required'
      );
    }

    instances.set(
      key,
      new Engram({
        apiKey,
        userId,
        sessionId,
        dbPath: process.env['ENGRAM_DB_PATH'] ?? './engram.db',
        model:  process.env['ENGRAM_MODEL'] ?? 'claude-sonnet-4-6',
      })
    );
  }

  return instances.get(key) as Engram;
}

// ── Instructions resource ─────────────────────────────────────────────────────

const INSTRUCTIONS = `# Engram Memory System — How to Use These Tools

You have persistent memory through Engram. Follow these rules automatically and silently in every conversation.

## Rule 1 — Start of every conversation
Call \`engram_chat_start\` as your very first action before responding to the user.
Absorb the returned context to recall past facts, preferences, decisions, and conversation history.
Never announce that you are loading memory — just do it and use what you find naturally.

## Rule 2 — After every message exchange
After the user sends a message: call \`engram_store\` with role "user" and the message.
After you generate a response: call \`engram_store\` with role "assistant" and your response.
Fact extraction and compression run automatically inside \`engram_store\` — never call them separately.

## Rule 3 — When asked about the past
If the user says "do you remember...", "what did we talk about...", "have I mentioned...", etc.,
call \`engram_search\` with a relevant query to surface the most relevant past context.

## Rule 4 — userId
Never ask the user for a userId. Omit it from every call — the default is pre-configured.

## Rule 5 — Behaviour
- Reference past context naturally in your responses when it is relevant.
- Never mention Engram or memory operations to the user unless they directly ask.
- Never expose tool call details (IDs, stats, raw JSON) unless the user asks.
- Behave as if you have always known the user across all their past conversations.

## Tool summary
| Tool                 | When to call                                                  |
|----------------------|---------------------------------------------------------------|
| engram_chat_start    | Once at the very start of every conversation                  |
| engram_store         | After every user message and after every assistant response   |
| engram_search        | When the user references something from the past              |
| engram_retrieve      | When you want a chronological view of recent turns            |
| engram_get_facts     | When you need the full list of known user facts               |
| engram_stats         | When the user asks about their memory or storage usage        |
| engram_clear         | Only when the user explicitly asks to forget everything       |
| engram_inject        | Only when building a Claude API payload programmatically      |
| engram_compress      | Manual override — normally runs automatically                 |
| engram_extract       | Manual override — normally runs automatically                 |
`;

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'engram_chat_start',
    description:
      'CALL THIS FIRST at the start of every conversation before responding to the user. ' +
      'Loads all persistent memory — facts, summaries, recent turns — and returns a ' +
      'formattedContext string to silently absorb. Use it to recall who the user is and ' +
      'what you have discussed before. Never announce this call.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        userId: { type: 'string', description: 'User identifier (omit to use default)' },
      },
      required: [],
    },
  },
  {
    name: 'engram_store',
    description:
      'Store a conversation turn in persistent memory. ' +
      'Call after EVERY user message AND after every assistant response. ' +
      'Automatically triggers fact extraction (every 5 turns) and compression (when needed). ' +
      'Never call engram_extract or engram_compress separately — they run inside this.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        userId:    { type: 'string', description: 'User identifier (omit to use default)' },
        role:      { type: 'string', enum: ['user', 'assistant', 'system'], description: 'Message role' },
        content:   { type: 'string', description: 'Message content' },
        sessionId: { type: 'string', description: 'Optional session identifier' },
      },
      required: ['role', 'content'],
    },
  },
  {
    name: 'engram_retrieve',
    description:
      'Get the most recent conversation turns in chronological order (oldest → newest). ' +
      'Use this when you want a timeline view of recent history without a keyword query.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        userId:            { type: 'string', description: 'User identifier (omit to use default)' },
        limit:             { type: 'number', description: 'Number of recent turns to return (default 20, max 100)' },
        includeCompressed: { type: 'boolean', description: 'Include compressed/archived turns (default false)' },
      },
      required: [],
    },
  },
  {
    name: 'engram_search',
    description:
      'Search stored memories by keyword. Returns past conversation turns ranked by relevance. ' +
      'Use when the user references something from the past.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        userId: { type: 'string', description: 'User identifier (omit to use default)' },
        query:  { type: 'string', description: 'Search query' },
        limit:  { type: 'number', description: 'Max results (default 10)', default: 10 },
      },
      required: ['query'],
    },
  },
  {
    name: 'engram_get_facts',
    description:
      'Retrieve all extracted facts about the user (name, preferences, goals, skills, etc.). ' +
      'Use when you need the complete fact list, not just what was in chat_start.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        userId: { type: 'string', description: 'User identifier (omit to use default)' },
      },
      required: [],
    },
  },
  {
    name: 'engram_inject',
    description:
      'Build a memory-injected messages array for the Claude API. ' +
      'Returns messages (conversation history) and systemContext (facts + summary). ' +
      'Use systemContext as the system param and messages as the messages param. ' +
      'This is for programmatic Claude API use — not needed for normal chat.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        userId:    { type: 'string', description: 'User identifier (omit to use default)' },
        message:   { type: 'string', description: 'New user message' },
        sessionId: { type: 'string', description: 'Optional session identifier' },
      },
      required: ['message'],
    },
  },
  {
    name: 'engram_stats',
    description: 'Get memory statistics for a user (turn count, facts, token estimates, compression status).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        userId: { type: 'string', description: 'User identifier (omit to use default)' },
      },
      required: [],
    },
  },
  {
    name: 'engram_extract',
    description:
      'Manually extract and persist structured facts from recent turns. ' +
      'Normally runs automatically inside engram_store — only call this to force an immediate extraction.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        userId: { type: 'string', description: 'User identifier (omit to use default)' },
      },
      required: [],
    },
  },
  {
    name: 'engram_compress',
    description:
      'Manually trigger compression of old turns into a summary. ' +
      'Normally runs automatically inside engram_store — only call this to force immediate compression.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        userId:    { type: 'string', description: 'User identifier (omit to use default)' },
        sessionId: { type: 'string', description: 'Optional session identifier' },
      },
      required: [],
    },
  },
  {
    name: 'engram_clear',
    description:
      'Delete ALL stored memory for a user — turns, facts, and summaries. ' +
      'This is irreversible. Only call when the user explicitly asks to forget everything.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        userId: { type: 'string', description: 'User identifier (omit to use default)' },
      },
      required: [],
    },
  },
];

// ── Server ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const server = new Server(
    { name: 'engram', version: '0.2.0' },
    { capabilities: { tools: {}, resources: {} } }
  );

  // ── Resources ───────────────────────────────────────────────────────────────

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: 'engram://instructions',
        name: 'Engram Memory Usage Instructions',
        description:
          'Instructions that tell Claude when and how to use Engram memory tools automatically.',
        mimeType: 'text/plain',
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (request.params.uri === 'engram://instructions') {
      return {
        contents: [
          {
            uri: 'engram://instructions',
            mimeType: 'text/plain',
            text: INSTRUCTIONS,
          },
        ],
      };
    }
    throw new McpError(ErrorCode.InvalidRequest, `Unknown resource: ${request.params.uri}`);
  });

  // ── Tools ────────────────────────────────────────────────────────────────────

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    const args = rawArgs ?? {};

    try {
      switch (name) {

        // ── engram_chat_start ────────────────────────────────────────────────
        case 'engram_chat_start': {
          const { userId: rawUserId } = UserIdOnlySchema.parse(args);
          const userId = resolveUserId(rawUserId);
          const engram = getEngram(userId);

          const [facts, stats, injected] = await Promise.all([
            engram.getFacts(),
            engram.stats(),
            // inject builds systemContext (facts + summary) and recent messages
            engram.inject('__chat_start__'),
          ]);

          // Build human-readable context block
          const hasMemory = stats.totalTurns > 0 || facts.length > 0;

          const formattedContext = hasMemory
            ? [
                injected.systemContext,
                '',
                `Memory: ${stats.activeTurns} active turns · ${facts.length} facts · ~${stats.estimatedTokens} tokens`,
              ].join('\n')
            : 'No prior memory found — this appears to be a new user.';

          return ok({
            formattedContext,
            facts,
            stats,
            hasMemory,
            systemContext: injected.systemContext,
          });
        }

        // ── engram_store ─────────────────────────────────────────────────────
        case 'engram_store': {
          const parsed = StoreSchema.parse(args);
          const userId = resolveUserId(parsed.userId);
          const engram = getEngram(userId, parsed.sessionId);
          const id = await engram.store({ role: parsed.role, content: parsed.content });

          // Track store count for this instance to drive auto-extract
          const instanceKey = parsed.sessionId ? `${userId}:${parsed.sessionId}` : userId;
          const count = (storeCounts.get(instanceKey) ?? 0) + 1;
          storeCounts.set(instanceKey, count);

          let extracted = false;
          let compressed = false;

          // Auto-extract every N stores
          if (count % AUTO_EXTRACT_INTERVAL === 0) {
            await engram.extract();
            extracted = true;
          }

          // Auto-compress if enabled (compress() is a no-op when below threshold)
          if (AUTO_COMPRESS) {
            compressed = await engram.compress();
          }

          return ok({ success: true, id, autoActions: { extracted, compressed } });
        }

        // ── engram_retrieve ──────────────────────────────────────────────────
        case 'engram_retrieve': {
          const { userId: rawUserId, limit } = RetrieveSchema.parse(args);
          const userId = resolveUserId(rawUserId);
          const engram = getEngram(userId);

          // search('') scores purely by recency (newest first); reverse for chronological
          const turns = (await engram.search('', limit)).reverse();

          return ok({
            turns,
            count: turns.length,
            note: 'Ordered oldest → newest',
          });
        }

        // ── engram_inject ────────────────────────────────────────────────────
        case 'engram_inject': {
          const parsed = InjectSchema.parse(args);
          const userId = resolveUserId(parsed.userId);
          const engram = getEngram(userId, parsed.sessionId);
          const result = await engram.inject(parsed.message);
          return ok(result);
        }

        // ── engram_search ────────────────────────────────────────────────────
        case 'engram_search': {
          const parsed = SearchSchema.parse(args);
          const userId = resolveUserId(parsed.userId);
          const engram = getEngram(userId);
          const turns = await engram.search(parsed.query, parsed.limit);
          return ok({ turns, count: turns.length });
        }

        // ── engram_get_facts ─────────────────────────────────────────────────
        case 'engram_get_facts': {
          const { userId: rawUserId } = UserIdOnlySchema.parse(args);
          const userId = resolveUserId(rawUserId);
          const engram = getEngram(userId);
          const facts = await engram.getFacts();
          return ok({ facts, count: facts.length });
        }

        // ── engram_stats ─────────────────────────────────────────────────────
        case 'engram_stats': {
          const { userId: rawUserId } = UserIdOnlySchema.parse(args);
          const userId = resolveUserId(rawUserId);
          const engram = getEngram(userId);
          const stats = await engram.stats();
          return ok(stats);
        }

        // ── engram_extract ───────────────────────────────────────────────────
        case 'engram_extract': {
          const { userId: rawUserId } = UserIdOnlySchema.parse(args);
          const userId = resolveUserId(rawUserId);
          const engram = getEngram(userId);
          await engram.extract();
          const facts = await engram.getFacts();
          return ok({ success: true, factsExtracted: facts.length });
        }

        // ── engram_compress ──────────────────────────────────────────────────
        case 'engram_compress': {
          const parsed = z
            .object({ userId: UserIdField, sessionId: z.string().optional() })
            .parse(args);
          const userId = resolveUserId(parsed.userId);
          const engram = getEngram(userId, parsed.sessionId);
          const compressed = await engram.compress();
          return ok({
            compressed,
            message: compressed ? 'Compression performed.' : 'No compression needed.',
          });
        }

        // ── engram_clear ─────────────────────────────────────────────────────
        case 'engram_clear': {
          const { userId: rawUserId } = UserIdOnlySchema.parse(args);
          const userId = resolveUserId(rawUserId);
          const engram = getEngram(userId);
          await engram.clear();

          // Remove from instance cache so next request gets a fresh instance
          for (const key of instances.keys()) {
            if (key === userId || key.startsWith(`${userId}:`)) {
              const instance = instances.get(key);
              if (instance) await instance.close();
              instances.delete(key);
              storeCounts.delete(key);
            }
          }

          return ok({ success: true, message: `All memory cleared for user "${userId}".` });
        }

        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }
    } catch (err) {
      if (err instanceof McpError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new McpError(ErrorCode.InternalError, `Engram error: ${message}`);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function ok(data: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
}

main().catch((err: unknown) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
