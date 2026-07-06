'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const zlib = require('zlib');

// ─────────────────────────────────────────────────────────────────────────────
// Generic typo correction — no curated word/stem lists.
//
// Loads cspell trie files (@cspell/dict-en_us, @cspell/dict-en-gb,
// @cspell/dict-tr-tr) via cspell-trie-lib so corrections are driven by real
// dictionary data, including inflected and agglutinated forms that hunspell
// flat word lists miss.
//
// Applied once, before both the regex axis scoring (classify-core.js) and the
// ONNX embedding (calibra-ml.js), so a typo in ANY word — not just ones in a
// curated list — gets a chance to resolve to its correct spelling.
//
// Fail-soft: any failure (deps missing, trie load error, etc.) makes
// correctText() a no-op that returns the input unchanged. Never throws.
// ─────────────────────────────────────────────────────────────────────────────

const CALIBRA_BASE = path.join(os.homedir(), '.claude-corp', 'calibra');

// Find the directory of a npm package by resolving its package.json.
// Falls back to the runtime install location when the package isn't in the
// development node_modules (i.e. when running from ~/.claude-corp/calibra/ml/).
function findPkgDir(pkg) {
  try {
    // require.resolve(pkg) resolves the package's main entry (e.g. cspell-ext.json);
    // its dirname is the package root regardless of whether ./package.json is exported.
    return path.dirname(require.resolve(pkg));
  } catch {
    return path.join(CALIBRA_BASE, 'node_modules', pkg);
  }
}

function requireCspellTrie() {
  try {
    return require('cspell-trie-lib');
  } catch {
    return require(path.join(CALIBRA_BASE, 'node_modules', 'cspell-trie-lib'));
  }
}

// Load a .trie.gz file and return a Trie instance (synchronous).
// The trie already contains all inflected/agglutinated forms — no .aff expansion needed.
function loadTrie(pkgName, trieFile) {
  const { importTrie, Trie } = requireCspellTrie();
  const triePath = path.join(findPkgDir(pkgName), trieFile);
  const raw = zlib.gunzipSync(fs.readFileSync(triePath)).toString('utf8');
  return new Trie(importTrie(raw.split('\n')));
}

// ── Lazy singleton dictionaries ───────────────────────────────────────────────

let _enDict;
let _enGbDict;
let _trDict;

function getEnDict() {
  if (_enDict !== undefined) return _enDict;
  try {
    _enDict = loadTrie('@cspell/dict-en_us', 'en_US.trie.gz');
  } catch {
    _enDict = null;
  }
  return _enDict;
}

// Separate dictionary for British spellings (analyse/optimise/...), kept
// independent from the US dictionary: en-US/en-GB trie files have different
// word sets and ORing two independent .has() calls is safe.
function getEnGbDict() {
  if (_enGbDict !== undefined) return _enGbDict;
  try {
    _enGbDict = loadTrie('@cspell/dict-en-gb', 'en_GB.trie.gz');
  } catch {
    _enGbDict = null;
  }
  return _enGbDict;
}

function getTrDict() {
  if (_trDict !== undefined) return _trDict;
  try {
    _trDict = loadTrie('@cspell/dict-tr-tr', 'Turkish.trie.gz');
  } catch {
    _trDict = null;
  }
  return _trDict;
}

function warmupSpell() {
  try { getEnDict(); getEnGbDict(); getTrDict(); } catch { /* fail-soft */ }
}

// ── Word correction cache (per-process, bounded LRU) ─────────────────────────

const WORD_CACHE_MAX = 2000;
const _wordCache = new Map();

function wordCacheGet(k) {
  if (!_wordCache.has(k)) return undefined;
  const v = _wordCache.get(k); _wordCache.delete(k); _wordCache.set(k, v);
  return v;
}
function wordCacheSet(k, v) {
  if (_wordCache.size >= WORD_CACHE_MAX) _wordCache.delete(_wordCache.keys().next().value);
  _wordCache.set(k, v);
}

// ── Edit distance (Damerau-Levenshtein — transpositions count as 1 edit, not 2,
// so common typos like "recieve"/"receive" score correctly close) ────────────

function damerauLevenshtein(a, b) {
  const la = a.length, lb = b.length;
  if (!la) return lb; if (!lb) return la;
  const prevprev = new Array(lb + 1);
  const prev = new Array(lb + 1);
  const cur = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    cur[0] = i;
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prevprev[j - 2] + 1);
      }
      cur[j] = v;
    }
    for (let j = 0; j <= lb; j++) { prevprev[j] = prev[j]; prev[j] = cur[j]; }
  }
  return prev[lb];
}

// ── Word-level correction ─────────────────────────────────────────────────────

function isSkippable(word) {
  if (word.length < 4) return true;
  if (/[\d_.@]/.test(word)) return true;
  if (word === word.toUpperCase()) return true; // acronym
  // mixed-case mid-word (camelCase / PascalCase) → likely an identifier
  if (/[a-z][A-Z]/.test(word)) return true;
  return false;
}

function matchCase(original, correction) {
  if (original[0] === original[0].toUpperCase() && original.slice(1) === original.slice(1).toLowerCase()) {
    return correction[0].toUpperCase() + correction.slice(1);
  }
  return correction;
}

