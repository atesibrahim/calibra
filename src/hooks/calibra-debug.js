#!/usr/bin/env node
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const LOG  = path.join(os.tmpdir(), 'calibra-debug.log');
let input = '';
process.stdin.on('data', d => input += d);
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input || '{}');
    fs.appendFileSync(LOG, JSON.stringify(data, null, 2) + '\n---\n');
  } catch (e) {
    try { fs.appendFileSync(LOG, 'parse error: ' + e.message + '\n'); } catch {}
  }
});
