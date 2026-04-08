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
 *         "command": "npx",
 *         "args": ["engram-mcp"],
 *         "env": { "ANTHROPIC_API_KEY": "your-key-here" }
 *       }
 *     }
 *   }
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { Engram } from '../engram.js';

// ── Input schemas ────────────────────────────────────────────────────────────

const StoreSchema = z.object({
  userId: z.string().min(1).describe('Unique user identifier'),
  role: z.enum(['user', 'assistant', 'system']).describe('Message role'),
  content: z.string().min(1).describe('Message content'),
  sessionId: z.string().optional().describe('Optional session identifier'),
});

const InjectSchema = z.object({
  userId: z.string().min(1).describe('Unique user identifier'),
  message: z.string().min(1).describe('New user message to inject memory into'),
  sessionId: z.string().optional().describe('Optional session identifier'),
});

const SearchSchema = z.object({
  userId: z.string().min(1).describe('Unique user identifier'),
  query: z.string().min(1).describe('Keyword search query'),
  limit: z.number().int().positive().max(50).optional().default(10).describe('Maximum results'),
});

const UserIdSchema = z.object({
  userId: z.string().min(1).describe('Unique user identifier'),
});

// ── Instance cache ────────────────────────────────────────────────────────────

const instances = new Map<string, Engram>();

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
        model: process.env['ENGRAM_MODEL'] ?? 'claude-sonnet-4-6',
      })
    );
  }

  return instances.get(key) as Engram;
}

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'engram_store',
    description:
      'Store a conversation message turn in persistent memory. ' +
      'Call after every user message and assistant response.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        userId:    { type: 'string', description: 'Unique user identifier' },
        role:      { type: 'string', enum: ['user', 'assistant', 'system'], description: 'Message role' },
        content:   { type: 'string', description: 'Message content' },
        sessionId: { type: 'string', description: 'Optional session identifier' },
      },
      required: ['userId', 'role', 'content'],
    },
  },
  {
    name: 'engram_inject',
    description:
      'Get a memory-injected messages array ready for the Claude API. ' +
      'Returns messages (conversation history) and systemContext (facts + summary). ' +
      'Use systemContext as the system prompt and messages as the messages array.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        userId:    { type: 'string', description: 'Unique user identifier' },
        message:   { type: 'string', description: 'New user message' },
        sessionId: { type: 'string', description: 'Optional session identifier' },
      },
      required: ['userId', 'message'],
    },
  },
  {
    name: 'engram_search',
    description: 'Search stored memories by keyword. Returns relevant past conversation turns.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        userId: { type: 'string', description: 'Unique user identifier' },
        query:  { type: 'string', description: 'Search query' },
        limit:  { type: 'number', description: 'Max results (default 10)', default: 10 },
      },
      required: ['userId', 'query'],
    },
  },
  {
    name: 'engram_get_facts',
    description: 'Retrieve all extracted facts about a user (name, preferences, goals, etc.).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        userId: { type: 'string', description: 'Unique user identifier' },
      },
      required: ['userId'],
    },
  },
  {
    name: 'engram_compress',
    description:
      'Trigger compression of old conversation turns. ' +
      'Summarises history using Claude to stay within token limits.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        userId:    { type: 'string', description: 'Unique user identifier' },
        sessionId: { type: 'string', description: 'Optional session identifier' },
      },
      required: ['userId'],
    },
  },
  {
    name: 'engram_extract',
    description:
      'Extract and persist structured facts about the user from recent conversation turns.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        userId: { type: 'string', description: 'Unique user identifier' },
      },
      required: ['userId'],
    },
  },
  {
    name: 'engram_clear',
    description: 'Clear all stored memory for a user. This action is irreversible.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        userId: { type: 'string', description: 'Unique user identifier' },
      },
      required: ['userId'],
    },
  },
  {
    name: 'engram_stats',
    description: 'Get memory statistics for a user (turn count, facts, token estimates).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        userId: { type: 'string', description: 'Unique user identifier' },
      },
      required: ['userId'],
    },
  },
];

// ── Server setup ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const server = new Server(
    { name: 'engram', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;

    if (!rawArgs) {
      throw new McpError(ErrorCode.InvalidParams, 'No arguments provided');
    }

    try {
      switch (name) {
        case 'engram_store': {
          const args = StoreSchema.parse(rawArgs);
          const engram = getEngram(args.userId, args.sessionId);
          const id = await engram.store({ role: args.role, content: args.content });
          return ok({ success: true, id });
        }

        case 'engram_inject': {
          const args = InjectSchema.parse(rawArgs);
          const engram = getEngram(args.userId, args.sessionId);
          const result = await engram.inject(args.message);
          return ok(result);
        }

        case 'engram_search': {
          const args = SearchSchema.parse(rawArgs);
          const engram = getEngram(args.userId);
          const turns = await engram.search(args.query, args.limit);
          return ok({ turns, count: turns.length });
        }

        case 'engram_get_facts': {
          const args = UserIdSchema.parse(rawArgs);
          const engram = getEngram(args.userId);
          const facts = await engram.getFacts();
          return ok({ facts, count: facts.length });
        }

        case 'engram_compress': {
          const args = StoreSchema.pick({ userId: true, sessionId: true }).parse(rawArgs);
          const engram = getEngram(args.userId, args.sessionId);
          const compressed = await engram.compress();
          return ok({ compressed, message: compressed ? 'Compression performed' : 'No compression needed' });
        }

        case 'engram_extract': {
          const args = UserIdSchema.parse(rawArgs);
          const engram = getEngram(args.userId);
          await engram.extract();
          const facts = await engram.getFacts();
          return ok({ success: true, factsExtracted: facts.length });
        }

        case 'engram_clear': {
          const args = UserIdSchema.parse(rawArgs);
          const engram = getEngram(args.userId);
          await engram.clear();
          // Remove from instance cache so next request gets a fresh instance
          for (const key of instances.keys()) {
            if (key.startsWith(args.userId)) {
              const instance = instances.get(key);
              if (instance) await instance.close();
              instances.delete(key);
            }
          }
          return ok({ success: true, message: `Memory cleared for user ${args.userId}` });
        }

        case 'engram_stats': {
          const args = UserIdSchema.parse(rawArgs);
          const engram = getEngram(args.userId);
          const stats = await engram.stats();
          return ok(stats);
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
