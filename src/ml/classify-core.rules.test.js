'use strict';

// Unit tests for the rule-first layer (ruleClassify) — plan Phase 1.
// Every rule gets positive cases AND false-positive guards.

const assert = require('assert');
const {
  ruleClassify, asciiFold, boundedDL, distinctNamedSubsystems,
} = require('./classify-core.js');

let passed = 0, failed = 0;

function expect(prompt, pred, label) {
  const r = ruleClassify(prompt);
  let ok = true;
  for (const k of Object.keys(pred)) {
    if (r[k] !== pred[k]) ok = false;
  }
  if (ok) { passed++; return; }
  failed++;
  console.error(`FAIL [${label}]`);
  console.error(`  prompt: ${JSON.stringify(String(prompt).slice(0, 80))}`);
  console.error(`  expect: ${JSON.stringify(pred)}`);
  console.error(`  got   : ${JSON.stringify(r)}`);
}
function refute(prompt, pred, label) {
  const r = ruleClassify(prompt);
  let matchesAll = true;
  for (const k of Object.keys(pred)) if (r[k] !== pred[k]) matchesAll = false;
  if (!matchesAll) { passed++; return; }
  failed++;
  console.error(`FAIL [${label}] expected NOT ${JSON.stringify(pred)}, got ${JSON.stringify(r)}`);
  console.error(`  prompt: ${JSON.stringify(String(prompt).slice(0, 80))}`);
}

// ── helper sanity ────────────────────────────────────────────────────────────
assert.strictEqual(asciiFold('düzeltİ ŞIĞÜÖÇ'), 'duzelti siguoc', 'asciiFold');
assert.strictEqual(boundedDL('arastir', 'arsatir', 1), 1, 'DL transposition = 1');
assert.ok(boundedDL('foobar', 'design', 1) > 1, 'DL far > max');
assert.strictEqual(distinctNamedSubsystems('migrate auth and payments'), 2, 'two named');
assert.strictEqual(distinctNamedSubsystems('add logging to the orders service'), 1, 'one named');
passed += 5;

// ── Rule 1 — empty / slash → mid ─────────────────────────────────────────────
expect('',               { tier: 'mid',  confident: true, reason: 'rule:1' }, 'r1-empty');
expect('   ',            { tier: 'mid',  confident: true, reason: 'rule:1' }, 'r1-blank');
expect('/calibra status',{ tier: 'mid',  confident: true, reason: 'rule:1' }, 'r1-slash');

// ── Rule 2 — greeting → light ────────────────────────────────────────────────
expect('hi',         { tier: 'light', confident: true, reason: 'rule:2' }, 'r2-hi');
expect('thanks!',    { tier: 'light', confident: true, reason: 'rule:2' }, 'r2-thanks');
expect('teşekkürler',{ tier: 'light', confident: true, reason: 'rule:2' }, 'r2-tr');

// ── Rule 3 — trivial / single mechanical edit → light ────────────────────────
expect('add a console.log here',       { tier: 'light', reason: 'rule:3' }, 'r3-consolelog');
expect('fix a typo in the comment',    { tier: 'light', reason: 'rule:3' }, 'r3-typo');
expect('wrap this in a try-catch',     { tier: 'light', reason: 'rule:3' }, 'r3-trycatch');
expect('add a null check here',        { tier: 'light', reason: 'rule:3' }, 'r3-nullcheck');
expect('add an import statement',      { tier: 'light', reason: 'rule:3' }, 'r3-import');
expect('remove the debug comment',     { tier: 'light', reason: 'rule:3' }, 'r3-remove-comment');
// FP guards: feature work that contains "add" must NOT be caught as single-edit.
refute('add pagination to the user list endpoint', { reason: 'rule:3' }, 'r3-fp-pagination');
refute('add a retry mechanism to the API client',  { reason: 'rule:3' }, 'r3-fp-retry');

// ── Rule 4 — scope → ultra (breadth / enum / ≥2 named subsystems) ─────────────
expect('do a comprehensive overhaul across the entire platform',
  { tier: 'ultra', confident: true, reason: 'rule:4' }, 'r4-breadth');
expect('migrate auth, billing, and orders to the new stack',
  { tier: 'ultra', confident: true, reason: 'rule:4' }, 'r4-enum');
expect('migrate the auth service and the payments service to gRPC',
  { tier: 'ultra', confident: true, reason: 'rule:4' }, 'r4-named-2');
