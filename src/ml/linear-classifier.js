'use strict';

const { lexicalFeatures } = require('./classify-core.js');

const TIERS = ['light', 'mid', 'deep', 'ultra'];

function clamp01(x) {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function promptFeatures(prompt) {
  const text = prompt || '';
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const separators = (text.match(/[,;:]/g) || []).length;
  const lineBreaks = (text.match(/\n/g) || []).length;

  return [
    clamp01(Math.log1p(text.length) / Math.log1p(2500)),
    clamp01(words / 320),
    clamp01(separators / 40),
    clamp01(lineBreaks / 80),
  ];
}

function buildFeatureVector(embedding, prompt, classifier) {
  const base = Array.from(embedding);
  const fv = classifier && classifier.featureVersion;
  if (fv === 1) return base.concat(promptFeatures(prompt));
  if (fv >= 2)  return base.concat(promptFeatures(prompt), lexicalFeatures(prompt));
  return base;
}

function softmax(logits) {
  let max = -Infinity;
  for (const x of logits) if (x > max) max = x;

  const probs = new Array(logits.length);
  let sum = 0;
  for (let i = 0; i < logits.length; i++) {
    const p = Math.exp(logits[i] - max);
    probs[i] = p;
    sum += p;
  }

  if (!sum || !Number.isFinite(sum)) {
    return new Array(logits.length).fill(1 / logits.length);
  }

  for (let i = 0; i < probs.length; i++) probs[i] /= sum;
  return probs;
}

function sigmoid(x) {
  if (x >= 0) {
    const z = Math.exp(-x);
    return 1 / (1 + z);
  }
  const z = Math.exp(x);
  return z / (1 + z);
}

function expectedCostDecision(classes, probs, policy) {
  if (!policy || policy.type !== 'expected-cost' || !Array.isArray(policy.costs)) {
    return null;
  }

  let bestIdx = 0;
  let bestCost = Infinity;
  const costsByTier = {};

  for (let predictedIdx = 0; predictedIdx < classes.length; predictedIdx++) {
    let cost = 0;
    for (let actualIdx = 0; actualIdx < classes.length; actualIdx++) {
      const row = policy.costs[actualIdx];
      cost += probs[actualIdx] * (Array.isArray(row) ? (row[predictedIdx] || 0) : 0);
    }
    costsByTier[classes[predictedIdx]] = cost;
    if (cost < bestCost) {
      bestCost = cost;
      bestIdx = predictedIdx;
    }
  }

  return {
    tier: classes[bestIdx],
    expectedCost: bestCost,
    expectedCosts: costsByTier,
  };
}

function classifyOrdinalEmbedding(embedding, classifier, prompt = '') {
  const features = buildFeatureVector(embedding, prompt, classifier);
  const heads = classifier.ordinalHeads;
  if (!Array.isArray(heads) || heads.length !== 3) {
    throw new Error('invalid ordinal classifier heads');
  }

  const atLeast = {};
  const logits = {};
  for (const head of heads) {
    if (!Array.isArray(head.weights) || head.weights.length !== features.length) {
      throw new Error('invalid ordinal classifier shape');
    }

    let z = head.bias || 0;
    for (let i = 0; i < features.length; i++) z += head.weights[i] * features[i];
    const temperature = head.temperature || 1;
    logits[head.name] = z;
    atLeast[head.name] = sigmoid(z / temperature);
  }

  let tier = 'light';
  if (atLeast.ultra >= (heads.find(h => h.name === 'ultra')?.threshold ?? 0.5)) tier = 'ultra';
  else if (atLeast.deep >= (heads.find(h => h.name === 'deep')?.threshold ?? 0.5)) tier = 'deep';
  else if (atLeast.mid >= (heads.find(h => h.name === 'mid')?.threshold ?? 0.5)) tier = 'mid';

  const tierScore = {
    light: 1 - atLeast.mid,
    mid: atLeast.mid * (1 - atLeast.deep),
    deep: atLeast.deep * (1 - atLeast.ultra),
    ultra: atLeast.ultra,
  };
  // Normalize tierScore into a proper distribution so the expected-cost policy
  // can integrate over the full tier posterior (ordinal scores need not sum to 1).
  const norm = TIERS.reduce((s, t) => s + tierScore[t], 0) || 1;
  const probsVec = TIERS.map(t => tierScore[t] / norm);

  const ranked = TIERS.map(t => ({ tier: t, score: tierScore[t] }))
    .sort((a, b) => b.score - a.score);

  // Cost-sensitive residual decision: when a decisionPolicy is present, pick the
  // tier minimizing expected routing cost over the posterior instead of argmax.
  // Used only on the ML residual (rules handle the confident cases upstream),
  // biasing the genuinely-ambiguous boundary toward the safer tier.
  const decision = expectedCostDecision(TIERS, probsVec, classifier.decisionPolicy);
  const argmaxTier = tier;
  const finalTier = decision ? decision.tier : tier;

  return {
    tier: finalTier,
    rawTier: argmaxTier,
    score: tierScore[finalTier],
    rawScore: ranked[0].score,
    margin: ranked[0].score - (ranked[1]?.score || 0),
    probs: Object.fromEntries(TIERS.map((t, i) => [t, probsVec[i]])),
    ordinal: { atLeast, logits },
    decision: decision ? {
      type: classifier.decisionPolicy.type,
      expectedCost: decision.expectedCost,
      expectedCosts: decision.expectedCosts,
    } : undefined,
  };
}

function classifySoftmaxEmbedding(embedding, classifier, prompt = '') {
  const classes = Array.isArray(classifier.classes) ? classifier.classes : TIERS;
  const weights = classifier.weights;
  const bias    = classifier.bias || new Array(classes.length).fill(0);
  const features = buildFeatureVector(embedding, prompt, classifier);

  if (!Array.isArray(weights) || weights.length !== classes.length) {
    throw new Error('invalid classifier weights');
  }

  const logits = new Array(classes.length).fill(0);
  for (let c = 0; c < classes.length; c++) {
    const row = weights[c];
    if (!Array.isArray(row) || row.length !== features.length) {
      throw new Error('invalid classifier shape');
    }

    let z = bias[c] || 0;
    for (let i = 0; i < features.length; i++) z += row[i] * features[i];
    logits[c] = z;
  }

  const probs = softmax(logits);
  const ranked = probs
    .map((prob, i) => ({ tier: classes[i], prob, logit: logits[i] }))
    .sort((a, b) => b.prob - a.prob);

  const best   = ranked[0];
  const second = ranked[1] || { tier: best.tier, prob: 0 };
  const decision = expectedCostDecision(classes, probs, classifier.decisionPolicy);
  const tier = decision ? decision.tier : best.tier;
  const selectedProb = probs[classes.indexOf(tier)] ?? best.prob;

  return {
    tier,
    rawTier: best.tier,
    score: selectedProb,
    rawScore: best.prob,
    margin: best.prob - second.prob,
    probs: Object.fromEntries(classes.map((tier, i) => [tier, probs[i]])),
    decision: decision ? {
      type: classifier.decisionPolicy.type,
      expectedCost: decision.expectedCost,
      expectedCosts: decision.expectedCosts,
    } : undefined,
  };
}

function relu(x) { return x > 0 ? x : 0; }

// One-hidden-layer MLP head over the (embedding ++ lexical) feature vector.
// Carves nonlinear tier boundaries the linear/ordinal probe can't (light↔mid,
// deep↔ultra). Output is 4-way softmax; supports the same expected-cost policy.
function classifyMlpEmbedding(embedding, classifier, prompt = '') {
  const classes = Array.isArray(classifier.classes) ? classifier.classes : TIERS;
  const { w1, b1, w2, b2 } = classifier.mlp || {};
  const features = buildFeatureVector(embedding, prompt, classifier);

  if (!Array.isArray(w1) || !Array.isArray(w2) || !Array.isArray(b1) || !Array.isArray(b2)) {
    throw new Error('invalid mlp classifier');
  }
  const hidden = b1.length;
  if (w1.length !== hidden || w2.length !== classes.length) {
    throw new Error('invalid mlp shape');
  }

  const h = new Array(hidden);
  for (let j = 0; j < hidden; j++) {
    const row = w1[j];
    if (row.length !== features.length) throw new Error('invalid mlp input shape');
    let z = b1[j];
    for (let i = 0; i < features.length; i++) z += row[i] * features[i];
    h[j] = relu(z);
  }

  const logits = new Array(classes.length);
  for (let c = 0; c < classes.length; c++) {
    const row = w2[c];
    let z = b2[c];
    for (let j = 0; j < hidden; j++) z += row[j] * h[j];
    logits[c] = z;
  }

  const probs = softmax(logits);
  const ranked = probs.map((prob, i) => ({ tier: classes[i], prob }))
    .sort((a, b) => b.prob - a.prob);
  const best = ranked[0];
  const second = ranked[1] || { tier: best.tier, prob: 0 };
  const decision = expectedCostDecision(classes, probs, classifier.decisionPolicy);
  const tier = decision ? decision.tier : best.tier;
  const selectedProb = probs[classes.indexOf(tier)] ?? best.prob;

  return {
    tier,
    rawTier: best.tier,
    score: selectedProb,
    rawScore: best.prob,
    margin: best.prob - second.prob,
    probs: Object.fromEntries(classes.map((t, i) => [t, probs[i]])),
    decision: decision ? {
      type: classifier.decisionPolicy.type,
      expectedCost: decision.expectedCost,
      expectedCosts: decision.expectedCosts,
    } : undefined,
  };
}

function classifyEmbedding(embedding, classifier, prompt = '') {
  if (classifier && classifier.modelType === 'minilm-mlp') {
    return classifyMlpEmbedding(embedding, classifier, prompt);
  }
  if (classifier && classifier.modelType === 'minilm-ordinal-regression') {
    return classifyOrdinalEmbedding(embedding, classifier, prompt);
  }
  return classifySoftmaxEmbedding(embedding, classifier, prompt);
}

module.exports = {
  TIERS,
  sigmoid,
  softmax,
  promptFeatures,
  buildFeatureVector,
  classifyEmbedding,
  classifyOrdinalEmbedding,
  classifySoftmaxEmbedding,
  classifyMlpEmbedding,
};
