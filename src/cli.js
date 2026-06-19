#!/usr/bin/env node
'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

const cmd = process.argv[2] || 'install';
const scripts = path.join(__dirname, '..', 'scripts');

const map = {
  install:   path.join(scripts, 'install.js'),
  upgrade:   path.join(scripts, 'install.js'),
  uninstall: path.join(scripts, 'uninstall.js'),
};

if (!map[cmd]) {
  console.error(`Unknown command: ${cmd}`);
  console.error('Usage: npx calibra [install|upgrade|uninstall]');
  process.exit(1);
}

execFileSync(process.execPath, [map[cmd]], { stdio: 'inherit' });
