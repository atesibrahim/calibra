# Contributing to Calibra

Thank you for your interest in contributing. Calibra is a small, focused tool — we value precision over growth. Every change should make the system more correct, more understandable, or cheaper to operate.

---

## Ways to Contribute

| Type | Impact | Notes |
|------|--------|-------|
| Bug reports | High | Include prompt text, expected tier, actual tier, and engine (heuristic/ml) |
| Bug fixes in rule layer | High | Must come with a positive test + FP guard — see [Rule layer changes](#rule-layer-changes) |
| Labeled prompts | High | Directly improves ML accuracy — see [Adding labeled prompts](#adding-labeled-prompts) |
| Documentation | Medium | Diagrams, examples, clarifications |
| New features | Medium | Open an issue first — new behaviour must not regress any eval set |
| Refactors | Low | Only if they remove a genuine complexity; no cosmetic changes |

---

## Getting Started

### Prerequisites

- Node.js ≥ 18
- npm

### Setup

```sh
git clone https://github.com/your-org/calibra.git
cd calibra
npm install
```

### Run unit tests

```sh
node src/ml/classify-core.test.js        # 46 golden cases
node src/ml/classify-core.rules.test.js  # rule-layer cases + FP guards
```

Both must pass before submitting a PR. No external test runner is needed — tests use Node's built-in `assert`.

### Syntax check

```sh
node --check src/saka-proxy.js
node --check src/ml/calibra-ml.js
```

### Run the evaluator (requires ONNX model)

```sh
export CALIBRA_ML_MODEL_PATH=~/.claude-corp/calibra/models/router.onnx
export CALIBRA_ML_TIMEOUT_MS=20000
node tools/evaluate_classifier.js tools/adversarial_eval.jsonl
```

---

## Rule Layer Changes

The rule layer (`src/ml/classify-core.js`) is the most sensitive part of the codebase. A wrong change here affects every prompt, both engines.

**Before touching any regex or vocabulary list:**

1. Identify the specific prompt(s) that are wrong and their expected tier per the rubric (see below).
2. Verify the fix fires correctly on the failing prompts.
3. Run the FP sweep — the new pattern must produce **zero false positives** on all established eval sets:
   - `tools/final_holdout_opus_500.jsonl`
   - `tools/calibra_eval_set.jsonl`
   - `tools/adversarial_eval.jsonl`
4. Run both unit test files — they must stay green.
5. Run `evaluate_classifier.js` on the three established sets and confirm:
   - `accuracy` not down by more than 1 pt on any set vs `docs/BASELINE.md`
   - `routingCost` ≤ the baseline number on every set
   - `severeUnderRouteRate` ≤ the baseline number on every set
6. Add a **positive test** (proves the fix fires) and an **FP guard** (proves a similar-but-different prompt does not fire) in `classify-core.rules.test.js`.

**Do not:**
- Add patterns that fire on seam disputes (mid↔deep "refactor" prompts, light↔mid "configure" prompts) — these are documented labeler-policy variance, not bugs.
- Add typo-tolerant patterns for individual words without prior evidence they improve net accuracy. Past experiments show typo fixes relocate errors without reducing them.
- Change the feature vector (add/remove axes in `CALIBRA_SCOPE_HIGH`, `CALIBRA_DEEP_INTENT`, etc.) without retraining `tier-classifier.json`. Feature vector changes require: retrain → tune thresholds → validate on all sets.

---

## Adding Labeled Prompts

This is the highest-leverage contribution. Labeled prompts improve centroid quality and the ordinal regression head.

### The rubric

Apply these rules mechanically — never use Calibra itself to label (circular dependency):

| Tier | Rule |
|------|------|
| `light` | No judgment required: pure recall/lookup, single-statement mechanical edit (add null check, rename symbol, add return statement, format/indent), or social. The answer does not depend on choosing logic. |
| `mid` | One bounded component, requires choosing logic but no cross-system synthesis: implement/fix/debug/refactor a single function or feature; convert a file; configure one tool; explain one concept. |
| `deep` | Synthesis or judgment scoped to **one** system or domain: design/architect/analyze/audit/investigate/optimize/evaluate within a single bounded context. |
| `ultra` | **Multi-system OR org/platform-wide OR long-horizon program:** ≥2 distinct named subsystems joined; platform migration; comprehensive/company-wide; multi-quarter/year; 3+ enumerated items. |

**Tie-breakers:**
- Single mechanical edit with a mid verb → `light`
- Two or more named systems → `ultra`
- Avoid "template stacking" (do not write 3+ prompts from the same template)

### Format

Add rows to `tools/eval_prompts.jsonl`. Each line must be valid JSON:

```json
{"prompt": "Add a null guard for the user object before calling .save().", "tier": "light"}
{"prompt": "Implement pagination for the products endpoint.", "tier": "mid"}
{"prompt": "Analyze the N+1 query patterns in the orders service and propose fixes.", "tier": "deep"}
{"prompt": "Design the migration strategy for moving auth and billing to separate services.", "tier": "ultra"}
```

### Dataset guidelines

- **Balance:** aim for equal counts across the four tiers.
- **Language parity:** include Turkish prompts (approximately 30–40% of additions). Fold accented characters: `ş→s`, `ı→i`, `ü→u`, `ö→o`, `ç→c`, `ğ→g` are all handled by the ASCII-fold layer, so native Turkish is fine.
- **No duplicates:** check against existing prompts before adding.
- **No auto-labeling:** human or trusted-LLM labels only; never run `calibraClassify()` to label your own training data.

### After adding prompts

```sh
node tools/train_tier_classifier.js                                          # retrain head
node tools/evaluate_classifier.js tools/calibra_eval_set.jsonl              # check test set
node tools/evaluate_classifier.js tools/adversarial_eval.jsonl              # check adversarial
```

If accuracy drops on either test set, inspect the new prompts for labeling errors before opening a PR.

---

## Pull Request Guidelines

- **One concern per PR.** A rule fix and a README update can go together; a rule fix and a retrain cannot.
- **Test output in the PR description.** Paste the `evaluate_classifier.js` output for all three established sets. No output = no review.
- **Update `docs/RESULTS.md`** if you change any eval number (even an improvement). Accuracy claims must match what `evaluate_classifier.js` actually prints.
- **Do not relax a guardrail** to make numbers look better. If adversarial accuracy is 0.885 and your change doesn't improve it, report 0.885.
- **Keep PRs small.** A 5-line rule addition with 3 unit tests is easier to review than a 200-line diff.

### Commit style

```
fix: add "harden" to CALIBRA_DEEP_INTENT (security hardening = deep)
feat: add Turkish "X geneli" breadth word (company/org-wide = ultra)
test: FP guards for Fix A–F from Session 3
docs: update RESULTS.md with holdout_opus4-8 findings
```

---

## Architecture Constraints

These invariants must hold after every change:

| Constraint | Why |
|-----------|-----|
| `ruleClassify` is pure, total, and never-throws | Called on every prompt; an exception kills the proxy |
| `classifyML` is fail-soft | Missing ONNX model must fall through to heuristic, never crash |
| Rule layer does not change the ML feature vector | Adding a new regex to an existing axis (e.g., `CALIBRA_DEEP_INTENT`) **does** change `deepC` and technically requires a retrain. Adding a new axis requires retrain + retune. |
| `calibra-models.json` and `calibra-ml.json` are never overwritten on upgrade | Users customise these; losing their config is a breaking change |
| Rule 4 (ultra) must remain ~0% FP on light/mid/deep | It commits without asking the ML; a false positive is an unrecoverable over-route |
| No new runtime dependencies | The proxy must work with only what npm installs in `~/.claude-corp/calibra/` |

---

## Understanding the Accuracy Ceiling

The system sits at **~88% on independent holdouts** regardless of classifier improvements. This is not a bug — it is the label-noise ceiling:

- Four independent labelers scored 0.76–0.92 on the same prompts.
- Two LLM labelers agree 98% with each other, yet the system is ~88% vs their consensus.
- Training accuracy matches test accuracy (zero train/test gap) → pure bias, zero variance → more data and bigger models do not help.

If you are adding prompts or fixing rules hoping to push past 88% without an LLM judge, you will instead trade agreement with one labeler for disagreement with another. Document the seam you are at (`mid↔deep`, `light↔mid`, `deep↔ultra`) and don't chase it.

See [`docs/RESULTS.md`](docs/RESULTS.md) for the full analysis.

---

## Release Process

Releases are cut from `main`. Only maintainers publish to npm.

```sh
# 1. Ensure all tests pass
node src/ml/classify-core.test.js
node src/ml/classify-core.rules.test.js

# 2. Bump version (creates git tag automatically)
npm version patch   # bug fix
npm version minor   # new feature
npm version major   # breaking change

# 3. Publish
npm publish

# 4. Push tag
git push && git push --tags
```

`calibra-models.json` and `calibra-ml.json` are **never overwritten** on upgrade — this contract must hold in every release.

---

## Code of Conduct

Be direct, be honest about tradeoffs, and disagree by showing data. We don't do motivational hedging ("I feel like maybe...") or social proof ("everyone does it this way"). If a change makes the numbers worse, say so and propose an alternative. That is the highest form of respect for the people using this tool.

---

## Questions

Open an issue with the label `question`. Include the prompt, the tier you expected, and what you got.
