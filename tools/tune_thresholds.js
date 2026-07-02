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
const CLASSIFIER_PATH = path.join(__dirname, '..', 'src', 'ml', 'tier-classifier.json');

function usage() {
  console.error('Usage: node tools/tune_thresholds.js <calibration.jsonl> [--write]');
  process.exit(2);
}

function parseArgs(argv) {
  const out = { file: argv[2], write: false };
  for (let i = 3; i < argv.length; i++) {
    if (argv[i] === '--write') out.write = true;
    else usage();
  }
  if (!out.file) usage();
  return out;
}

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line, idx) => ({ ...JSON.parse(line), __line: idx + 1 }));
}

function decide(row, thresholds) {
  if (row.fixedTier) return row.fixedTier;
  const atLeast = row.ordinal && row.ordinal.atLeast;
  if (!atLeast) throw new Error('current classifier did not return ordinal probabilities');
  if (atLeast.ultra >= thresholds.ultra) return 'ultra';
  if (atLeast.deep >= thresholds.deep) return 'deep';
  if (atLeast.mid >= thresholds.mid) return 'mid';
  return 'light';
}

function evaluatePredictions(predictions, thresholds) {
  const idx = Object.fromEntries(TIERS.map((tier, i) => [tier, i]));
  const confusion = Array.from({ length: TIERS.length }, () => Array(TIERS.length).fill(0));

  for (const row of predictions) {
    confusion[idx[row.expected]][idx[decide(row, thresholds)]]++;
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

  const perTier = {};
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
    perTier[TIERS[i]] = { precision, recall, f1 };
  }

  return {
    accuracy: correct / Math.max(1, total),
    routingCost: cost / Math.max(1, total),
    underRouteRate: under / Math.max(1, total),
    severeUnderRouteRate: severeUnder / Math.max(1, total),
    overRouteRate: over / Math.max(1, total),
    perTier,
    confusion,
  };
}

function score(report) {
  // Accuracy-first objective (lower is better). Calibra's primary metric is the
  // share of prompts routed to the correct tier, so accuracy dominates. A small
  // penalty discourages SEVERE under-routing (deep/ultra dropped 2+ tiers, the
  // failure users actually feel) and a tiny one nudges away from over-routing
  // ties. Per-tier recall floors keep any single tier from collapsing.
  const recall = report.perTier;
  const floors =
    Math.max(0, 0.70 - recall.light.recall) +
    Math.max(0, 0.70 - recall.mid.recall) +
    Math.max(0, 0.70 - recall.deep.recall) +
    Math.max(0, 0.70 - recall.ultra.recall);

  return -report.accuracy +
    report.severeUnderRouteRate * 0.5 +
    report.overRouteRate * 0.05 +
    floors * 0.3;
}

async function collectPredictions(rows) {
  const out = [];
  for (const row of rows) {
    const pred = await classifyML(row.prompt);
    out.push({
      expected: row.tier,
      ordinal: pred.ordinal,
      fixedTier: pred.ordinal && pred.ordinal.atLeast ? null : pred.tier,
    });
  }
  return out;
}

function roundReport(report) {
  return {
    accuracy: Number(report.accuracy.toFixed(4)),
    routingCost: Number(report.routingCost.toFixed(4)),
    underRouteRate: Number(report.underRouteRate.toFixed(4)),
    severeUnderRouteRate: Number(report.severeUnderRouteRate.toFixed(4)),
    overRouteRate: Number(report.overRouteRate.toFixed(4)),
    perTier: Object.fromEntries(Object.entries(report.perTier).map(([tier, m]) => [tier, {
      precision: Number(m.precision.toFixed(4)),
      recall: Number(m.recall.toFixed(4)),
      f1: Number(m.f1.toFixed(4)),
    }])),
    confusion: Object.fromEntries(TIERS.map((tier, i) => [
      tier,
      Object.fromEntries(TIERS.map((pred, j) => [pred, report.confusion[i][j]])),
    ])),
  };
}

function applyThresholds(thresholds, report, calibrationFile) {
  const artifact = JSON.parse(fs.readFileSync(CLASSIFIER_PATH, 'utf8'));
  if (!Array.isArray(artifact.ordinalHeads)) throw new Error('classifier artifact is not ordinal');
  for (const head of artifact.ordinalHeads) {
    head.threshold = thresholds[head.name];
  }
  artifact.training ||= {};
  artifact.training.productionThresholds = thresholds;
  artifact.training.calibrationTuning = {
    file: path.relative(path.join(__dirname, '..'), calibrationFile),
    thresholds,
    report: roundReport(report),
    tunedAt: new Date().toISOString(),
  };
  fs.writeFileSync(CLASSIFIER_PATH, JSON.stringify(artifact, null, 0) + '\n');
}

async function main() {
  const args = parseArgs(process.argv);
  const rows = readJsonl(args.file);
  const predictions = await collectPredictions(rows);
  const values = [];
  for (let v = 0.2; v <= 0.700001; v += 0.025) values.push(Number(v.toFixed(3)));

  let best = null;
  for (const mid of values) {
    for (const deep of values) {
      for (const ultra of values) {
        // Monotonic constraint: the bar to escalate must not drop at higher
        // tiers. Non-monotonic combos (e.g. mid > deep) can win on one dev set
        // but generalize poorly to other prompt distributions.
        if (!(mid <= deep && deep <= ultra)) continue;
        const thresholds = { mid, deep, ultra };
        const report = evaluatePredictions(predictions, thresholds);
        const objective = score(report);
        if (!best || objective < best.objective) {
          best = { thresholds, objective, report };
        }
      }
    }
  }

  const output = {
    calibrationFile: path.resolve(args.file),
    thresholds: best.thresholds,
    objective: Number(best.objective.toFixed(6)),
    report: roundReport(best.report),
    wrote: args.write,
  };

  if (args.write) applyThresholds(best.thresholds, best.report, args.file);
  console.log(JSON.stringify(output, null, 2));
}

main().catch(e => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
