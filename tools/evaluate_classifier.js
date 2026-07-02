#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const { classifyML } = require('../src/ml/calibra-ml.js');

const TIERS = ['light', 'mid', 'deep', 'ultra'];
const ROUTING_COSTS = [
  [0, 1, 3, 6],
  [4, 0, 1, 3],
  [8, 3, 0, 1],
  [12, 8, 3, 0],
];

function usage() {
  console.error('Usage: node tools/evaluate_classifier.js <file.jsonl> [--top N]');
  process.exit(2);
}

function parseArgs(argv) {
  const args = { file: argv[2], top: 20 };
  for (let i = 3; i < argv.length; i++) {
    if (argv[i] === '--top') args.top = Number(argv[++i]);
    else usage();
  }
  if (!args.file) usage();
  return args;
}

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line, idx) => {
      const row = JSON.parse(line);
      if (!row.prompt || !TIERS.includes(row.tier)) {
        throw new Error(`${file}:${idx + 1}: invalid row`);
      }
      return { ...row, __line: idx + 1 };
    });
}

function rate(ok, total) {
  return Number((ok / Math.max(1, total)).toFixed(4));
}

function perTierMetrics(confusion) {
  const out = {};
  for (let i = 0; i < TIERS.length; i++) {
    const tp = confusion[i][i];
    let fp = 0, fn = 0;
    for (let j = 0; j < TIERS.length; j++) {
      if (j !== i) {
        fp += confusion[j][i];
        fn += confusion[i][j];
      }
    }
    const precision = tp / Math.max(1, tp + fp);
    const recall = tp / Math.max(1, tp + fn);
    const f1 = 2 * precision * recall / Math.max(1e-8, precision + recall);
    out[TIERS[i]] = {
      precision: Number(precision.toFixed(4)),
      recall: Number(recall.toFixed(4)),
      f1: Number(f1.toFixed(4)),
      support: confusion[i].reduce((a, b) => a + b, 0),
    };
  }
  return out;
}

function confusionObject(confusion) {
  return Object.fromEntries(TIERS.map((tier, i) => [
    tier,
    Object.fromEntries(TIERS.map((pred, j) => [pred, confusion[i][j]])),
  ]));
}

async function evaluate(file, top) {
  const rows = readJsonl(file);
  const tierIdx = Object.fromEntries(TIERS.map((tier, i) => [tier, i]));
  const confusion = Array.from({ length: TIERS.length }, () => Array(TIERS.length).fill(0));
  const typo = { true: { ok: 0, total: 0 }, false: { ok: 0, total: 0 }, missing: { ok: 0, total: 0 } };
  const domains = {};
  const groups = {};
  const mistakes = [];

  for (const row of rows) {
    const predicted = await classifyML(row.prompt);
    const actualIdx = tierIdx[row.tier];
    const predIdx = tierIdx[predicted.tier];
    const ok = row.tier === predicted.tier;
    confusion[actualIdx][predIdx]++;

    const typoKey = row.hasTypo === true ? 'true' : row.hasTypo === false ? 'false' : 'missing';
    typo[typoKey].total++;
    if (ok) typo[typoKey].ok++;

    const domain = row.domain || '(missing)';
    domains[domain] ||= { ok: 0, total: 0 };
    domains[domain].total++;
    if (ok) domains[domain].ok++;

    if (row.stressGroup) {
      groups[row.stressGroup] ||= { ok: 0, total: 0 };
      groups[row.stressGroup].total++;
      if (ok) groups[row.stressGroup].ok++;
    }

    if (!ok) {
      mistakes.push({
        line: row.__line,
        expected: row.tier,
        predicted: predicted.tier,
        rawTier: predicted.rawTier,
        score: Number((predicted.score || 0).toFixed(4)),
        rawScore: Number((predicted.rawScore || predicted.score || 0).toFixed(4)),
        margin: predicted.margin === undefined ? null : Number(predicted.margin.toFixed(4)),
        hasTypo: row.hasTypo,
        domain,
        stressGroup: row.stressGroup,
        prompt: row.prompt,
      });
    }
  }

  let correct = 0, total = 0, cost = 0, under = 0, severeUnder = 0, over = 0;
  for (let actual = 0; actual < TIERS.length; actual++) {
    for (let pred = 0; pred < TIERS.length; pred++) {
      const n = confusion[actual][pred];
      total += n;
      if (actual === pred) correct += n;
      if (pred < actual) {
        under += n;
        if (actual - pred >= 2) severeUnder += n;
      }
      if (pred > actual) over += n;
      cost += n * ROUTING_COSTS[actual][pred];
    }
  }

  mistakes.sort((a, b) => b.rawScore - a.rawScore);

  return {
    file: path.resolve(file),
    rows: total,
    accuracy: rate(correct, total),
    routingCost: Number((cost / Math.max(1, total)).toFixed(4)),
    underRouteRate: rate(under, total),
    severeUnderRouteRate: rate(severeUnder, total),
    overRouteRate: rate(over, total),
    perTier: perTierMetrics(confusion),
    confusion: confusionObject(confusion),
    byTypo: Object.fromEntries(Object.entries(typo).map(([k, v]) => [k, rate(v.ok, v.total)])),
    byDomain: Object.fromEntries(Object.entries(domains).map(([k, v]) => [k, rate(v.ok, v.total)])),
    byStressGroup: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, rate(v.ok, v.total)])),
    mistakeCount: mistakes.length,
    topMistakes: mistakes.slice(0, top),
  };
}

async function main() {
  const args = parseArgs(process.argv);
  console.log(JSON.stringify(await evaluate(args.file, args.top), null, 2));
}

main().catch(e => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
