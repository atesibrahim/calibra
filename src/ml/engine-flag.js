'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

// Engine flag is per-environment, mirroring the per-env disabled flags:
//   calibra-engine        → Claude Code   (default path; unchanged for back-compat)
//   calibra-engine-codex  → Codex CLI
const ENGINE_FLAG_PATH       = path.join(os.homedir(), '.claude-corp', 'calibra', 'calibra-engine');
const ENGINE_FLAG_PATH_CODEX = path.join(os.homedir(), '.claude-corp', 'calibra', 'calibra-engine-codex');

// Returns 'ml' or 'heuristic'. Absent / unreadable / invalid content → 'heuristic'.
// flagPath defaults to the Claude flag, so existing callers are unaffected.
function readEngine(flagPath = ENGINE_FLAG_PATH) {
  try {
    const v = fs.readFileSync(flagPath, 'utf8').trim();
    return v === 'ml' ? 'ml' : 'heuristic';
  } catch { return 'heuristic'; }
}

// Atomic write via tmp+rename — never writes directly to the flag path.
function writeEngine(value, flagPath = ENGINE_FLAG_PATH) {
  const safe = value === 'ml' ? 'ml' : 'heuristic';
  const tmp  = flagPath + '.tmp';
  fs.writeFileSync(tmp, safe);
  fs.renameSync(tmp, flagPath);
}

module.exports = { readEngine, writeEngine, ENGINE_FLAG_PATH, ENGINE_FLAG_PATH_CODEX };
