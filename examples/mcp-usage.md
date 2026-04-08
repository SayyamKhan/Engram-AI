# Engram MCP Server — Setup & Usage

Engram ships with a full MCP (Model Context Protocol) server that lets you give Claude
persistent memory through any MCP-compatible client — including Claude Desktop and Claude.ai.

---

## Quick Start with Claude Desktop

### 1. Install Engram

```bash
npm install -g engram
```

### 2. Add to `claude_desktop_config.json`

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`  
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

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

### 3. Restart Claude Desktop

Engram tools will now appear in Claude Desktop's tool picker.

---

## Available MCP Tools

### `engram_store`
Store a conversation message in persistent memory.

```json
{
  "userId": "user_123",
  "role": "user",
  "content": "I'm Alice and I love Python.",
  "sessionId": "optional-session-id"
}
```

### `engram_inject`
Get memory-injected messages ready for a Claude API call.

```json
{
  "userId": "user_123",
  "message": "What programming language do I prefer?"
}
```

Returns:
```json
{
  "messages": [
    { "role": "user",      "content": "I'm Alice and I love Python." },
    { "role": "assistant", "content": "Great to meet you, Alice!" },
    { "role": "user",      "content": "What programming language do I prefer?" }
  ],
  "systemContext": "[ENGRAM MEMORY]\n## Known User Facts\n- name: Alice\n- preferred_language: Python\n[/ENGRAM MEMORY]"
}
```

### `engram_search`
Search stored memories by keyword.

```json
{
  "userId": "user_123",
  "query": "Python programming",
  "limit": 5
}
```

### `engram_get_facts`
Retrieve all extracted facts about a user.

```json
{ "userId": "user_123" }
```

### `engram_compress`
Trigger compression of old conversation turns into a summary.

```json
{
  "userId": "user_123",
  "sessionId": "optional-session-id"
}
```

### `engram_extract`
Extract structured facts from recent conversation turns using Claude.

```json
{ "userId": "user_123" }
```

### `engram_clear`
Delete all stored memory for a user. **Irreversible.**

```json
{ "userId": "user_123" }
```

### `engram_stats`
Get memory statistics.

```json
{ "userId": "user_123" }
```

Returns:
```json
{
  "userId": "user_123",
  "totalTurns": 42,
  "activeTurns": 15,
  "compressedTurns": 27,
  "totalFacts": 8,
  "totalSummaries": 3,
  "estimatedTokens": 1840
}
```

---

## Running the MCP Server Directly

```bash
# Using npx (no install required)
ANTHROPIC_API_KEY=your_key npx engram-mcp

# Using a local build
npm run build
ANTHROPIC_API_KEY=your_key node dist/mcp/server.js
```

---

## Environment Variables

| Variable              | Default         | Description                                    |
|-----------------------|-----------------|------------------------------------------------|
| `ANTHROPIC_API_KEY`   | (required)      | Your Anthropic API key                         |
| `ENGRAM_DB_PATH`      | `./engram.db`   | Path to the SQLite database file               |
| `ENGRAM_MAX_TOKENS`   | `4000`          | Token threshold before auto-compression        |
| `ENGRAM_MODEL`        | `claude-sonnet-4-6` | Claude model for compress/extract          |

---

## How Memory Flows in Claude Desktop

When you chat with Claude Desktop with Engram connected:

1. **You send a message** → Claude calls `engram_inject` to fetch relevant memory
2. **Claude responds** → Claude calls `engram_store` to save both turns
3. **Periodically** → Claude calls `engram_extract` to update your fact profile
4. **When history grows** → Claude calls `engram_compress` to summarise old turns

The result: every conversation picks up right where you left off, even days later.
