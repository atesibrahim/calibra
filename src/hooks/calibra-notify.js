#!/usr/bin/env node
'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const CALIBRA_DISABLED_PATH = path.join(os.homedir(), '.claude-corp', 'calibra', 'calibra-disabled');
const CALIBRA_MODELS_PATH   = path.join(os.homedir(), '.claude-corp', 'calibra', 'calibra-models.json');
const CALIBRA_PROXY_PATH    = path.join(os.homedir(), '.claude-corp', 'saka-proxy.js');

function classifyHeuristic(prompt, models) {
  const { calibraClassify } = require(CALIBRA_PROXY_PATH);
  const result = calibraClassify(prompt);
  return { tier: result.tier, routed: models[result.tier] };
}

let input = '';
process.stdin.on('data', d => input += d);
process.stdin.on('end', async () => {
  try {
    if (fs.existsSync(CALIBRA_DISABLED_PATH)) return;
    const data   = JSON.parse(input || '{}');
    const prompt = (data.prompt || data.tool_input?.prompt || '').trim();
    if (!prompt) return;

    // Read engine flag — default heuristic
    let engine = 'heuristic';
    try {
      const ef = require(path.join(os.homedir(), '.claude-corp', 'calibra', 'ml', 'engine-flag.js'));
      engine = ef.readEngine();
    } catch {}

    let tier, routed, engineLabel;
    const models = JSON.parse(fs.readFileSync(CALIBRA_MODELS_PATH, 'utf8'));

    if (engine === 'ml') {
      try {
        const { classifyML } = require(path.join(os.homedir(), '.claude-corp', 'calibra', 'ml', 'calibra-ml.js'));
        const result     = await classifyML(prompt);
        tier    = result.tier;
        routed  = models[tier];
        engineLabel = result.engine === 'heuristic' ? ' (engine: ml-fallback)' : ' (engine: ml)';
      } catch (e) {
        // ML notification path failed — still show a routing message.
        const h = classifyHeuristic(prompt, models);
        tier = h.tier;
        routed = h.routed;
        engineLabel = ' (engine: ml-fallback)';
      }
    }

    if (engine === 'heuristic') {
      const h = classifyHeuristic(prompt, models);
      tier        = h.tier;
      routed      = h.routed;
      engineLabel = '';
    }

    if (!routed) return;

    const msg = `calibra: ${routed} used regarding your prompt complexity${engineLabel}`;
    process.stdout.write(JSON.stringify({
      systemMessage: msg,
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: msg,
      },
    }) + '\n');
  } catch {}
});
