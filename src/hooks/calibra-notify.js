#!/usr/bin/env node
'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const CALIBRA_DISABLED_PATH = path.join(os.homedir(), '.claude-corp', 'calibra-disabled');

let input = '';
process.stdin.on('data', d => input += d);
process.stdin.on('end', () => {
  try {
    if (fs.existsSync(CALIBRA_DISABLED_PATH)) return;
    const data    = JSON.parse(input || '{}');
    const prompt  = (data.prompt || data.tool_input?.prompt || '').trim();
    if (!prompt) return;

    const { calibraClassify } = require(path.join(os.homedir(), '.claude-corp', 'saka-proxy.js'));
    const modelsPath  = path.join(os.homedir(), '.claude-corp', 'calibra-models.json');
    const models      = JSON.parse(fs.readFileSync(modelsPath, 'utf8'));

    const { tier, score, reason } = calibraClassify(prompt);
    const routed = models[tier];
    if (!routed) return;

    const msg = `calibra: ${routed} used regarding your prompt complexity`;
    process.stdout.write(JSON.stringify({
      systemMessage: msg,
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: msg
      }
    }) + '\n');
  } catch {}
});
