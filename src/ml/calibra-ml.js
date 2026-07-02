'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const {
  CALIBRA_DEEP_INTENT,
  CALIBRA_MID_INTENT,
  CALIBRA_SCOPE_HIGH,
  CALIBRA_DOMAIN_DEEP,
  checkFastExits,
  applyRoutingGuards,
  ruleClassify,
} = require('./classify-core.js');

const { tokenize } = require('./tokenizer.js');
const { classifyEmbedding } = require('./linear-classifier.js');

function heuristicFallback(prompt, cause) {
  try {
    const sourceProxy = path.join(__dirname, '..', 'saka-proxy.js');
    const installedProxy = path.join(os.homedir(), '.claude-corp', 'saka-proxy.js');
    const proxyPath = path.basename(path.dirname(__dirname)) === 'src' ? sourceProxy : installedProxy;
    const { calibraClassify } = require(proxyPath);
    const r = calibraClassify(prompt);
    return { ...r, engine: 'heuristic', reason: 'ml-fallback:' + cause };
  } catch {
    return { tier: 'mid', score: -1, reason: 'ml-fallback:' + cause, engine: 'heuristic' };
  }
}

// ── Config ────────────────────────────────────────────────────────────────────

const CALIBRA_BASE   = path.join(os.homedir(), '.claude-corp', 'calibra');
const ML_CONFIG_PATH = path.join(CALIBRA_BASE, 'calibra-ml.json');
const DEFAULT_MODEL  = path.join(CALIBRA_BASE, 'models', 'router.onnx');
const CENTROIDS_PATH = path.join(__dirname, 'tier-centroids.json');
const CLASSIFIER_PATH = path.join(__dirname, 'tier-classifier.json');

function loadMlConfig() {
  try { return JSON.parse(fs.readFileSync(ML_CONFIG_PATH, 'utf8')); }
  catch { return { maxLength: 256, hiddenSize: 384 }; }
}

// ── Tier centroids ─────────────────────────────────────────────────────────────

let _centroids = null;
let _classifier = undefined;

function loadCentroids() {
  if (_centroids) return _centroids;
  try {
    const data = JSON.parse(fs.readFileSync(CENTROIDS_PATH, 'utf8'));
    // Convert arrays to Float32Arrays for fast dot products
    _centroids = {};
    for (const tier of Object.keys(data)) {
      _centroids[tier] = new Float32Array(data[tier]);
    }
    return _centroids;
  } catch {
    return null;
  }
}

function loadClassifier() {
  if (_classifier !== undefined) return _classifier;
  try {
    _classifier = JSON.parse(fs.readFileSync(CLASSIFIER_PATH, 'utf8'));
    return _classifier;
  } catch {
    _classifier = null;
    return null;
  }
}

// ── Math helpers ──────────────────────────────────────────────────────────────

