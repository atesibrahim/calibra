#!/usr/bin/env node
/**
 * compute_centroids.js — Compute tier centroid embeddings for Calibra ML mode.
 *
 * Usage:
 *   node tools/compute_centroids.js
 *
 * Reads:  tools/eval_prompts.jsonl  (labeled prompts)
 *         ~/.claude-corp/calibra/models/router.onnx  (all-MiniLM-L6-v2 quantized)
 *         ~/.claude-corp/calibra/ml/vocab.txt
 * Writes: src/ml/tier-centroids.json
 */
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const TIERS         = ['light', 'mid', 'deep', 'ultra'];
const HIDDEN_SIZE   = 384;
const MAX_LENGTH    = 256;
const MODEL_PATH    = path.join(os.homedir(), '.claude-corp', 'calibra', 'models', 'router.onnx');
const PROMPTS_PATH  = path.join(__dirname, 'eval_prompts.jsonl');
const OUTPUT_PATH   = path.join(__dirname, '..', 'src', 'ml', 'tier-centroids.json');

// Require onnxruntime-node from the calibra runtime location
const ORT_PATH = path.join(os.homedir(), '.claude-corp', 'calibra', 'node_modules', 'onnxruntime-node');
const ort      = require(ORT_PATH);

// Require tokenizer from src/
const { tokenize } = require(path.join(__dirname, '..', 'src', 'ml', 'tokenizer.js'));

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
  return v.map(x => x / norm);
}

async function embed(session, text) {
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

  const hidden = results['last_hidden_state']?.data ?? results[session.outputNames[0]].data;
  return l2Normalize(meanPool(hidden, attention_mask, seqLen));
}

function addVectors(acc, v) {
  for (let i = 0; i < acc.length; i++) acc[i] += v[i];
}

async function main() {
  if (!fs.existsSync(MODEL_PATH)) {
    console.error('Model not found:', MODEL_PATH);
    console.error('Download it first: node tools/compute_centroids.js will fail until model exists');
    process.exit(1);
  }

  console.log('Loading model...');
  const session = await ort.InferenceSession.create(MODEL_PATH);
  console.log('Model loaded. Output names:', session.outputNames);

  const lines = fs.readFileSync(PROMPTS_PATH, 'utf8')
    .split('\n').filter(Boolean)
    .map(l => JSON.parse(l));

  const groups = {};
  for (const tier of TIERS) groups[tier] = [];
  for (const { prompt, tier } of lines) {
    if (groups[tier]) groups[tier].push(prompt);
  }

  for (const [tier, prompts] of Object.entries(groups)) {
    console.log(`  ${tier}: ${prompts.length} prompts`);
  }

  console.log('\nComputing embeddings...');
  const sums   = {};
  const counts = {};
  for (const tier of TIERS) { sums[tier] = new Float32Array(HIDDEN_SIZE); counts[tier] = 0; }

  let total = 0;
  for (const { prompt, tier } of lines) {
    if (!groups[tier]) continue;
    const emb = await embed(session, prompt);
    addVectors(sums[tier], emb);
    counts[tier]++;
    process.stdout.write(`\r  ${++total}/${lines.length}`);
  }
  console.log();

  // Compute mean centroids and L2-normalize them
  const centroids = {};
  for (const tier of TIERS) {
    const n   = counts[tier] || 1;
    const mean = sums[tier].map(x => x / n);
    centroids[tier] = Array.from(l2Normalize(mean));
  }

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(centroids, null, 0) + '\n');
  console.log('\nWrote', OUTPUT_PATH);

  // Quick validation: each centroid's cosine similarity with its own prompts
  console.log('\nCentroid purity (avg cosine sim to own tier):');
  for (const tier of TIERS) {
    const c    = new Float32Array(centroids[tier]);
    const proms = lines.filter(l => l.tier === tier);
    let sumSim = 0;
    for (const { prompt } of proms) {
      const emb = await embed(session, prompt);
      let dot = 0;
      for (let i = 0; i < HIDDEN_SIZE; i++) dot += emb[i] * c[i];
      sumSim += dot;
    }
    console.log(`  ${tier}: avg_sim=${(sumSim / (proms.length || 1)).toFixed(4)}`);
  }
}

main().catch(e => { console.error('ERROR:', e); process.exit(1); });
