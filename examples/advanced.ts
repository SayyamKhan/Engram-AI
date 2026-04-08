/**
 * Engram Advanced Example
 *
 * Demonstrates:
 * - Multi-session memory (context persists across multiple conversations)
 * - Manual compression (summarising long histories)
 * - Keyword search across stored memories
 * - Multiple users with isolated memory
 * - Stats and memory introspection
 *
 * Run:
 *   ANTHROPIC_API_KEY=your_key npx tsx examples/advanced.ts
 */

import Anthropic from '@anthropic-ai/sdk';
import { Engram } from '../src/index.js';

const apiKey = process.env['ANTHROPIC_API_KEY'];
if (!apiKey) {
  console.error('Error: ANTHROPIC_API_KEY environment variable is required.');
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey });

// ── Helper ────────────────────────────────────────────────────────────────────

function section(title: string): void {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(60));
}

function hr(): void {
  console.log('─'.repeat(60));
}

// ── Demo 1: Multi-session persistence ────────────────────────────────────────

section('Demo 1: Multi-session persistence');

const aliceSession1 = new Engram({
  apiKey,
  userId: 'alice',
  dbPath: './advanced-demo.db',
  sessionId: 'alice-session-1',
});

// Populate Alice's first session
const aliceConversation = [
  { role: 'user' as const,      content: "I'm Alice Chen, a senior data scientist at Acme Corp." },
  { role: 'assistant' as const, content: "Great to meet you, Alice! What can I help you with today?" },
  { role: 'user' as const,      content: "I'm working on a customer churn prediction model using XGBoost." },
  { role: 'assistant' as const, content: "XGBoost is an excellent choice for churn prediction. What's your current AUC?" },
  { role: 'user' as const,      content: "Around 0.82. I want to push it above 0.90 using feature engineering." },
  { role: 'assistant' as const, content: "0.82 is solid. For churn, recency/frequency/monetary (RFM) features often give big lifts." },
  { role: 'user' as const,      content: "Great idea! I'll add those. Also, we deploy on AWS SageMaker." },
];

console.log("Populating Alice's first session...");
for (const turn of aliceConversation) {
  await aliceSession1.store(turn);
}
await aliceSession1.extract();
await aliceSession1.close();
console.log('Session 1 closed.\n');

// Open a new session — Alice should have full context
const aliceSession2 = new Engram({
  apiKey,
  userId: 'alice',
  dbPath: './advanced-demo.db',
  sessionId: 'alice-session-2',
});

const question = "What ML model am I using for my project?";
const { messages, systemContext } = await aliceSession2.inject(question);

console.log(`Alice (new session): "${question}"`);
console.log('\nSystem context (memory injected):');
console.log(systemContext || '(none)');

const response = await anthropic.messages.create({
  model: 'claude-sonnet-4-6',
  max_tokens: 200,
  system: systemContext || undefined,
  messages,
});

const reply1 = response.content[0].type === 'text' ? response.content[0].text : '';
console.log(`\nClaude: ${reply1}`);

await aliceSession2.store({ role: 'user',      content: question });
await aliceSession2.store({ role: 'assistant', content: reply1   });

// ── Demo 2: Compression ───────────────────────────────────────────────────────

section('Demo 2: Automatic compression');

// Add more turns to eventually trigger compression
console.log('Adding more conversation turns...');
for (let i = 1; i <= 8; i++) {
  await aliceSession2.store({
    role: i % 2 === 0 ? 'assistant' : 'user',
    content: `Turn ${i}: ${
      i % 2 !== 0
        ? `I have another question about feature importance in XGBoost. ${'Detail '.repeat(20)}`
        : `Great question! Feature importance helps you understand model decisions. ${'Context '.repeat(20)}`
    }`,
  });
}

const statsBefore = await aliceSession2.stats();
console.log(`\nStats before compression:`);
console.log(`  Active turns: ${statsBefore.activeTurns}`);
console.log(`  Est. tokens:  ${statsBefore.estimatedTokens}`);

console.log('\nTriggering compression (threshold: 500 tokens)...');
const compressed = await (new Engram({
  apiKey,
  userId: 'alice',
  dbPath: './advanced-demo.db',
  maxTokensBeforeCompress: 500,
})).compress();

console.log(compressed ? 'Compression performed!' : 'No compression needed.');

const statsAfter = await aliceSession2.stats();
console.log('\nStats after compression:');
console.log(`  Active turns:     ${statsAfter.activeTurns}`);
console.log(`  Compressed turns: ${statsAfter.compressedTurns}`);
console.log(`  Summaries:        ${statsAfter.totalSummaries}`);

// ── Demo 3: Keyword search ────────────────────────────────────────────────────

section('Demo 3: Keyword search across memory');

const searchQuery = 'XGBoost feature engineering';
console.log(`Searching for: "${searchQuery}"`);

const searchResults = await aliceSession2.search(searchQuery, 5);
console.log(`\nTop ${searchResults.length} results:`);
for (const [i, result] of searchResults.entries()) {
  console.log(`  ${i + 1}. [${result.role}] ${result.content.slice(0, 80)}...`);
}

// ── Demo 4: Multiple users — isolated memory ──────────────────────────────────

section('Demo 4: Multiple users with isolated memory');

const bob = new Engram({
  apiKey,
  userId: 'bob',
  dbPath: './advanced-demo.db',
});

await bob.store({ role: 'user',      content: "I'm Bob, a frontend developer who loves React and TypeScript." });
await bob.store({ role: 'assistant', content: "Great! React + TypeScript is a powerful combination." });
await bob.extract();

const aliceFacts = await aliceSession2.getFacts();
const bobFacts   = await bob.getFacts();

console.log(`Alice has ${aliceFacts.length} facts:`);
for (const f of aliceFacts) console.log(`  ${f.key}: ${f.value}`);

hr();
console.log(`Bob has ${bobFacts.length} facts:`);
for (const f of bobFacts) console.log(`  ${f.key}: ${f.value}`);

// ── Demo 5: Full stats ────────────────────────────────────────────────────────

section('Demo 5: Memory stats');

const aliceStats = await aliceSession2.stats();
console.log('Alice memory stats:');
console.log(`  Total turns:      ${aliceStats.totalTurns}`);
console.log(`  Active turns:     ${aliceStats.activeTurns}`);
console.log(`  Compressed turns: ${aliceStats.compressedTurns}`);
console.log(`  Facts:            ${aliceStats.totalFacts}`);
console.log(`  Summaries:        ${aliceStats.totalSummaries}`);
console.log(`  Est. tokens:      ${aliceStats.estimatedTokens}`);

// ── Cleanup ───────────────────────────────────────────────────────────────────

await aliceSession2.close();
await bob.close();

section('Advanced demo complete!');
