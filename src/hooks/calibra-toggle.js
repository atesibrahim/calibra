#!/usr/bin/env node
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const FLAG = path.join(os.homedir(), '.claude-corp', 'calibra-disabled');

// Matches: /calibra, /calibra on, /calibra off, /calibra status, /calibra toggle
// Also matches chat phrases: "disable calibra", "enable calibra", "calibra status"
const TOGGLE_CMD = /^\/calibra(?:\s+(on|off|status|toggle|enable|disable))?$/i;
const CHAT_CMD   = /^(status|enable|disable|turn\s+on|turn\s+off)\s+calibra$/i;

let input = '';
process.stdin.on('data', d => input += d);
process.stdin.on('end', () => {
  try {
    const data   = JSON.parse(input || '{}');
    const prompt = (data.prompt || '').trim();

    let cmd;
    const slashMatch = prompt.match(TOGGLE_CMD);
    const chatMatch  = prompt.match(CHAT_CMD);

    if (slashMatch) {
      cmd = (slashMatch[1] || 'status').toLowerCase();
    } else if (chatMatch) {
      const verb = chatMatch[1].toLowerCase();
      cmd = (verb === 'enable' || verb === 'turn on') ? 'on' : 'off';
    } else {
      return; // not a calibra toggle command — pass through
    }

    const isDisabled = fs.existsSync(FLAG);
    let msg;

    if (cmd === 'on') {
      if (isDisabled) fs.unlinkSync(FLAG);
      msg = 'Calibra enabled — model routing active.';
    } else if (cmd === 'off') {
      if (!isDisabled) fs.writeFileSync(FLAG, '');
      msg = 'Calibra disabled — all prompts use current model.';
    } else if (cmd === 'toggle') {
      if (isDisabled) { fs.unlinkSync(FLAG); msg = 'Calibra enabled — model routing active.'; }
      else            { fs.writeFileSync(FLAG, ''); msg = 'Calibra disabled — all prompts use current model.'; }
    } else {
      msg = isDisabled ? 'Calibra: Disabled.\n' : 'Calibra: Enabled.\n';
      msg += isDisabled ? 'To enable run "/calibra on"' : 'To disable run "/calibra off"';
    }

    process.stdout.write(JSON.stringify({ decision: 'block', reason: msg }));
  } catch {}
});
