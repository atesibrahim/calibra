#!/usr/bin/env node
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { tokenize } = require('../src/ml/tokenizer.js');
const { TIERS, sigmoid, softmax, buildFeatureVector, classifyEmbedding } = require('../src/ml/linear-classifier.js');

const ROOT         = path.join(__dirname, '..');
const CALIBRA_BASE = path.join(os.homedir(), '.claude-corp', 'calibra');
const MODEL_PATH   = process.env.CALIBRA_ML_MODEL_PATH ||
  path.join(CALIBRA_BASE, 'models', 'router.onnx');
const DATA_PATH    = path.join(__dirname, 'eval_prompts.jsonl');
const STRESS_PATH  = path.join(__dirname, 'stress_prompts.jsonl');
// Full extra-training corpus that reproduces the shipped classifier. All files
// are disjoint from final_holdout_opus_500.jsonl (the sole held-out test set).
const EXTRA_TRAIN_FILES = [
  'extra_train_prompts.jsonl',
  'contrastive_train_opus_1200.jsonl',
  'targeted_train_opus_800.jsonl',
  'targeted_train_opus_600_v2_selected.jsonl',
  'calibration_500.jsonl',
  'stress_300.jsonl',
  'targeted_train_hard_v3.jsonl',
  'boundary_train_v4.jsonl',
].map(f => path.join(__dirname, f)).filter(fs.existsSync);
const EXTRA_TRAIN_PATH = EXTRA_TRAIN_FILES.join(',');
const OUTPUT_PATH  = path.join(ROOT, 'src', 'ml', 'tier-classifier.json');

const HIDDEN_SIZE = parseInt(process.env.CALIBRA_ML_HIDDEN, 10) || 384;
const MAX_LENGTH  = 256;
const ROUTING_COSTS = [
  [0, 1, 3, 6],
  [4, 0, 1, 3],
  [8, 3, 0, 1],
  [12, 8, 3, 0],
];
const ORDINAL_HEADS = [
  { name: 'mid', minRank: 1 },
  { name: 'deep', minRank: 2 },
  { name: 'ultra', minRank: 3 },
];

function parseArgs(argv) {
  const out = {
    data: DATA_PATH,
    extraTrain: EXTRA_TRAIN_PATH || null,
    stress: fs.existsSync(STRESS_PATH) ? STRESS_PATH : null,
    output: OUTPUT_PATH,
    holdout: 0.2,
    seed: 42,
    epochs: 140,
    lr: 0.18,
    l2: 0.0007,
    typoAugment: 1,
    wrapperAugment: 1,
    modelType: 'ordinal',
    featureVersion: 2,
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--data') out.data = next();
    else if (a === '--extra-train') out.extraTrain = next();
    else if (a === '--no-extra-train') out.extraTrain = null;
    else if (a === '--stress') out.stress = next();
    else if (a === '--no-stress') out.stress = null;
    else if (a === '--out') out.output = next();
    else if (a === '--holdout') out.holdout = Number(next());
    else if (a === '--seed') out.seed = Number(next());
    else if (a === '--epochs') out.epochs = Number(next());
    else if (a === '--lr') out.lr = Number(next());
    else if (a === '--l2') out.l2 = Number(next());
    else if (a === '--typo-augment') out.typoAugment = Number(next());
    else if (a === '--wrapper-augment') out.wrapperAugment = Number(next());
    else if (a === '--model') out.modelType = next();
    else if (a === '--feature-version') out.featureVersion = Number(next());
    else if (a === '--hidden') out.hidden = Number(next());
    else usage(`unknown argument: ${a}`);
  }

  if (!(out.holdout > 0 && out.holdout < 0.5)) usage('--holdout must be > 0 and < 0.5');
  if (!['ordinal', 'softmax', 'mlp'].includes(out.modelType)) usage('--model must be ordinal, softmax or mlp');
  return out;
}

function usage(msg) {
  if (msg) console.error(msg);
  console.error('Usage: node tools/train_tier_classifier.js [--model ordinal|softmax] [--data file.jsonl] [--extra-train file.jsonl] [--stress file.jsonl] [--out file.json]');
  process.exit(2);
}

