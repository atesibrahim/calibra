#!/usr/bin/env node
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const FLAG       = path.join(os.homedir(), '.claude-corp', 'calibra', 'calibra-disabled-claude');
const FLAG_CODEX = path.join(os.homedir(), '.claude-corp', 'calibra', 'calibra-disabled-codex');

// Matches: /calibra, /calibra on, /calibra off, /calibra status, /calibra toggle
// Also matches chat phrases: "disable calibra", "enable calibra", "calibra status"
// ML engine commands: /calibra ml [on|off], /calibra rules, /calibra neural
const TOGGLE_CMD  = /^\/calibra(?:\s+(on|off|status|toggle|enable|disable|ml(?:\s+(?:on|off))?|rules|neural))?$/i;
const CHAT_CMD    = /^(status|enable|disable|turn\s+on|turn\s+off)\s+calibra$/i;

// Load engine-flag helper from its runtime location — graceful if not yet installed.
let engineFlag;
try {
  const path = require('path');
  const os   = require('os');
  engineFlag = require(path.join(os.homedir(), '.claude-corp', 'calibra', 'ml', 'engine-flag.js'));
} catch { engineFlag = null; }

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
      cmd = (slashMatch[1] || 'status').toLowerCase().trim();
    } else if (chatMatch) {
      const verb = chatMatch[1].toLowerCase();
      cmd = (verb === 'enable' || verb === 'turn on') ? 'on' : 'off';
    } else {
      return; // not a calibra toggle command — pass through
    }

    // This hook runs inside Claude Code only — always affects the Claude flag.
    // Codex flag is managed by codex-proxy.js when the command arrives there.
    const isDisabled      = fs.existsSync(FLAG);
    const isCodexDisabled = fs.existsSync(FLAG_CODEX);
    let msg;

    // ── ML engine commands ─────────────────────────────────────────────────────
    if (cmd === 'ml' || cmd === 'ml on' || cmd === 'neural') {
      try { if (engineFlag) engineFlag.writeEngine('ml'); } catch (e) { process.stderr.write('[calibra] engine write failed: ' + e.message + '\n'); }
      if (isDisabled) fs.unlinkSync(FLAG);
      msg = 'Calibra enabled — ML engine active.';
    } else if (cmd === 'ml off' || cmd === 'rules') {
      try { if (engineFlag) engineFlag.writeEngine('heuristic'); } catch (e) { process.stderr.write('[calibra] engine write failed: ' + e.message + '\n'); }
      msg = 'Calibra ML engine disabled — using heuristic rules.';
    // ── Routing on/off/toggle — Claude Code env only ───────────────────────────
    } else if (cmd === 'on') {
      if (isDisabled) fs.unlinkSync(FLAG);
      msg = 'Calibra enabled.';
    } else if (cmd === 'off') {
      if (!isDisabled) fs.writeFileSync(FLAG, '');
      msg = 'Calibra disabled.';
    } else if (cmd === 'toggle') {
      if (isDisabled) { fs.unlinkSync(FLAG); msg = 'Calibra enabled.'; }
      else            { fs.writeFileSync(FLAG, ''); msg = 'Calibra disabled.'; }
    } else {
      // status — show per-env state
      const engine = (() => { try { return engineFlag ? engineFlag.readEngine() : 'heuristic'; } catch { return 'heuristic'; } })();
      msg  = 'Calibra status:\n';
      msg += '  Claude Code : ' + (isDisabled      ? 'Disabled' : 'Enabled') + '\n';
      msg += '  Codex       : ' + (isCodexDisabled ? 'Disabled' : 'Enabled') + '\n';
      msg += '  Engine      : ' + engine + '\n';
      msg += 'Commands: /calibra on|off  |  /calibra ml on|off  |  /calibra rules';
    }

    process.stdout.write(JSON.stringify({ decision: 'block', reason: msg }));
  } catch {}
});