// bestSuggestion — dominantLang ('en'|'tr'|null) breaks ties in favor of
// whichever language the surrounding text is mostly written in.
//
// All suggestions from all dicts are collected then ranked by:
//   1. DL distance (ascending) — only within-maxDist candidates survive
//   2. Dominant-language match
//   3. Insertion/deletion signal — DL distance is always >= |length diff|, so
//      when they're EQUAL every edit in the alignment was an insertion/deletion
//      (a substitution or transposition would keep the length diff below the
//      distance). That's a genuine "missing/extra letter" signal, e.g.
//      "analz"→"analiz" (diff 1 == dist 1) over "analz"→"anala" (diff 0 != dist 1).
//      Language-independent — no blind "longer wins" bias, which previously let
//      an unrelated same-distance word from ANY dict (not just other-language
//      ones) outrank the correct same-length-diff candidate.
//   4. Suggestion index (ascending) — cspell's own quality ranking as final tie-break
function bestSuggestion(word, dominantLang) {
  const lower = word.toLowerCase();
  const enDict   = getEnDict();
  const enGbDict = getEnGbDict();
  const trDict   = getTrDict();

  if ((enDict && enDict.has(lower)) ||
      (enGbDict && enGbDict.has(lower)) ||
      (trDict && trDict.has(lower))) {
    return word; // already correctly spelled in any dictionary
  }

  // Collect all top-N suggestions per dictionary.
  // cspell-trie-lib Trie.suggest() returns string[] ordered by cspell quality.
  const candidates = [];
  if (enDict)   enDict.suggest(lower,   { numSuggestions: 8 }).forEach((w, i) => candidates.push({ lang: 'en', word: w, idx: i }));
  if (enGbDict) enGbDict.suggest(lower, { numSuggestions: 8 }).forEach((w, i) => candidates.push({ lang: 'en', word: w, idx: i }));
  if (trDict)   trDict.suggest(lower,   { numSuggestions: 8 }).forEach((w, i) => candidates.push({ lang: 'tr', word: w, idx: i }));

  if (!candidates.length) return word;

  // Compute DL distances and find minimum
  let minDist = Infinity;
  for (const c of candidates) {
    c.dist = damerauLevenshtein(lower, c.word.toLowerCase());
    if (c.dist < minDist) minDist = c.dist;
  }

  // Real typos are almost always a single edit (or one transposition); only
  // let longer words absorb a second edit. This is what keeps jargon that
  // just isn't in either dictionary (e.g. "docstring") from being swapped for
  // an unrelated real word ("doctoring") merely because it's edit-distance 2.
  const maxDist = lower.length <= 9 ? 1 : 2;
  if (minDist > maxDist) return word;

  const atMin = candidates.filter(c => c.dist === minDist);

  // Rank: dominantLang > insertion/deletion signal > earlier cspell suggestion
  atMin.sort((a, b) => {
    const am = a.lang === dominantLang ? 0 : 1;
    const bm = b.lang === dominantLang ? 0 : 1;
    if (am !== bm) return am - bm;

    const aIns = Math.abs(a.word.length - lower.length) === a.dist ? 0 : 1;
    const bIns = Math.abs(b.word.length - lower.length) === b.dist ? 0 : 1;
    if (aIns !== bIns) return aIns - bIns;

    return a.idx - b.idx;
  });

  let best = atMin[0].word.toLowerCase();

  if (Math.abs(best.length - lower.length) > 2) return word;
  // Typos essentially never change the first letter — this also protects
  // uncommon jargon/acronyms (e.g. "owasp") from being "corrected" into an
  // unrelated real word ("wasp") just because it's within edit distance 1.
  if (best[0] !== lower[0]) return word;

  return matchCase(word, best);
}

function correctWord(word, dominantLang) {
  if (isSkippable(word)) return word;

  const cacheKey = dominantLang ? dominantLang + ':' + word : word;
  const cached = wordCacheGet(cacheKey);
  if (cached !== undefined) return cached;

  let result;
  try {
    result = bestSuggestion(word, dominantLang);
  } catch {
    result = word;
  }
  wordCacheSet(cacheKey, result);
  return result;
}

// detectDominantLang — sample up to 40 alphabetic words (len>=4) from the text
// and count how many are already-correct in each dictionary; whichever wins is
// used only as a tie-breaker, never to block corrections in the other language.
function detectDominantLang(text) {
  const enDict   = getEnDict();
  const enGbDict = getEnGbDict();
  const trDict   = getTrDict();
  if (!(enDict || enGbDict) || !trDict) return null;

  let enHits = 0, trHits = 0, sampled = 0;
  WORD_RE.lastIndex = 0;
  let m;
  while ((m = WORD_RE.exec(text)) !== null && sampled < 40) {
    const w = m[0];
    if (w.length < 4) continue;
    sampled++;
    const lower = w.toLowerCase();
    if ((enDict && enDict.has(lower)) || (enGbDict && enGbDict.has(lower))) enHits++;
    if (trDict.has(lower)) trHits++;
  }
  if (enHits === trHits) return null;
  return enHits > trHits ? 'en' : 'tr';
}

// ── Text-level correction ─────────────────────────────────────────────────────

const WORD_RE = /[\p{L}]+/gu;
const CODE_FENCE_RE = /```[\s\S]*?```/g;

function correctProse(segment, dominantLang) {
  return segment.replace(WORD_RE, w => correctWord(w, dominantLang));
}

function correctText(text) {
  if (!text) return text;
  try {
    if (getEnDict() === null && getEnGbDict() === null && getTrDict() === null) return text; // no dicts available

    const dominantLang = detectDominantLang(text);

    let result = '';
    let lastIndex = 0;
    CODE_FENCE_RE.lastIndex = 0;
    let m;
    while ((m = CODE_FENCE_RE.exec(text)) !== null) {
      result += correctProse(text.slice(lastIndex, m.index), dominantLang);
      result += m[0]; // leave code fence content untouched
      lastIndex = m.index + m[0].length;
    }
    result += correctProse(text.slice(lastIndex), dominantLang);
    return result;
  } catch {
    return text;
  }
}

function correctTypos(text) {
  return correctText(text);
}

module.exports = { correctTypos, correctText, correctWord, warmupSpell };
