# Calibra Baseline — pre-rule-first (Phase 0 lock)

Captured 2026-06-30, before any rule-first change. Model: `minilm-ordinal-regression`
(featureVersion 2). Backup: `src/ml/tier-classifier.json.bak`. Unit tests: **46/46**.

Env: `CALIBRA_ML_MODEL_PATH=~/.claude-corp/calibra/models/router.onnx`,
`CALIBRA_ML_TIMEOUT_MS=20000`. Eval via `tools/evaluate_classifier.js`.

ROUTING_COSTS (actual→pred), from evaluator:
```
        light mid deep ultra
light  [  0    1   3    6 ]
mid    [  4    0   1    3 ]
deep   [  8    3   0    1 ]
ultra  [ 12    8   3    0 ]
```

## Headline metrics

| set | role | rows | accuracy | routingCost | severeUnder | under | over |
|-----|------|-----:|---------:|------------:|------------:|------:|-----:|
| final_holdout_opus_500 | dev (tuning only) | 500 | **0.9340** | 0.1700 | 0.0020 | 0.0320 | 0.0340 |
| calibra_eval_set       | test (report)     | 600 | **0.8883** | 0.4117 | 0.0217 | 0.0733 | 0.0383 |
| adversarial_eval       | test (report)     | 600 | **0.8833** | 0.3100 | 0.0083 | 0.0600 | 0.0567 |

Confirms the prior finding: ~88% ceiling on independent sets, 93% on dev.

## Per-tier recall

| set | light | mid | deep | ultra |
|-----|------:|----:|-----:|------:|
| dev               | 0.936 | 0.888 | 0.944 | 0.968 |
| calibra_eval_set  | 0.847 | 0.820 | 0.967 | 0.920 |
| adversarial_eval  | 0.813 | 0.853 | 0.980 | 0.887 |

All tiers n=125 (dev) / n=150 (test) — balanced.

## Confusion (row = actual, col = predicted)

**final_holdout_opus_500 (dev)**
```
        light  mid deep ultra
light   117    7   1    0
mid       9  111   3    2
deep      0    3 118    4
ultra     0    1   3  121
```

**calibra_eval_set (test)**
```
        light  mid deep ultra
light   127   23   0    0
mid      27  123   0    0
deep      5    0 145    0
ultra     0    8   4  138
```

**adversarial_eval (test)**
```
        light  mid deep ultra
light   122   28   0    0
mid      19  128   3    0
deep      0    0 147    3
ultra     0    5  12  133
```

## Error structure (drives the rule-first design)

1. **light↔mid is the dominant error** on both test sets (23+27, 28+19) — this is
   the genuine-ambiguity boundary (§2). Rules cannot eliminate it; the cost
   residual must keep it cheap (adjacent, low cost).
2. **ultra→mid underroute** (8 on calibra, 5 on adversarial) — the severe/far
   misses. Plan rule 4 (named-subsystem lexicon) directly targets these.
3. **ultra→deep** (4 + 12) — adjacent underroute, lower cost; scope/subsystem
   rules should recover some.
4. deep recall already high (0.967 / 0.980); little headroom there.

## DoD gate (Phase 0) — PASS
- [x] Baseline table recorded (dev + both independent sets): accuracy, per-tier
      recall, confusion, routingCost, severeUnderRouteRate.
- [x] Unit tests 46/46.
- [x] `cp src/ml/tier-classifier.json src/ml/tier-classifier.json.bak`.

Note: `eval_set_3.jsonl` is NOT present in `tools/` — only two independent test
sets exist. The plan's "3 sets" reduces to 2 here; report against both.