expect('siparis ve odeme servislerini yeniden tasarla',
  { tier: 'ultra', confident: true, reason: 'rule:4' }, 'r4-named-tr');
// FP guards — the DoD case: benign 2-item mid prompt must NOT become ultra.
refute('add a null check and a test', { tier: 'ultra' }, 'r4-fp-nullcheck-test');
refute('add a null check and a test', { reason: 'rule:4' }, 'r4-fp-nullcheck-test-reason');
refute('add logging to the orders service', { tier: 'ultra' }, 'r4-fp-single-named');
refute('refactor the whole file', { reason: 'rule:4' }, 'r4-fp-one-breadth');
// compound-noun guard: adjacent named words = ONE system, not multi-system.
refute('diagnose the slow analytics dashboard', { tier: 'ultra' }, 'r4-fp-compound-noun');
refute('add a metric to the payments gateway', { tier: 'ultra' }, 'r4-fp-compound-gateway');
// typo-stem must not FP English "optimistic" → deep.
refute('add optimistic updates to the favorite button', { reason: 'rule:5' }, 'r5-fp-optimistic');

// ── Rules 5–7 DEFER to ML ────────────────────────────────────────────────────
// Intent-verb and short-no-signal prompts are the genuinely-ambiguous residual:
// a head-to-head showed ML ≥ rule on every eval set, so the cascade defers them.
expect('design the authentication system for this service', { confident: false }, 'r5-defer-design');
expect('analyse the performance bottlenecks in the database', { confident: false }, 'r5-defer-analyse');
expect('refactor the payment module to clean architecture', { confident: false }, 'r5-defer-refactor');
expect('implement pagination for the user list endpoint', { confident: false }, 'r6-defer-implement');
expect('fix the bug in the login handler', { confident: false }, 'r6-defer-fix');
expect('The quick brown fox jumps over the lazy dog several times here',
  { confident: false }, 'r8-residual');

// ── Rule 3 (TR parity) + Rule 3b (recall) → light ────────────────────────────
expect('List the four CRUD operations.', { tier: 'light', confident: true, reason: 'rule:3b' }, 'r3b-list');
expect('What is HTTP 204?', { tier: 'light', confident: true, reason: 'rule:3b' }, 'r3b-whatis');
expect('CRUD işlemlerini listele.', { tier: 'light', confident: true, reason: 'rule:3b' }, 'r3b-tr-listele');
expect('Son satıra noktalı virgül ekle.', { tier: 'light', confident: true, reason: 'rule:3' }, 'r3-tr-semicolon');
expect('profile.email okumadan önce null kontrolü ekle.', { tier: 'light', confident: true, reason: 'rule:3' }, 'r3-tr-null');
expect('Bu JSON nesnesini girintili biçimlendir.', { tier: 'light', confident: true, reason: 'rule:3' }, 'r3-tr-format');
// recall must NOT swallow scoped/multi-system or deep work
refute('list every microservice across the whole platform', { tier: 'light' }, 'r3b-fp-scope');
refute('show me how to design the auth architecture', { tier: 'light' }, 'r3b-fp-deep');
// single-edit: try-catch block + rename-with-article (EN/TR) → light
expect('Add a try-catch block for the user route.', { tier: 'light', reason: 'rule:3' }, 'r3-trycatch-block');
expect('Rename the variable to userId in the handler.', { tier: 'light', reason: 'rule:3' }, 'r3-rename-article');
expect('42. satır için try-catch bloğu ekle.', { tier: 'light', reason: 'rule:3' }, 'r3-tr-trycatch');
// rule 4: account+other / CRM+other / multi-region → ultra
expect('build delivery for payment and account services in two regions',
  { tier: 'ultra', confident: true, reason: 'rule:4' }, 'r4-account-region');
expect('consolidate the core banking ledger and external CRM services',
  { tier: 'ultra', confident: true, reason: 'rule:4' }, 'r4-crm-ledger');
expect('Consolidate the European and Asian regional datacenters.',
  { tier: 'ultra', confident: true, reason: 'rule:4' }, 'r4-multiregion');
// FP guard: single "account" mention must NOT become ultra
refute('update the account balance field', { tier: 'ultra' }, 'r4-fp-single-account');

// ── Fix H: "cross-datacenter" added to CALIBRA_MULTI_REGION → ultra ──────────
// cross-datacenter = primary + replica DC = multi-system by definition (rubric §3).
// CALIBRA_MULTI_REGION already had cross-region; datacenter is the same concept.
expect('Design the cross-datacenter session and cache replication topology.',
  { tier: 'ultra', confident: true, reason: 'rule:4' }, 'fixh-cross-dc');
