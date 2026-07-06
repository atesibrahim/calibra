'use strict';

const assert = require('assert');
const { correctTypos, correctWord } = require('./spellcorrect.js');

let passed = 0;
let failed = 0;

function check(actual, expected, label) {
  if (actual === expected) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL [${label}]`);
    console.error(`  expect : ${JSON.stringify(expected)}`);
    console.error(`  got    : ${JSON.stringify(actual)}`);
  }
}

// ── English typo correction ───────────────────────────────────────────────────
check(correctTypos('do a secuity check on this project for owasp top 10'),
      'do a security check on this project for owasp top 10', 'en-secuity');
check(correctTypos('recieve the payload and update the databse schema'),
      'receive the payload and update the database schema', 'en-recieve-databse');

// ── British spellings must NOT be "corrected" into a different word ──────────
check(correctTypos('analyse the performance bottlenecks in the database queries'),
      'analyse the performance bottlenecks in the database queries', 'en-gb-analyse');
check(correctTypos('optimise this query and harden the endpoint'),
      'optimise this query and harden the endpoint', 'en-gb-optimise-harden');

// ── Turkish typo correction (ascii + diacritic forms) ─────────────────────────
check(correctTypos('güvenlik konusunda bir analz yap'),
      'güvenlik konusunda bir analiz yap', 'tr-analz');

// ── Programming jargon not in any dictionary must be left alone ──────────────
check(correctTypos('update the docstring'), 'update the docstring', 'jargon-docstring');
check(correctTypos('do a secuity check on owasp top 10'),
      'do a security check on owasp top 10', 'jargon-owasp-untouched');

// ── Code fences must never be touched ─────────────────────────────────────────
check(correctTypos('fix secuity here\n```\nconst secuity = requireSecuity();\n```\nand secuity there'),
      'fix security here\n```\nconst secuity = requireSecuity();\n```\nand security there',
      'code-fence-preserved');

// ── Identifiers / constants / already-correct text pass through unchanged ────
check(correctTypos('SOME_CONST and camelCaseVar should stay, foo.bar@baz too'),
      'SOME_CONST and camelCaseVar should stay, foo.bar@baz too', 'identifiers-untouched');
check(correctTypos('this sentence is already correctly spelled'),
      'this sentence is already correctly spelled', 'noop-already-correct');

// ── correctWord in isolation ──────────────────────────────────────────────────
check(correctWord('secuity'), 'security', 'word-secuity');
check(correctWord('abc'), 'abc', 'word-too-short-skipped');
check(correctWord('NASA'), 'NASA', 'word-acronym-skipped');

// ── Fail-soft: never throws on odd input ──────────────────────────────────────
assert.doesNotThrow(() => correctTypos(''), 'empty string must not throw');
assert.doesNotThrow(() => correctTypos(null), 'null must not throw');
assert.doesNotThrow(() => correctTypos(undefined), 'undefined must not throw');
passed += 3;

console.log(`\nspellcorrect test: ${passed}/${passed + failed} passed${failed ? ' — ' + failed + ' FAILED' : ''}`);
process.exit(failed ? 1 : 0);
