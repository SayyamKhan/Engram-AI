/**
 * Engram Basic Example
 *
 * Demonstrates the core workflow: store → extract → inject → call Claude.
 *
 * Run:
 *   ANTHROPIC_API_KEY=your_key npx tsx examples/basic.ts
 */

import Anthropic from '@anthropic-ai/sdk';
import { Engram } from '../src/index.js';

const apiKey = process.env['ANTHROPIC_API_KEY'];
if (!apiKey) {
  console.error('Error: ANTHROPIC_API_KEY environment variable is required.');
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey });

const engram = new Engram({
  apiKey,
  userId: 'demo_user',
  dbPath: './demo.db',
  extractFacts: true,
  maxTokensBeforeCompress: 4000,
  maxInjectTokens: 2000,
});

console.log('=== Engram Basic Demo ===\n');

// ── Session 1: First conversation ────────────────────────────────────────────

console.log('--- Session 1: Introduce the user ---\n');

const session1Turns = [
  { role: 'user' as const,      content: "Hi! I'm Alice. I'm a Python developer building a REST API." },
  { role: 'assistant' as const, content: "Nice to meet you, Alice! Happy to help with your Python REST API." },
  { role: 'user' as const,      content: "I prefer FastAPI over Flask because of the automatic OpenAPI docs." },
  { role: 'assistant' as const, content: "Great choice! FastAPI's auto-generated docs are a big productivity win." },
  { role: 'user' as const,      content: "I'm targeting Python 3.12 and want to use async everywhere." },
  { role: 'assistant' as const, content: "Perfect — FastAPI + async is an excellent stack for modern APIs." },
];

for (const turn of session1Turns) {
  await engram.store(turn);
  console.log(`Stored [${turn.role}]: ${turn.content.slice(0, 60)}...`);
}

// Extract structured facts from the conversation
console.log('\nExtracting user facts with Claude...');
await engram.extract();

const facts = await engram.getFacts();
console.log('\nExtracted facts:');
for (const fact of facts) {
  console.log(`  ${fact.key}: ${fact.value}`);
}

// ── Session 2: New conversation — memory is injected automatically ────────────

console.log('\n--- Session 2: New conversation (memory injected automatically) ---\n');

const newQuestion = 'Can you remind me which web framework I decided to use?';
console.log(`User: ${newQuestion}\n`);

// inject() builds the messages array with memory context prepended
const { messages, systemContext } = await engram.inject(newQuestion);

console.log('System context injected:');
console.log(systemContext || '(none)');
console.log(`\nMessages in context window: ${messages.length}`);
console.log(`Last message: ${messages[messages.length - 1].content}\n`);

// Make a real Claude API call with injected memory
console.log('Calling Claude with injected memory...');
const response = await anthropic.messages.create({
  model: 'claude-sonnet-4-6',
  max_tokens: 256,
  system: systemContext || undefined,
  messages,
});

const reply = response.content[0].type === 'text' ? response.content[0].text : '';
console.log(`Claude: ${reply}\n`);

// Store the assistant's reply for future context
await engram.store({ role: 'assistant', content: reply });

// ── Stats ─────────────────────────────────────────────────────────────────────

const stats = await engram.stats();
console.log('--- Memory Stats ---');
console.log(`  Total turns:      ${stats.totalTurns}`);
console.log(`  Active turns:     ${stats.activeTurns}`);
console.log(`  Facts extracted:  ${stats.totalFacts}`);
console.log(`  Est. tokens:      ${stats.estimatedTokens}`);

await engram.close();
console.log('\nDemo complete!');