function meanPool(hidden, mask, seqLen, hiddenSize) {
  const out   = new Float32Array(hiddenSize);
  let   count = 0;
  for (let i = 0; i < seqLen; i++) {
    if (!mask[i]) continue;
    count++;
    const offset = i * hiddenSize;
    for (let j = 0; j < hiddenSize; j++) out[j] += hidden[offset + j];
  }
  if (count > 0) for (let j = 0; j < hiddenSize; j++) out[j] /= count;
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

function cosineSim(a, b) {
  // Both a and b are already L2-normalized, so dot product = cosine similarity
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

function findBestTier(embedding, centroids) {
  const tiers = ['light', 'mid', 'deep', 'ultra'];
  let bestTier = 'mid', bestSim = -Infinity;
  for (const tier of tiers) {
    if (!centroids[tier]) continue;
    const sim = cosineSim(embedding, centroids[tier]);
    if (sim > bestSim) { bestSim = sim; bestTier = tier; }
  }
  return { tier: bestTier, score: bestSim };
}

// ── ONNX session singleton ────────────────────────────────────────────────────

let _session     = null;
let _initialized = false;
let _initPromise = null;

async function getSession() {
  if (_initialized) return _session;
  if (_initPromise)  return _initPromise;

  _initPromise = (async () => {
    _initialized = true;
    try {
      const ort       = requireOrt();
      const modelPath = process.env.CALIBRA_ML_MODEL_PATH || DEFAULT_MODEL;
      if (!fs.existsSync(modelPath)) throw new Error('model not found: ' + modelPath);
      _session = await ort.InferenceSession.create(modelPath);
      process.stderr.write('[calibra-ml] ONNX session ready\n');
      return _session;
    } catch (e) {
      process.stderr.write('[calibra-ml] session init failed: ' + e.message + '\n');
      _session = null;
      return null;
    }
  })();

  return _initPromise;
}

function requireOrt() {
  try {
    return require('onnxruntime-node');
  } catch (e) {
    const runtimeOrt = path.join(CALIBRA_BASE, 'node_modules', 'onnxruntime-node');
    return require(runtimeOrt);
  }
}

// ── Warmup ────────────────────────────────────────────────────────────────────

let _warmedUp = false;

function warmup() {
  if (_warmedUp) return;
  _warmedUp = true;
  getSession().catch(() => {});
}

// ── LRU cache ─────────────────────────────────────────────────────────────────

const CACHE_MAX = 64;
const _cache    = new Map();

function djb2(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = (h * 33 ^ str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function cacheGet(k) {
  if (!_cache.has(k)) return null;
  const v = _cache.get(k); _cache.delete(k); _cache.set(k, v);
  return v;
}
function cacheSet(k, v) {
  if (_cache.size >= CACHE_MAX) _cache.delete(_cache.keys().next().value);
  _cache.set(k, v);
}

// ── Core inference ────────────────────────────────────────────────────────────

async function runInference(trimmed) {
  const session = await getSession();
  if (!session) throw new Error('no-session');

  const ort        = requireOrt();
  const config     = loadMlConfig();
  const maxLen     = config.maxLength  || 256;
  const hiddenSize = parseInt(process.env.CALIBRA_ML_HIDDEN, 10) || config.hiddenSize || 384;

  const { input_ids, attention_mask, token_type_ids } = tokenize(trimmed, maxLen);
  const seqLen = input_ids.length;

  function toInt64Tensor(arr) {
    return new ort.Tensor('int64', BigInt64Array.from(arr, v => BigInt(v)), [1, arr.length]);
  }

  const feeds = {
    input_ids:      toInt64Tensor(input_ids),
    attention_mask: toInt64Tensor(attention_mask),
    token_type_ids: toInt64Tensor(token_type_ids),
  };

  const results = await session.run(feeds);

  // all-MiniLM-L6-v2 outputs last_hidden_state [1, seq, 384]
  const hiddenData = results['last_hidden_state']?.data ||
                     results[session.outputNames[0]].data;

  const pooled     = meanPool(hiddenData, attention_mask, seqLen, hiddenSize);
  const normalized = l2Normalize(pooled);

  const classifier = loadClassifier();
  if (classifier) {
    const r = classifyEmbedding(normalized, classifier, trimmed);
    const guarded = applyRoutingGuards(trimmed, r.tier);
    const reason = guarded !== r.tier ? 'ml-classifier+guard'
      : (r.rawTier && r.rawTier !== r.tier ? 'ml-classifier+risk-policy' : 'ml-classifier');
    return {
      tier: guarded, rawTier: r.rawTier, score: r.score, rawScore: r.rawScore,
      margin: r.margin, decision: r.decision, ordinal: r.ordinal, reason, engine: 'ml',
    };
  }

  const centroids  = loadCentroids();
  if (!centroids) throw new Error('centroids not found');
  const { tier, score } = findBestTier(normalized, centroids);
  return { tier, score, reason: 'ml-centroid', engine: 'ml' };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Classify a prompt using the MiniLM ML engine.
 * Total + fail-soft: on any failure falls back to calibraClassify.
 * Never throws.
 */
async function classifyML(prompt) {
  const trimmed = (prompt || '').trim();

  // ── Rule-first cascade (plan §4) ──────────────────────────────────────────
  // The deterministic rubric decides every rule-decidable prompt. When it is
  // confident the ML never runs (faster + self-consistent). Only the genuinely
  // ambiguous residual (ruleClassify → confident:false) reaches the ML head,
  // where the expected-cost decision policy owns the boundary.
  const rulesDisabled = process.env.CALIBRA_DISABLE_RULES === '1';
  const ruled = rulesDisabled ? { confident: false } : ruleClassify(trimmed);
  if (ruled && ruled.confident) {
    return { tier: ruled.tier, score: 0, reason: ruled.reason, engine: 'ml' };
  }

  const key    = djb2(trimmed);
  const cached = cacheGet(key);
  if (cached) return cached;

  const timeoutMs = parseInt(process.env.CALIBRA_ML_TIMEOUT_MS, 10) || 250;

  let result;
  try {
    result = await Promise.race([
      runInference(trimmed),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
    ]);
  } catch (e) {
    return heuristicFallback(prompt, e.message || 'unknown');
  }

  cacheSet(key, result);
  return result;
}

module.exports = { classifyML, warmup };
