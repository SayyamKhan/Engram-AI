# Engram

**Persistent memory for Claude. Because every conversation shouldn't start from zero.**

[![npm version](https://img.shields.io/npm/v/engram.svg)](https://www.npmjs.com/package/engram)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/node/v/engram.svg)](https://nodejs.org/)

Engram is a drop-in TypeScript library that gives Claude persistent memory. Drop it into any Claude-powered application and your users will **never lose context again** — preferences, history, facts, and decisions all persist seamlessly across sessions.

---

## The Problem

Every Claude conversation starts completely blank. All context, user preferences, learned behavior, and history is permanently lost between sessions. Developers building Claude-powered apps have no standard, drop-in solution for persistent memory.

**Without Engram:**
```
Session 1: "Hi, I'm Alice. I'm building a FastAPI app on AWS."
Session 2: "Hey, can you help me with my project?"
Claude: "Of course! What are you working on?" ← starts from zero, again
```

**With Engram:**
```
Session 1: "Hi, I'm Alice. I'm building a FastAPI app on AWS."
Session 2: "Hey, can you help me with my project?"
Claude: "Hi Alice! Happy to continue helping with your FastAPI app on AWS." ← remembers everything
```

---

## Features

- **Store** — Persist every conversation turn to SQLite (or PostgreSQL) with userId, sessionId, role, timestamp, and token count
- **Extract** — Use Claude to extract structured user facts (name, preferences, goals, skills) after every turn
- **Compress** — Automatically summarise old turns when history exceeds your token threshold
- **Inject** — Prepend the right context (facts + summary + recent turns) before every Claude API call
- **Search** — Keyword search across all stored memories with relevance ranking
- **MCP Server** — Full Model Context Protocol server for Claude Desktop and MCP clients
- **Zero config** — Works out of the box with SQLite, no database setup required
- **TypeScript-first** — Strict types, full type exports, no `any`

---

## Installation

```bash
npm install engram
```

### Peer dependencies (already included):
```bash
# These are bundled as dependencies — no extra installs needed
# @anthropic-ai/sdk, better-sqlite3, @modelcontextprotocol/sdk, zod
```

---

## Quick Start

```typescript
import Anthropic from '@anthropic-ai/sdk';
import { Engram } from 'engram';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const engram = new Engram({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  userId: 'user_123',
});

// Store turns after each exchange
await engram.store({ role: 'user',      content: "I'm Alice. I love Python." });
await engram.store({ role: 'assistant', content: 'Nice to meet you, Alice!' });
await engram.extract(); // extract facts: name=Alice, language=Python

// In a new session — inject memory into your Claude call
const { messages, systemContext } = await engram.inject("What language do I prefer?");

const reply = await anthropic.messages.create({
  model: 'claude-sonnet-4-6',
  max_tokens: 1024,
  system: systemContext,   // injected facts + summary
  messages,                // history + new message
});
```

That's it. Claude now remembers Alice is a Python developer across every future session.

---

## How It Works

```
┌──────────────────────────────────────────────────────────────────┐
│                          Engram Pipeline                          │
│                                                                   │
│  User message                                                     │
│       │                                                           │
│       ▼                                                           │
│  ┌─────────┐   ┌─────────┐   ┌──────────┐   ┌────────────────┐  │
│  │  STORE  │──▶│ EXTRACT │──▶│ COMPRESS │──▶│    INJECT      │  │
│  │         │   │         │   │          │   │                │  │
│  │ Save to │   │ Claude  │   │ Claude   │   │ Facts +        │  │
│  │ SQLite  │   │ extracts│   │summarises│   │ Summary +      │  │
│  │ with    │   │ name,   │   │ old turns│   │ Recent turns   │  │
│  │ token   │   │ prefs,  │   │ when over│   │ → messages[]   │  │
│  │ count   │   │ goals   │   │ threshold│   │                │  │
│  └─────────┘   └─────────┘   └──────────┘   └────────────────┘  │
│                                                      │            │
│                                                      ▼            │
│                                              Claude API call      │
└──────────────────────────────────────────────────────────────────┘
```

1. **Store** — Every turn is saved with timestamp and token count
2. **Extract** — Claude identifies user facts and stores them in a `facts` table
3. **Compress** — When token count exceeds the threshold, old turns are summarised
4. **Inject** — Before every new call, relevant facts + summary + recent turns are assembled

---

## Full API Reference

### `new Engram(config)`

```typescript
const engram = new Engram({
  apiKey: string,                    // Anthropic API key (required)
  userId: string,                    // User identifier (required)
  storage?: 'sqlite' | 'postgres',   // Storage backend (default: 'sqlite')
  dbPath?: string,                   // SQLite file path (default: './engram.db')
  postgresUrl?: string,              // PostgreSQL connection string
  maxTokensBeforeCompress?: number,  // Compression threshold (default: 4000)
  maxInjectTokens?: number,          // Injection budget (default: 2000)
  extractFacts?: boolean,            // Auto-extract facts (default: true)
  model?: string,                    // Claude model (default: 'claude-sonnet-4-6')
  sessionId?: string,                // Session ID (auto-generated if omitted)
});
```

### `engram.store(message)`
Store a conversation turn. Call after every user message and assistant response.

```typescript
const id = await engram.store({ role: 'user', content: 'Hello!' });
// role: 'user' | 'assistant' | 'system'
// Returns: number (stored turn ID)
```

### `engram.inject(userMessage)`
Build a memory-injected messages array for the next Claude API call.

```typescript
const { messages, systemContext } = await engram.inject("What's my name?");

await anthropic.messages.create({
  model: 'claude-sonnet-4-6',
  max_tokens: 1024,
  system: systemContext,  // Pass as the system prompt
  messages,               // Pass as the messages array
});
```

### `engram.extract()`
Use Claude to extract and persist structured user facts from recent turns.

```typescript
await engram.extract();
// Stores facts like: { name: 'Alice', preferred_language: 'Python', ... }
```

### `engram.compress()`
Compress old turns into a summary using Claude. Returns `true` if compression occurred.

```typescript
const compressed = await engram.compress();
// Automatically respects maxTokensBeforeCompress threshold
```

### `engram.search(query, topN?)`
Search stored memories by keyword. Returns turns ordered by relevance.

```typescript
const results = await engram.search('Python programming', 5);
// Returns: MessageTurn[]
```

### `engram.getFacts()`
Retrieve all extracted facts for this user.

```typescript
const facts = await engram.getFacts();
// Returns: MemoryFact[] — [{ key: 'name', value: 'Alice', confidence: 1.0, ... }]
```

### `engram.clear()`
Delete all stored memory for this user. **Irreversible.**

```typescript
await engram.clear();
```

### `engram.stats()`
Get aggregate memory statistics.

```typescript
const stats = await engram.stats();
// Returns: {
//   userId, totalTurns, activeTurns, compressedTurns,
//   totalFacts, totalSummaries, estimatedTokens
// }
```

### `engram.close()`
Close the storage connection. Call when your app shuts down.

```typescript
await engram.close();
```

---

## MCP Server

Engram ships with a full MCP server so you can give Claude Desktop persistent memory with zero code.

### Add to `claude_desktop_config.json`

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "engram": {
      "command": "npx",
      "args": ["engram-mcp"],
      "env": {
        "ANTHROPIC_API_KEY": "your-api-key-here",
        "ENGRAM_DB_PATH": "/Users/you/engram.db"
      }
    }
  }
}
```

Restart Claude Desktop — Engram's tools will be available immediately.

### Available MCP Tools

| Tool                | Description                                          |
|---------------------|------------------------------------------------------|
| `engram_store`      | Store a conversation message turn                    |
| `engram_inject`     | Get memory-injected messages for the next API call   |
| `engram_search`     | Search memories by keyword                           |
| `engram_get_facts`  | Get all extracted facts for a user                   |
| `engram_compress`   | Trigger compression of old turns                     |
| `engram_extract`    | Extract facts from recent conversation               |
| `engram_clear`      | Clear all memory for a user                          |
| `engram_stats`      | Get memory statistics                                |

See [examples/mcp-usage.md](./examples/mcp-usage.md) for full tool schemas and examples.

---

## Storage Options

### SQLite (default — zero config)

```typescript
const engram = new Engram({
  apiKey: '...',
  userId: 'user_123',
  storage: 'sqlite',
  dbPath: './engram.db',  // relative to cwd, auto-created
});
```

SQLite is the default. The database file is created automatically on first use. Uses WAL mode for concurrent read performance.

### PostgreSQL

```typescript
const engram = new Engram({
  apiKey: '...',
  userId: 'user_123',
  storage: 'postgres',
  postgresUrl: 'postgresql://user:pass@localhost:5432/engram',
});
```

Or use environment variables (`PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`) and omit `postgresUrl`.

Tables are created automatically on first use.

### Custom Storage Adapter

Implement `StorageAdapter` to add your own backend (Redis, DynamoDB, Firestore, etc.):

```typescript
import { StorageAdapter, Engram } from 'engram';

