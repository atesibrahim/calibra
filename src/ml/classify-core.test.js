'use strict';

const assert = require('assert');
const path   = require('path');

// Test calibraClassify via saka-proxy (the authoritative export)
const { calibraClassify } = require(path.join(__dirname, '..', 'saka-proxy.js'));

let passed = 0;
let failed = 0;

function check(prompt, expected, label) {
  const result = calibraClassify(prompt);
  let ok = true;
  if (expected.tier   !== undefined && result.tier   !== expected.tier)   ok = false;
  if (expected.reason !== undefined && result.reason !== expected.reason) ok = false;
  if (expected.score  !== undefined && result.score  !== expected.score)  ok = false;
  if (ok) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL [${label}]`);
    console.error(`  prompt : ${JSON.stringify(prompt.slice(0, 80))}`);
    console.error(`  expect : ${JSON.stringify(expected)}`);
    console.error(`  got    : tier=${result.tier} score=${result.score} reason=${result.reason}`);
  }
}

// ── Greetings → light / greeting ─────────────────────────────────────────────
check('hi',                          { tier: 'light', score: 0, reason: 'greeting' },             'greeting-hi');
check('hello!',                      { tier: 'light', score: 0, reason: 'greeting' },             'greeting-hello');
check('hey',                         { tier: 'light', score: 0, reason: 'greeting' },             'greeting-hey');
check('thanks',                      { tier: 'light', score: 0, reason: 'greeting' },             'greeting-thanks');
check('ok',                          { tier: 'light', score: 0, reason: 'greeting' },             'greeting-ok');
check('merhaba',                     { tier: 'light', score: 0, reason: 'greeting' },             'greeting-tr-merhaba');
check('tamam',                       { tier: 'light', score: 0, reason: 'greeting' },             'greeting-tr-tamam');
check('teşekkürler',                 { tier: 'light', score: 0, reason: 'greeting' },             'greeting-tr-tesekkur');

// ── Trivial one-liners → light / trivial-regex ────────────────────────────────
check('add a console.log here',      { tier: 'light', score: 0, reason: 'trivial-regex' },        'trivial-consolelog');
check('fix a typo in the comment',   { tier: 'light', score: 0, reason: 'trivial-regex' },        'trivial-typo');
check('rename the variable foo',     { tier: 'light', score: 0 },                               'trivial-rename');
check('format this file',            { tier: 'light', score: 0, reason: 'trivial-regex' },        'trivial-format');
check('update the docstring',        { tier: 'light', score: 0, reason: 'trivial-regex' },        'trivial-docstring');
check('write a unit test',           { tier: 'light', score: 0, reason: 'trivial-regex' },        'trivial-unittest');
check('yorum ekle',                  { tier: 'light', score: 0, reason: 'trivial-regex' },        'trivial-tr-yorum');

// ── Short-conversational → light ──────────────────────────────────────────────
check('what is this?',               { tier: 'light', score: 0, reason: 'short-conversational' }, 'short-conv-1');
check('how does it work',            { tier: 'light', score: 0, reason: 'short-conversational' }, 'short-conv-2');
check('any ideas',                   { tier: 'light', score: 0, reason: 'short-conversational' }, 'short-conv-3');

// ── Slash commands → mid / slash/empty ───────────────────────────────────────
check('/calibra status',             { tier: 'mid', score: -1, reason: 'slash/empty' },           'slash-calibra');
check('/help',                       { tier: 'mid', score: -1, reason: 'slash/empty' },           'slash-help');
check('',                            { tier: 'mid', score: -1, reason: 'slash/empty' },           'empty');

// ── Mid-intent tasks → mid ────────────────────────────────────────────────────
check('fix the bug in the login handler',
  { tier: 'mid' }, 'mid-fix-bug');
check('add a retry mechanism to the API client',
  { tier: 'mid' }, 'mid-add-retry');
check('write a function to parse JWT tokens',
  { tier: 'mid' }, 'mid-write-fn');
check('explain how the authentication middleware works',
  { tier: 'mid' }, 'mid-explain');
check('add multi-region failover support to the deployment pipeline',
  { tier: 'mid' }, 'mid-add-failover');
check('implement pagination for the user list endpoint',
  { tier: 'mid' }, 'mid-implement-pagination');

// ── Deep-intent → deep (floor rule: deep intent always ≥ deep) ───────────────
check('design the authentication system for this service',
  { tier: 'deep' }, 'deep-design-auth');
check('review the security posture of the API layer',
  { tier: 'deep' }, 'deep-security-review');
check('analyse the performance bottlenecks in the database queries',
  { tier: 'deep' }, 'deep-analyse-perf');
check('refactor the payment module to use clean architecture',
  { tier: 'deep' }, 'deep-refactor');
check('evaluate the trade-offs between microservices and a monolith',
  { tier: 'deep' }, 'deep-tradeoffs');
check('mimari tasarım öner',
  { tier: 'deep' }, 'deep-tr-mimari');

// ── Ultra: long + deep + scope ────────────────────────────────────────────────
check(
  'Please do a comprehensive end-to-end security audit of our entire authentication and authorization system. ' +
  'I need you to analyse every layer: API gateway, JWT validation, session management, rate limiting, ' +
  'and the database access patterns. Evaluate the trade-offs between our current architecture and a ' +
  'zero-trust model. Identify all vulnerabilities and propose a complete remediation strategy with ' +
  'prioritized steps. This is a distributed system running on Kubernetes with a microservices architecture.',
  { tier: 'ultra' },
  'ultra-comprehensive-audit'
);
check(
  'Design a complete from-scratch event-driven distributed system for real-time payment processing. ' +
  'The system must handle throughput of 100k TPS, ensure consistency via a consensus protocol, ' +
  'support sharding across regions, and include a full observability stack. Provide exhaustive ' +
  'architecture diagrams, evaluate every trade-off, and propose a detailed end-to-end migration plan ' +
  'from our existing monolith including schema migration strategy and dual-write reconciliation.',
  { tier: 'ultra' },
  'ultra-distributed-payment'
);

// ── Broadened trivial one-liners → light ─────────────────────────────────────
check('add a console.warn for the empty array case',
  { tier: 'light', reason: 'trivial-regex' }, 'trivial-console-warn');
check("correct the misspelled word 'depenency' in package notes",
  { tier: 'light', reason: 'trivial-regex' }, 'trivial-misspelled');
check('fix the broken markdown bullet in this list',
  { tier: 'light', reason: 'trivial-regex' }, 'trivial-broken-markdown');
check('change the timeout number from 3000 to 5000',
  { tier: 'light', reason: 'trivial-regex' }, 'trivial-change-number');

// ── Lexical features + scope guard (ML hybrid helpers) ───────────────────────
{
  const { lexicalFeatures, scopeCount, applyRoutingGuards } = require('./classify-core.js');

  assert.strictEqual(lexicalFeatures('design a distributed cache').length, 14,
    'lexicalFeatures must be fixed length 14');

  // Extended breadth vocabulary: "X-wide" and "across" count as scope.
  assert.ok(scopeCount('a company-wide migration across every cluster') >= 2,
    'company-wide + across + every should count >= 2 breadth words');
  assert.strictEqual(scopeCount('fix the login bug'), 0, 'no breadth words');

  // Ultra ceiling guard: >=2 breadth words promotes any tier to ultra.
  assert.strictEqual(
    applyRoutingGuards('lead a company-wide overhaul across the entire platform', 'deep'),
    'ultra', 'strong breadth must promote deep -> ultra');
  // ...but a single breadth word must NOT promote (avoids false positives).
  assert.strictEqual(applyRoutingGuards('refactor the whole file', 'mid'), 'mid',
    'one breadth word must not promote');
  assert.strictEqual(applyRoutingGuards('fix the bug', 'mid'), 'mid',
    'no breadth words must not promote');
  passed += 6;
}

// ── engine field present ──────────────────────────────────────────────────────
{
  const r = calibraClassify('design a new caching layer');
  assert.strictEqual(r.engine, 'heuristic', 'engine field must be heuristic');
  passed++;
}

// ── Summary ───────────────────────────────────────────────────────────────────
const total = passed + failed;
console.log(`\nclassify-core golden test: ${passed}/${total} passed${failed ? ' — ' + failed + ' FAILED' : ''}`);
if (failed > 0) process.exit(1);
