# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

Calibra is a Claude Code prompt-routing plugin. It intercepts every prompt via a local HTTP proxy, classifies its complexity, and rewrites the `model` field in-flight so cheap prompts use lighter models automatically.

## Key Commands

```bash
# Install / upgrade (also runs automatically on npm install)
node scripts/install.js

# Uninstall
node scripts/uninstall.js

# CLI shorthand
node src/cli.js [install|upgrade|uninstall]

# Recompute ML tier centroids (after editing tools/eval_prompts.jsonl)
node tools/compute_centroids.js

# Golden regression test (heuristic classifier)
node src/ml/classify-core.test.js

# Syntax check all JS
node --check src/saka-proxy.js && node --check src/ml/calibra-ml.js

# Publish
npm version patch && npm publish && git push --follow-tags
```

No test framework, no lint scripts — Node.js built-in `assert` only.

## Architecture

```
Claude Code
    │
    ▼ ANTHROPIC_BASE_URL → http://127.0.0.1:{port}
~/.claude-corp/saka-proxy.js            ← local HTTP proxy
    │  1. reads engine flag (heuristic | ml)
    │  2. classifies prompt → tier (light/mid/deep/ultra)
    │  3. rewrites body.model in-flight
    ▼
Upstream AI server  (CALIBRA_REMOTE_HOST)
```

**Two classification engines:**
- **Heuristic (default):** `calibraClassify()` in `saka-proxy.js` — 5-axis regex scoring
- **ML (opt-in):** `classifyML()` in `src/ml/calibra-ml.js` — MiniLM-L6-v2 ONNX + cosine similarity to tier centroids

ML engine is fail-soft: missing model / onnxruntime error / timeout → silently falls back to heuristic.

## Runtime File Layout

The enterprise wrapper expects the proxy at `~/.claude-corp/saka-proxy.js`. Calibra config, flags, ML assets, and local dependencies live under `~/.claude-corp/calibra/`:

```
~/.claude-corp/
  saka-proxy.js             ← copied from src/ on install
  calibra/
    calibra-models.json     ← tier→model map (never overwritten on upgrade)
    calibra-ml.json         ← ML config (never overwritten on upgrade)
    calibra-disabled        ← flag file: routing off when present
    calibra-engine          ← flag file: 'ml' or 'heuristic' (absent=heuristic)
    calibra-proxy-host      ← upstream hostname
    ml/
      calibra-ml.js         ← ML classifier
      classify-core.js      ← shared fast-exits
      engine-flag.js        ← readEngine/writeEngine
      tokenizer.js          ← BERT WordPiece tokenizer
      vocab.txt             ← bert-base-uncased vocab (30,522 tokens)
      tier-centroids.json   ← 4×384 centroid vectors
    models/
      router.onnx           ← Xenova/all-MiniLM-L6-v2 quantized (~22 MB)
    node_modules/           ← onnxruntime-node (installed by install.js)
    package.json
  claude-config/            ← enterprise wrapper (not Calibra's)
```

## Source Layout

| File | Role |
|------|------|
| `src/saka-proxy.js` | Proxy server + heuristic classifier |
| `src/ml/classify-core.js` | Shared fast-exits and regex constants |
| `src/ml/calibra-ml.js` | ML engine: ONNX session, cosine similarity, LRU cache, warmup |
| `src/ml/tokenizer.js` | BERT WordPiece tokenizer (reads vocab.txt) |
| `src/ml/tier-centroids.json` | Baked-in tier centroids (~10 KB) |
| `src/ml/vocab.txt` | bert-base-uncased vocabulary (bundled) |
| `src/calibra-ml.json` | ML metadata: model URL, SHA-256, hiddenSize, maxLength |
| `src/calibra-models.json` | Default tier→model map |
| `src/hooks/calibra-toggle.js` | Handles `/calibra on\|off\|ml` commands |
| `src/hooks/calibra-notify.js` | Shows routing decision in context bar |
| `src/hooks/calibra-debug.js` | Logs raw hook input to tmpdir |
| `src/commands/calibra.md` | `/calibra` slash command definition |
| `tools/eval_prompts.jsonl` | 759 hand-labeled prompts for centroid computation |
| `tools/compute_centroids.js` | Recomputes tier-centroids.json from eval_prompts.jsonl |
| `scripts/install.js` | Copies files, installs onnxruntime-node, patches settings.json |
| `scripts/uninstall.js` | Removes all installed files and hook entries |

## Configuration

- `~/.claude-corp/calibra/calibra-models.json` — tier→model map (edit to change models)
- `~/.claude-corp/calibra/calibra-ml.json` — ML metadata (rarely edited)
- `CALIBRA_REMOTE_HOST` — upstream AI server hostname
- `CALIBRA_ML_MODEL_PATH` — override ONNX model path (air-gapped installs)
- `CALIBRA_ML_TIMEOUT_MS` — ML inference timeout in ms (default 250)

## Important Invariants

- `calibraClassify()` returns `{tier, score, reason, engine}` — consumed by proxy AND notify hook
- `engine-flag.js` uses atomic tmp+rename writes — never write directly to flag files
- `saka-proxy.js` must never hard-fail if ML deps are missing — heuristic always works
- Fast-exits (slash command, greeting, trivial, short-conv) run before any ML inference
- `calibra-models.json` and `calibra-ml.json` are **never overwritten** on upgrade

## Improving ML Accuracy

Add labeled prompts to `tools/eval_prompts.jsonl` then:
```bash
node tools/compute_centroids.js    # recomputes src/ml/tier-centroids.json
npm version patch && npm publish   # ships new centroids to users
```
Labels must be human-assigned — do not use `calibraClassify()` to auto-label (circular dependency).