function requireOrt() {
  try {
    return require('onnxruntime-node');
  } catch {
    return require(path.join(CALIBRA_BASE, 'node_modules', 'onnxruntime-node'));
  }
}

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line, idx) => {
      const row = JSON.parse(line);
      if (!row.prompt || !TIERS.includes(row.tier)) {
        throw new Error(`${file}:${idx + 1}: expected {"prompt":"...","tier":"${TIERS.join('|')}"}`);
      }
      return row;
    });
}

function readManyJsonl(files) {
  const out = [];
  for (const file of files) out.push(...readJsonl(file));
  return out;
}

function assertNoPromptOverlap(trainRows, stressRows, trainLabel, stressLabel) {
  if (!trainRows.length || !stressRows.length) return;
  const trainPrompts = new Map();
  trainRows.forEach((row, idx) => trainPrompts.set(row.prompt, idx + 1));

  const overlaps = [];
  stressRows.forEach((row, idx) => {
    if (trainPrompts.has(row.prompt)) {
      overlaps.push({
        prompt: row.prompt,
        trainLine: trainPrompts.get(row.prompt),
        stressLine: idx + 1,
      });
    }
  });

  if (overlaps.length) {
    const details = overlaps.slice(0, 8)
      .map(o => `${trainLabel}:${o.trainLine} overlaps ${stressLabel}:${o.stressLine} ${JSON.stringify(o.prompt)}`)
      .join('\n');
    throw new Error(`stress/train prompt overlap detected:\n${details}`);
  }
}