// FP guard: single-datacenter ops must NOT become ultra
refute('Optimize the query plan in the primary datacenter.', { tier: 'ultra' }, 'fixh-fp-single-dc');

// ── Fix G: "harden" added to CALIBRA_DEEP_INTENT (feature signal) ────────────
// "harden the X" = security hardening = deep by rubric; was missing from vocab.
// Rule 4 ultra-committed prompts are unaffected (rule fires before ML).
// FP guard: rule-4-committed ultra case must not change.
expect('create a complete program to harden every service against the owasp top 10',
  { tier: 'ultra', confident: true, reason: 'rule:4' }, 'fixg-harden-ultra-r4-safe');
// deepC now = 1 for single-service harden prompts → ML deep signal
refute('Harden the JWT flow against token replay in the auth service.', { tier: 'light' }, 'fixg-harden-nolight');
refute('Harden the file-upload endpoint against malicious payloads.', { tier: 'light' }, 'fixg-harden-nolight2');

// ── Fix A: Turkish "X geneli" = org/company-wide breadth signal ──────────────
// scopeCount bumps to 1 → ML gets breadth feature; rule 4 needs ≥2 to commit.
// These are tested indirectly: just ensure they do NOT fire rule:3 (light) or
// rule:4 (ultra) by themselves — they defer to ML with a scope signal.
refute('Sirket geneli feature-flag ve deney platformu mimarlestir.', { tier: 'light' }, 'fixa-nolight-sirket');
refute('Standart hatlarla org geneli CI/CD benimsemeyi planla.', { tier: 'light' }, 'fixa-nolight-org');
// FP guard: "bu servisin geneli" must NOT bump scope (no qualifier before geneli)
refute('Bu servisin geneli icin bir caching stratejisi belirle.', { tier: 'ultra' }, 'fixa-fp-servis-geneli');

// ── Fix B: "yeniden isimlendir" = rename synonym → light (rule 3) ────────────
expect('degiskeni veri olarak yeniden isimlendir.', { tier: 'light', confident: true, reason: 'rule:3' }, 'fixb-isimlendir');
expect('fonksiyonu parseData olarak yeniden isimlendir.', { tier: 'light', confident: true, reason: 'rule:3' }, 'fixb-isimlendir-fn');
refute('tum servisleri ve modulleri yeniden isimlendir', { tier: 'ultra' }, 'fixb-fp-no-ultra');

// ── Fix C: "girintiyi duzelt" = fix indentation → light (rule 3) ─────────────
expect('YAML dosyasindaki girintiyi duzelt.', { tier: 'light', confident: true, reason: 'rule:3' }, 'fixc-girintiy');
refute('YAML dosyasindaki girintiyi duzelt.', { tier: 'mid' }, 'fixc-fp-no-mid');

// ── Fix D: "return ... ekle" TR = add return statement → light (rule 3) ──────
expect('Fonksiyonun sonuna return toplam ekle.', { tier: 'light', confident: true, reason: 'rule:3' }, 'fixd-return-ekle');

// ── Fix E: "add a return false/true/null" EN → light (rule 3) ────────────────
expect('Add a return false when validation fails.', { tier: 'light', confident: true, reason: 'rule:3' }, 'fixe-return-false');
expect('Insert a return null at the top of the function.', { tier: 'light', confident: true, reason: 'rule:3' }, 'fixe-return-null');
refute('Add a return false when validation fails.', { tier: 'mid' }, 'fixe-fp-no-mid');

// ── Fix F: "null guard" = null check → light (rule 3) ────────────────────────
expect('Add a null guard for props.data in the render method.', { tier: 'light', confident: true, reason: 'rule:3' }, 'fixf-null-guard');
refute('Add a null guard for props.data in the render method.', { tier: 'mid' }, 'fixf-fp-no-mid');

// ── totality: never throws on junk ───────────────────────────────────────────
for (const junk of [null, undefined, 123, {}, [], '🙂🙂🙂', 'a'.repeat(5000)]) {
  const r = ruleClassify(junk);
  assert.ok(r && typeof r.confident === 'boolean', 'ruleClassify total on junk');
  passed++;
}

const total = passed + failed;
console.log(`\nruleClassify rules test: ${passed}/${total} passed${failed ? ' — ' + failed + ' FAILED' : ''}`);
if (failed > 0) process.exit(1);
