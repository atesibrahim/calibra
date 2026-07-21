#!/usr/bin/env node
'use strict';

// relabel_by_rubric.js — apply the deterministic bright-line RUBRIC (ruleClassify,
// NOT the ML) to a .jsonl, emitting a rubric-tier per row. Measurement transform
// only: originals are never modified, output is for REPORTING (never fed to fit).
//
// Usage: node tools/relabel_by_rubric.js <in.jsonl> [<in2.jsonl> ...]
//   writes <name>_rubric.jsonl beside each input and prints an agreement report.
//
// Residual rows (ruleClassify → confident:false) KEEP the original label, reason
// 'rule:8-keep-original'. The rubric only OVERRIDES where it is confident; for
// the genuinely-ambiguous residual it declines to relabel and trusts the
// original annotation (which the ML head will decide at eval time). This keeps
// the rubric honest — it never labels a deferred ultra prompt as mid.

const fs = require('fs');
const path = require('path');
const { ruleClassify } = require('../src/ml/classify-core.js');

const TIERS = ['light', 'mid', 'deep', 'ultra'];

function rubricTier(prompt, origTier) {
  const r = ruleClassify(prompt);
  if (r.confident) return { tier: r.tier, reason: r.reason };
  return { tier: origTier, reason: 'rule:8-keep-original' };
}

function relabelFile(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const out = [];
  const confusion = Object.fromEntries(TIERS.map(a => [a, Object.fromEntries(TIERS.map(p => [p, 0]))]));
  const reasonCounts = {};
  let agree = 0, total = 0;

  for (const line of lines) {
    const row = JSON.parse(line);
    const orig = row.tier;
    const { tier, reason } = rubricTier(row.prompt, orig);
    reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
    if (TIERS.includes(orig)) {
      total++;
      if (orig === tier) agree++;
      confusion[orig][tier]++;
    }
    out.push(JSON.stringify({ ...row, tier, origTier: orig, rubricReason: reason }));
  }

  const outFile = file.replace(/\.jsonl$/, '_rubric.jsonl');
  fs.writeFileSync(outFile, out.join('\n') + '\n');

  return { file, outFile, total, agree, confusion, reasonCounts };
}

function printReport(r) {
  console.log(`\n=== ${path.basename(r.file)} ===`);
  console.log(`  rows: ${r.total}  rubric-vs-original agreement: ${(100 * r.agree / Math.max(1, r.total)).toFixed(1)}%`);
  console.log(`  → wrote ${path.basename(r.outFile)}`);
  console.log('  confusion (row=original label, col=rubric tier):');
  console.log('          ' + TIERS.map(t => t.padStart(6)).join(''));
  for (const a of TIERS) {
    console.log('   ' + a.padEnd(6) + TIERS.map(p => String(r.confusion[a][p]).padStart(6)).join(''));
  }
  const reasons = Object.entries(r.reasonCounts).sort((a, b) => b[1] - a[1]);
  console.log('  rubric reasons: ' + reasons.map(([k, v]) => `${k}=${v}`).join(' '));
  const ruleDecided = Object.entries(r.reasonCounts)
    .filter(([k]) => k !== 'rule:8-keep-original')
    .reduce((s, [, v]) => s + v, 0);
  console.log(`  rule-decided (confident): ${(100 * ruleDecided / Math.max(1, r.total)).toFixed(1)}%  (residual→ML, kept original: ${r.reasonCounts['rule:8-keep-original'] || 0})`);
}

function main() {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error('Usage: node tools/relabel_by_rubric.js <in.jsonl> [...]');
    process.exit(2);
  }
  for (const f of files) printReport(relabelFile(f));
}

main();