function mulberry32(seed) {
  return function rand() {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function shuffle(arr, seed) {
  const rand = mulberry32(seed);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function stratifiedSplit(rows, holdout, seed) {
  const byTier = new Map(TIERS.map(t => [t, []]));
  rows.forEach((row, i) => byTier.get(row.tier).push(i));

  const train = [];
  const test  = [];
  TIERS.forEach((tier, tierIdx) => {
    const idxs = shuffle(byTier.get(tier).slice(), seed + tierIdx * 997);
    const nTest = Math.max(1, Math.round(idxs.length * holdout));
    test.push(...idxs.slice(0, nTest));
    train.push(...idxs.slice(nTest));
  });

  return { train: shuffle(train, seed + 12345), test: shuffle(test, seed + 54321) };
}

function typoVariant(text, seed) {
  const rand = mulberry32(seed);
  const words = text.split(/(\s+)/);
  const candidates = [];

  for (let i = 0; i < words.length; i++) {
    const clean = words[i].replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (/^[\p{L}][\p{L}\p{N}-]{5,}$/u.test(clean)) candidates.push(i);
  }

  if (!candidates.length) return null;

  const idx = candidates[Math.floor(rand() * candidates.length)];
  const word = words[idx];
  const match = word.match(/^([^\p{L}\p{N}]*)([\p{L}\p{N}-]+)([^\p{L}\p{N}]*)$/u);
  if (!match) return null;

  const chars = Array.from(match[2]);
  if (chars.length < 6) return null;

  const op = Math.floor(rand() * 3);
  const pos = Math.max(1, Math.min(chars.length - 2, Math.floor(rand() * chars.length)));
  if (op === 0) {
    chars.splice(pos, 1);
  } else if (op === 1) {
    [chars[pos], chars[pos + 1]] = [chars[pos + 1], chars[pos]];
  } else {
    chars[pos] = chars[pos - 1];
  }

  words[idx] = match[1] + chars.join('') + match[3];
  const out = words.join('');
  return out === text ? null : out;
}

function makeTypoAugmentRows(rows, idxs, copies, seed) {
  if (!copies || copies < 1) return [];
  const out = [];
  for (let copy = 0; copy < copies; copy++) {
    for (const rowIdx of idxs) {
      const row = rows[rowIdx];
      const prompt = typoVariant(row.prompt, seed + copy * 1000003 + rowIdx * 37);
      if (prompt) out.push({ prompt, tier: row.tier, augmented: true });
    }
  }
  return out;
}

function makeWrapperAugmentRows(rows, idxs, copies, seed) {
  if (!copies || copies < 1) return [];
  const wrappers = [
    text => `can you ${text} please`,
    text => `could you ${text}`,
    text => `hey, ${text}`,
    text => `please ${text} thanks`,
    text => `urgent: ${text}`,
  ];
  const out = [];
  for (let copy = 0; copy < copies; copy++) {
    for (const rowIdx of idxs) {
      const row = rows[rowIdx];
      const rand = mulberry32(seed + copy * 1000003 + rowIdx * 53);
      const prompt = wrappers[Math.floor(rand() * wrappers.length)](row.prompt);
      out.push({ prompt, tier: row.tier, augmented: true, wrapperAugmented: true });
    }
  }
  return out;
}

function meanPool(hidden, mask, seqLen) {
  const out = new Float32Array(HIDDEN_SIZE);
  let count = 0;
  for (let i = 0; i < seqLen; i++) {
    if (!mask[i]) continue;
    count++;
    const off = i * HIDDEN_SIZE;
    for (let j = 0; j < HIDDEN_SIZE; j++) out[j] += hidden[off + j];
  }
  if (count > 0) for (let j = 0; j < HIDDEN_SIZE; j++) out[j] /= count;
  return out;
}

function l2Normalize(v) {
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) + 1e-8;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

async function embed(session, ort, text) {
  const { input_ids, attention_mask, token_type_ids } = tokenize(text, MAX_LENGTH);
  const seqLen = input_ids.length;

  function t(arr) {
    return new ort.Tensor('int64', BigInt64Array.from(arr, v => BigInt(v)), [1, arr.length]);
  }

  const results = await session.run({
    input_ids:      t(input_ids),
    attention_mask: t(attention_mask),
    token_type_ids: t(token_type_ids),
  });

  const hidden = results.last_hidden_state?.data ?? results[session.outputNames[0]].data;
  return l2Normalize(meanPool(hidden, attention_mask, seqLen));
}

async function embedRows(rows) {
  if (!fs.existsSync(MODEL_PATH)) throw new Error(`model not found: ${MODEL_PATH}`);
  const ort = requireOrt();
  const session = await ort.InferenceSession.create(MODEL_PATH);

  const xs = [];
  for (let i = 0; i < rows.length; i++) {
    xs.push(await embed(session, ort, rows[i].prompt));
    if ((i + 1) % 25 === 0 || i + 1 === rows.length) {
      process.stdout.write(`\r  embeddings: ${i + 1}/${rows.length}`);
    }
  }
  process.stdout.write('\n');
  return xs;
}

function classWeights(rows, idxs) {
  const counts = Object.fromEntries(TIERS.map(t => [t, 0]));
  for (const i of idxs) counts[rows[i].tier]++;
  const total = idxs.length;
  return Object.fromEntries(TIERS.map(t => [t, total / (TIERS.length * Math.max(1, counts[t]))]));
}

function binaryClassWeights(rows, idxs, minRank) {
  let pos = 0;
  let neg = 0;
  for (const i of idxs) {
    if (TIERS.indexOf(rows[i].tier) >= minRank) pos++;
    else neg++;
  }
  const total = pos + neg;
  return {
    pos: total / (2 * Math.max(1, pos)),
    neg: total / (2 * Math.max(1, neg)),
  };
}

function fitSoftmax(xs, rows, idxs, opts) {
  const k = TIERS.length;
  const featureRows = xs.map((x, i) => buildFeatureVector(x, rows[i].prompt, { featureVersion: opts.featureVersion }));
  const d = featureRows[0].length;
  const weights = Array.from({ length: k }, () => new Array(d).fill(0));
  const bias    = new Array(k).fill(0);
  const tierToClass = Object.fromEntries(TIERS.map((t, i) => [t, i]));
  const cw = classWeights(rows, idxs);

  for (let epoch = 0; epoch < opts.epochs; epoch++) {
    shuffle(idxs, opts.seed + epoch * 17);
    const lr = opts.lr / Math.sqrt(1 + epoch * 0.03);

    for (const rowIdx of idxs) {
      const x = featureRows[rowIdx];
      const y = tierToClass[rows[rowIdx].tier];
      const logits = new Array(k);

      for (let c = 0; c < k; c++) {
        let z = bias[c];
        const w = weights[c];
        for (let j = 0; j < d; j++) z += w[j] * x[j];
        logits[c] = z;
      }

      const probs = softmax(logits);
      const sampleWeight = cw[rows[rowIdx].tier];
      for (let c = 0; c < k; c++) {
        const err = ((probs[c] - (c === y ? 1 : 0)) * sampleWeight);
        const w = weights[c];
        for (let j = 0; j < d; j++) {
          w[j] -= lr * (err * x[j] + opts.l2 * w[j]);
        }
        bias[c] -= lr * err;
      }
    }
  }

  return {
    modelType: 'minilm-softmax-regression',
    classes: TIERS,
    weights,
    bias,
    featureVersion: opts.featureVersion,
  };
}

function fitOrdinal(xs, rows, idxs, opts) {
  const featureRows = xs.map((x, i) => buildFeatureVector(x, rows[i].prompt, { featureVersion: opts.featureVersion }));
  const d = featureRows[0].length;
  const heads = [];

  for (const headSpec of ORDINAL_HEADS) {
    const weights = new Array(d).fill(0);
    let bias = 0;
    const cw = binaryClassWeights(rows, idxs, headSpec.minRank);

    for (let epoch = 0; epoch < opts.epochs; epoch++) {
      shuffle(idxs, opts.seed + epoch * 31 + headSpec.minRank * 101);
      const lr = opts.lr / Math.sqrt(1 + epoch * 0.03);

      for (const rowIdx of idxs) {
        const x = featureRows[rowIdx];
        const y = TIERS.indexOf(rows[rowIdx].tier) >= headSpec.minRank ? 1 : 0;
        let z = bias;
        for (let j = 0; j < d; j++) z += weights[j] * x[j];

        const p = sigmoid(z);
        const sampleWeight = y ? cw.pos : cw.neg;
        const err = (p - y) * sampleWeight;
        for (let j = 0; j < d; j++) {
          weights[j] -= lr * (err * x[j] + opts.l2 * weights[j]);
        }
        bias -= lr * err;
      }
    }

    heads.push({
      name: headSpec.name,
      minRank: headSpec.minRank,
      threshold: 0.5,
      temperature: 1,
      weights,
      bias,
    });
  }

  return {
    modelType: 'minilm-ordinal-regression',
    classes: TIERS,
    ordinalHeads: heads,
    featureVersion: opts.featureVersion,
  };
}

function fitMlp(xs, rows, idxs, opts) {
  const k = TIERS.length;
  const featureRows = xs.map((x, i) => buildFeatureVector(x, rows[i].prompt, { featureVersion: opts.featureVersion }));
  const d = featureRows[0].length;
  const hidden = opts.hidden || 48;
  const tierToClass = Object.fromEntries(TIERS.map((t, i) => [t, i]));
  const cw = classWeights(rows, idxs);

  // He-init hidden layer, small-init output layer (seeded).
  const rand = mulberry32(opts.seed + 777);
  const gauss = () => {
    let u = 0, v = 0;
    while (u === 0) u = rand();
    while (v === 0) v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const w1 = Array.from({ length: hidden }, () => {
    const s = Math.sqrt(2 / d);
    return Array.from({ length: d }, () => gauss() * s);
  });
  const b1 = new Array(hidden).fill(0);
  const w2 = Array.from({ length: k }, () => {
    const s = Math.sqrt(2 / hidden);
    return Array.from({ length: hidden }, () => gauss() * s);
  });
  const b2 = new Array(k).fill(0);

  for (let epoch = 0; epoch < opts.epochs; epoch++) {
    shuffle(idxs, opts.seed + epoch * 19);
    const lr = opts.lr / Math.sqrt(1 + epoch * 0.03);

    for (const rowIdx of idxs) {
      const x = featureRows[rowIdx];
      const y = tierToClass[rows[rowIdx].tier];
      const sw = cw[rows[rowIdx].tier];

      // forward
      const zh = new Array(hidden);
      const h  = new Array(hidden);
      for (let j = 0; j < hidden; j++) {
        let z = b1[j];
        const row = w1[j];
        for (let i = 0; i < d; i++) z += row[i] * x[i];
        zh[j] = z;
        h[j] = z > 0 ? z : 0;
      }
      const logits = new Array(k);
      for (let c = 0; c < k; c++) {
        let z = b2[c];
        const row = w2[c];
        for (let j = 0; j < hidden; j++) z += row[j] * h[j];
        logits[c] = z;
      }
      const probs = softmax(logits);

      // backward (output)
      const dLogit = new Array(k);
      for (let c = 0; c < k; c++) dLogit[c] = (probs[c] - (c === y ? 1 : 0)) * sw;

      const dh = new Array(hidden).fill(0);
      for (let c = 0; c < k; c++) {
        const row = w2[c];
        const g = dLogit[c];
        for (let j = 0; j < hidden; j++) {
          dh[j] += g * row[j];
          row[j] -= lr * (g * h[j] + opts.l2 * row[j]);
        }
        b2[c] -= lr * g;
      }

      // backward (hidden, ReLU gate)
      for (let j = 0; j < hidden; j++) {
        if (zh[j] <= 0) continue;
        const g = dh[j];
        const row = w1[j];
        for (let i = 0; i < d; i++) row[i] -= lr * (g * x[i] + opts.l2 * row[i]);
        b1[j] -= lr * g;
      }
    }
  }

  return {
    modelType: 'minilm-mlp',
    classes: TIERS,
    mlp: { w1, b1, w2, b2 },
    featureVersion: opts.featureVersion,
  };
}

function fitClassifier(xs, rows, idxs, opts) {
  if (opts.modelType === 'softmax') return fitSoftmax(xs, rows, idxs, opts);
  if (opts.modelType === 'mlp') return fitMlp(xs, rows, idxs, opts);
  return fitOrdinal(xs, rows, idxs, opts);
}

function setOrdinalThresholds(classifier, thresholds) {
  if (classifier.modelType !== 'minilm-ordinal-regression') return classifier;
  for (const head of classifier.ordinalHeads) {
    if (thresholds[head.name] !== undefined) head.threshold = thresholds[head.name];
  }
  return classifier;
}

function routingCost(confusion) {
  let total = 0;
  let cost = 0;
  for (let actual = 0; actual < confusion.length; actual++) {
    for (let predicted = 0; predicted < confusion[actual].length; predicted++) {
      const n = confusion[actual][predicted];
      total += n;
      cost += n * ROUTING_COSTS[actual][predicted];
    }
  }
  return cost / Math.max(1, total);
}

function cloneJson(v) {
  return JSON.parse(JSON.stringify(v));
}

function tuneOrdinalThresholds(classifier, xs, rows, idxs) {
  if (classifier.modelType !== 'minilm-ordinal-regression') {
    return { classifier, thresholds: null, report: evaluate(classifier, xs, rows, idxs) };
  }

  const values = [];
  for (let v = 0.25; v <= 0.750001; v += 0.05) values.push(Number(v.toFixed(2)));

  let best = null;
  for (const mid of values) {
    for (const deep of values) {
      for (const ultra of values) {
        const candidate = setOrdinalThresholds(cloneJson(classifier), { mid, deep, ultra });
        const report = evaluate(candidate, xs, rows, idxs);
        const recalls = TIERS.map(t => report.perTier[t].recall);
        const underRoute =
          report.confusion[1][0] +
          report.confusion[2][0] + report.confusion[2][1] +
          report.confusion[3][0] + report.confusion[3][1] + report.confusion[3][2];
        const severeUnderRoute =
          report.confusion[2][0] +
          report.confusion[3][0] + report.confusion[3][1];

        // Tune for routing utility, not vanity accuracy. Penalize low recall on
        // non-light tiers, because under-routing is the failure mode users feel.
        const recallPenalty =
          Math.max(0, 0.82 - recalls[1]) * 3 +
          Math.max(0, 0.84 - recalls[2]) * 4 +
          Math.max(0, 0.84 - recalls[3]) * 5;
        const lightPenalty = Math.max(0, 0.70 - recalls[0]) * 1.5;
        const objective =
          routingCost(report.confusion) +
          recallPenalty +
          lightPenalty +
          underRoute * 0.002 +
          severeUnderRoute * 0.006 -
          report.accuracy * 0.05;

        if (!best || objective < best.objective) {
          best = { objective, thresholds: { mid, deep, ultra }, report, classifier: candidate };
        }
      }
    }
  }

  return best;
}

function evaluate(classifier, xs, rows, idxs) {
  const k = TIERS.length;
  const tierToClass = Object.fromEntries(TIERS.map((t, i) => [t, i]));
  const confusion = Array.from({ length: k }, () => new Array(k).fill(0));
  const mistakes = [];

  for (const i of idxs) {
    const predicted = classifyEmbedding(xs[i], classifier, rows[i].prompt);
    const actualIdx = tierToClass[rows[i].tier];
    const predIdx = tierToClass[predicted.tier];
    confusion[actualIdx][predIdx]++;
    if (predicted.tier !== rows[i].tier) {
      mistakes.push({
        expected: rows[i].tier,
        predicted: predicted.tier,
        score: Number(predicted.score.toFixed(4)),
        margin: Number(predicted.margin.toFixed(4)),
        prompt: rows[i].prompt,
      });
    }
  }

  let correct = 0;
  let total = 0;
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) {
      total += confusion[i][j];
      if (i === j) correct += confusion[i][j];
    }
  }

  const perTier = {};
  let macroF1 = 0;
  for (let i = 0; i < k; i++) {
    const tp = confusion[i][i];
    let fp = 0, fn = 0;
    for (let j = 0; j < k; j++) {
      if (j !== i) {
        fp += confusion[j][i];
        fn += confusion[i][j];
      }
    }
    const precision = tp / Math.max(1, tp + fp);
    const recall    = tp / Math.max(1, tp + fn);
    const f1        = (2 * precision * recall) / Math.max(1e-8, precision + recall);
    macroF1 += f1;
    perTier[TIERS[i]] = {
      precision: Number(precision.toFixed(4)),
      recall: Number(recall.toFixed(4)),
      f1: Number(f1.toFixed(4)),
      support: confusion[i].reduce((a, b) => a + b, 0),
    };
  }
  macroF1 /= k;

  return {
    accuracy: Number((correct / Math.max(1, total)).toFixed(4)),
    macroF1: Number(macroF1.toFixed(4)),
    routingCost: Number(routingCost(confusion).toFixed(4)),
    confusion,
    perTier,
    mistakes,
  };
}

function printReport(name, report, maxMistakes = 12) {
  console.log(`\n${name}`);
  console.log(`  accuracy=${report.accuracy} macroF1=${report.macroF1} routingCost=${report.routingCost}`);
  console.log('  confusion rows=expected cols=predicted:', TIERS.join(', '));
  report.confusion.forEach((row, i) => console.log(`  ${TIERS[i].padEnd(5)} ${row.join(' ')}`));
  console.log('  per-tier:', JSON.stringify(report.perTier));

  if (report.mistakes.length) {
    console.log(`  mistakes (${report.mistakes.length}, showing ${Math.min(maxMistakes, report.mistakes.length)}):`);
    for (const m of report.mistakes.slice(0, maxMistakes)) {
      console.log(`    ${m.expected}->${m.predicted} score=${m.score} margin=${m.margin} ${JSON.stringify(m.prompt.slice(0, 140))}`);
    }
  } else {
    console.log('  mistakes: 0');
  }
}

async function main() {
  const opts = parseArgs(process.argv);
  const rows = readJsonl(opts.data);
  const extraTrainFiles = opts.extraTrain ? opts.extraTrain.split(',').filter(Boolean) : [];
  const extraRows = extraTrainFiles.length ? readManyJsonl(extraTrainFiles) : [];
  const stressRows = opts.stress ? readJsonl(opts.stress) : [];
  assertNoPromptOverlap(rows, stressRows, opts.data, opts.stress);
  assertNoPromptOverlap(extraRows, stressRows, opts.extraTrain || 'extra-train', opts.stress);

  console.log(`Loaded ${rows.length} labeled prompts from ${opts.data}`);
  if (extraRows.length) console.log(`Loaded ${extraRows.length} extra training prompts from ${opts.extraTrain}`);
  console.log('Class counts:', Object.fromEntries(TIERS.map(t => [t, rows.filter(r => r.tier === t).length])));

  console.log('Loading embeddings with MiniLM...');
  const xs = await embedRows(rows);
  const extraXs = extraRows.length ? await embedRows(extraRows) : [];

  const split = stratifiedSplit(rows, opts.holdout, opts.seed);
  const holdoutAugRows = makeTypoAugmentRows(rows, split.train, opts.typoAugment, opts.seed + 70000);
  const holdoutWrapperRows = makeWrapperAugmentRows(rows, split.train, opts.wrapperAugment, opts.seed + 80000);
  const holdoutRows = rows.concat(extraRows, holdoutAugRows, holdoutWrapperRows);
  const holdoutXs = xs
    .concat(extraXs)
    .concat(holdoutAugRows.length ? await embedRows(holdoutAugRows) : [])
    .concat(holdoutWrapperRows.length ? await embedRows(holdoutWrapperRows) : []);
  const holdoutTrainIdxs = split.train.concat(
    extraRows.map((_, i) => rows.length + i),
    holdoutAugRows.map((_, i) => rows.length + extraRows.length + i),
    holdoutWrapperRows.map((_, i) => rows.length + extraRows.length + holdoutAugRows.length + i)
  );
  if (holdoutAugRows.length) console.log(`Added ${holdoutAugRows.length} typo-augmented training prompts for holdout fit`);
  if (holdoutWrapperRows.length) console.log(`Added ${holdoutWrapperRows.length} wrapper-augmented training prompts for holdout fit`);

  const holdoutFit = fitClassifier(holdoutXs, holdoutRows, holdoutTrainIdxs.slice(), opts);
  const tuned = tuneOrdinalThresholds(holdoutFit, xs, rows, split.test);
  const holdoutClassifier = tuned.classifier;
  const holdoutReport = tuned.report;
  if (tuned.thresholds) {
    console.log('Tuned ordinal thresholds:', JSON.stringify(tuned.thresholds));
  }
  printReport('Holdout evaluation (not used for this classifier fit)', holdoutReport);

  let stressReport = null;
  if (opts.stress) {
    console.log(`\nLoaded ${stressRows.length} stress prompts from ${opts.stress}`);
    const stressXs = await embedRows(stressRows);
    stressReport = evaluate(holdoutClassifier, stressXs, stressRows, stressRows.map((_, i) => i));
    printReport('Stress evaluation (not used for training)', stressReport, 20);
  }

  console.log('\nTraining final classifier on all labeled prompts...');
  const finalAugRows = makeTypoAugmentRows(rows, rows.map((_, i) => i), opts.typoAugment, opts.seed + 90000);
  const finalWrapperRows = makeWrapperAugmentRows(rows, rows.map((_, i) => i), opts.wrapperAugment, opts.seed + 100000);
  const finalRows = rows.concat(extraRows, finalAugRows, finalWrapperRows);
  const finalXs = xs
    .concat(extraXs)
    .concat(finalAugRows.length ? await embedRows(finalAugRows) : [])
    .concat(finalWrapperRows.length ? await embedRows(finalWrapperRows) : []);
  if (finalAugRows.length) console.log(`Added ${finalAugRows.length} typo-augmented prompts for final fit`);
  if (finalWrapperRows.length) console.log(`Added ${finalWrapperRows.length} wrapper-augmented prompts for final fit`);

  const finalClassifier = fitClassifier(finalXs, finalRows, finalRows.map((_, i) => i), opts);
  if (tuned.thresholds) setOrdinalThresholds(finalClassifier, tuned.thresholds);
  const trainReport = evaluate(finalClassifier, xs, rows, rows.map((_, i) => i));
  printReport('Final fit evaluation (training data, optimistic)', trainReport, 6);

  const artifact = {
    modelType: finalClassifier.modelType,
    version: 1,
    featureVersion: opts.featureVersion,
    classes: finalClassifier.classes,
    hiddenSize: HIDDEN_SIZE,
    featureSize: finalClassifier.modelType === 'minilm-ordinal-regression'
      ? finalClassifier.ordinalHeads[0].weights.length
      : finalClassifier.modelType === 'minilm-mlp'
        ? finalClassifier.mlp.w1[0].length
        : finalClassifier.weights[0].length,
    training: {
      data: path.relative(ROOT, opts.data),
      extraTrain: extraTrainFiles.length ? extraTrainFiles.map(file => path.relative(ROOT, file)) : null,
      examples: rows.length,
      extraExamples: extraRows.length,
      epochs: opts.epochs,
      learningRate: opts.lr,
      l2: opts.l2,
      typoAugment: opts.typoAugment,
      wrapperAugment: opts.wrapperAugment,
      seed: opts.seed,
      holdout: opts.holdout,
      thresholdTuning: tuned.thresholds ? {
        thresholds: tuned.thresholds,
        objective: Number(tuned.objective.toFixed(6)),
      } : null,
      holdoutReport: {
        accuracy: holdoutReport.accuracy,
        macroF1: holdoutReport.macroF1,
        routingCost: holdoutReport.routingCost,
        confusion: holdoutReport.confusion,
        perTier: holdoutReport.perTier,
      },
      stressReport: stressReport ? {
        accuracy: stressReport.accuracy,
        macroF1: stressReport.macroF1,
        routingCost: stressReport.routingCost,
        confusion: stressReport.confusion,
        perTier: stressReport.perTier,
        mistakes: stressReport.mistakes,
      } : null,
      trainReport: {
        accuracy: trainReport.accuracy,
        macroF1: trainReport.macroF1,
        routingCost: trainReport.routingCost,
        confusion: trainReport.confusion,
      },
      createdAt: new Date().toISOString(),
    },
  };

  if (finalClassifier.modelType === 'minilm-ordinal-regression') {
    artifact.ordinalHeads = finalClassifier.ordinalHeads.map(head => ({
      name: head.name,
      minRank: head.minRank,
      threshold: head.threshold,
      temperature: head.temperature,
      weights: head.weights.map(x => Number(x.toPrecision(8))),
      bias: Number(head.bias.toPrecision(8)),
    }));
  } else if (finalClassifier.modelType === 'minilm-mlp') {
    const p = x => Number(x.toPrecision(7));
    artifact.hidden = finalClassifier.mlp.b1.length;
    artifact.mlp = {
      w1: finalClassifier.mlp.w1.map(row => row.map(p)),
      b1: finalClassifier.mlp.b1.map(p),
      w2: finalClassifier.mlp.w2.map(row => row.map(p)),
      b2: finalClassifier.mlp.b2.map(p),
    };
  } else {
    artifact.weights = finalClassifier.weights.map(row => row.map(x => Number(x.toPrecision(8))));
    artifact.bias = finalClassifier.bias.map(x => Number(x.toPrecision(8)));
  }

  fs.writeFileSync(opts.output, JSON.stringify(artifact, null, 0) + '\n');
  console.log(`\nWrote ${opts.output}`);
}

main().catch(e => {
  console.error('ERROR:', e && e.stack ? e.stack : e);
  process.exit(1);
});