class MyCustomStorage implements StorageAdapter {
  async initialize() { /* ... */ }
  async storeTurn(turn) { /* ... */ }
  // ... implement all methods
}
```

---

## Environment Variables

| Variable              | Default             | Description                              |
|-----------------------|---------------------|------------------------------------------|
| `ANTHROPIC_API_KEY`   | (required)          | Your Anthropic API key                   |
| `ENGRAM_DB_PATH`      | `./engram.db`       | SQLite database path                     |
| `ENGRAM_MAX_TOKENS`   | `4000`              | Token threshold before compression       |
| `ENGRAM_MODEL`        | `claude-sonnet-4-6` | Claude model for compress/extract ops    |

---

## Roadmap

- [ ] **Vector embeddings** — Semantic similarity retrieval via pgvector / sqlite-vss
- [ ] **Redis adapter** — In-memory storage for high-throughput applications
- [ ] **Multi-user session management** — Group sessions, shared context, org-level memory
- [ ] **Web dashboard** — Visual memory explorer and fact editor
- [ ] **Cloudflare Workers support** — Edge-compatible storage via D1 / KV
- [ ] **Auto-store hook** — Middleware that automatically stores turns after each Claude call
- [ ] **Memory versioning** — Track how user facts evolve over time
- [ ] **Export / import** — Portable memory snapshots in JSON

---

## Contributing

Contributions are welcome!

1. Fork the repository
2. Create a feature branch: `git checkout -b feat/my-feature`
3. Make your changes (TypeScript strict mode, no `any`)
4. Run tests: `npm test`
5. Submit a pull request

Please open an issue first for significant changes to discuss the approach.

### Development Setup

```bash
git clone https://github.com/your-username/engram
cd engram
npm install
npm run build
npm test
```

---

## License

MIT — see [LICENSE](./LICENSE) for details.

---

*Built for the [Anthropic Claude for Open Source Program](https://www.anthropic.com/) — Ecosystem Impact Track.*
