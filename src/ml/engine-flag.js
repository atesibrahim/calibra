'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const ENGINE_FLAG_PATH = path.join(os.homedir(), '.claude-corp', 'calibra', 'calibra-engine');

// Returns 'ml' or 'heuristic'. Absent / unreadable / invalid content → 'heuristic'.
function readEngine() {
  try {
    const v = fs.readFileSync(ENGINE_FLAG_PATH, 'utf8').trim();
    return v === 'ml' ? 'ml' : 'heuristic';
  } catch { return 'heuristic'; }
}

// Atomic write via tmp+rename — never writes directly to the flag path.
function writeEngine(value) {
  const safe = value === 'ml' ? 'ml' : 'heuristic';
  const tmp  = ENGINE_FLAG_PATH + '.tmp';
  fs.writeFileSync(tmp, safe);
  fs.renameSync(tmp, ENGINE_FLAG_PATH);
}

module.exports = { readEngine, writeEngine, ENGINE_FLAG_PATH };
