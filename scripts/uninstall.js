#!/usr/bin/env node
'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const HOME       = os.homedir();
const CORP_DIR   = path.join(HOME, '.claude-corp');
const CFG_DIR    = path.join(CORP_DIR, 'claude-config');
const CLAUDE_DIR = path.join(HOME, '.claude');
const HOOKS_DIR  = path.join(CLAUDE_DIR, 'hooks');
const CMDS_DIR   = path.join(CLAUDE_DIR, 'commands');

// ── helpers ──────────────────────────────────────────────────────────────────

function remove(p) {
  if (fs.existsSync(p)) {
    fs.rmSync(p, { force: true, recursive: false });
    console.log(`  removed: ${p}`);
  }
}

function removeSymlink(p) {
  try {
    const stat = fs.lstatSync(p);
    if (stat.isSymbolicLink()) {
      fs.rmSync(p, { force: true });
      console.log(`  removed symlink: ${p}`);
    }
  } catch {}
}

// ── 1. hooks ─────────────────────────────────────────────────────────────────

for (const hook of ['calibra-notify.js', 'calibra-debug.js', 'calibra-toggle.js']) {
  remove(path.join(HOOKS_DIR, hook));
}

// ── 2. commands ──────────────────────────────────────────────────────────────

remove(path.join(CMDS_DIR, 'calibra.md'));

// ── 3. corp files ─────────────────────────────────────────────────────────────
// calibra-models.json intentionally kept — user-customised

remove(path.join(CORP_DIR, 'saka-proxy.js'));

// ── 4. symlinks created by install ───────────────────────────────────────────

removeSymlink(path.join(CFG_DIR, 'hooks'));
removeSymlink(path.join(CFG_DIR, 'commands'));

// Remove claude-config dir only if now empty
try {
  const remaining = fs.readdirSync(CFG_DIR);
  if (remaining.length === 0) {
    fs.rmdirSync(CFG_DIR);
    console.log(`  removed empty dir: ${CFG_DIR}`);
  }
} catch {}

// ── 5. remove calibra hooks from both settings.json files ────────────────────

removeHooksFromSettings(path.join(CLAUDE_DIR, 'settings.json'));
removeHooksFromSettings(path.join(CORP_DIR, 'claude-config', 'settings.json'));

console.log('\nCalibra uninstalled.\n');

// ─────────────────────────────────────────────────────────────────────────────

function removeHooksFromSettings(settingsPath) {
  if (!fs.existsSync(settingsPath)) return;

  let raw, settings;
  try { raw = fs.readFileSync(settingsPath, 'utf8'); } catch (e) {
    console.warn(`  warning: cannot read ${settingsPath}: ${e.message}`);
    return;
  }
  try { settings = JSON.parse(raw); } catch (e) {
    console.warn(`  warning: ${settingsPath} is not valid JSON — skipping`);
    return;
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return;

  const groups = Array.isArray(settings.hooks?.UserPromptSubmit)
    ? settings.hooks.UserPromptSubmit
    : [];

  let changed = false;
  for (const group of groups) {
    if (!group || !Array.isArray(group.hooks)) continue;
    const before = group.hooks.length;
    group.hooks = group.hooks.filter(
      h => !h || !h.command || !/(calibra-debug|calibra-notify|calibra-toggle)/.test(h.command)
    );
    if (group.hooks.length < before) {
      console.log(`  removed ${before - group.hooks.length} calibra hook(s) from ${path.basename(path.dirname(settingsPath))}/settings.json`);
      changed = true;
    }
  }

  // Drop empty catch-all groups we created
  const cleaned = groups.filter(g => g && (g.matcher || (Array.isArray(g.hooks) && g.hooks.length > 0)));
  if (cleaned.length !== groups.length) changed = true;
  if (settings.hooks) settings.hooks.UserPromptSubmit = cleaned;

  if (!changed) return;

  const tmp = settingsPath + '.calibra-tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
    fs.renameSync(tmp, settingsPath);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    console.error(`  error writing ${settingsPath}: ${e.message}`);
  }
}
