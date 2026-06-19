#!/usr/bin/env node
'use strict';

const fs      = require('fs');
const path    = require('path');
const os      = require('os');

const IS_WIN     = process.platform === 'win32';
const HOME       = os.homedir();
const CORP_DIR   = path.join(HOME, '.claude-corp');
const CFG_DIR    = path.join(CORP_DIR, 'claude-config');
const CLAUDE_DIR = path.join(HOME, '.claude');
const HOOKS_DIR  = path.join(CLAUDE_DIR, 'hooks');
const CMDS_DIR   = path.join(CLAUDE_DIR, 'commands');
const SRC        = path.join(__dirname, '..', 'src');
const NODE_BIN   = process.execPath;

// ── helpers ──────────────────────────────────────────────────────────────────

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function copy(src, dest, { overwrite = true } = {}) {
  if (!overwrite && fs.existsSync(dest)) {
    console.log(`  skip (exists): ${dest}`);
    return;
  }
  fs.copyFileSync(src, dest);
  console.log(`  copied: ${dest}`);
}


function q(p) { return `"${p.replace(/"/g, '\\"')}"`; }

// ── 1. directories ───────────────────────────────────────────────────────────

ensureDir(CORP_DIR);
ensureDir(CFG_DIR);
ensureDir(HOOKS_DIR);
ensureDir(CMDS_DIR);

// ── 2. core files ────────────────────────────────────────────────────────────

copy(path.join(SRC, 'saka-proxy.js'), path.join(CORP_DIR, 'saka-proxy.js'));

// calibra-models.json: never overwrite — user may have customised tiers/models
copy(path.join(SRC, 'calibra-models.json'), path.join(CORP_DIR, 'calibra-models.json'), { overwrite: false });

// ── 3. detect existing symlinks ───────────────────────────────────────────────
// If claude-config/{hooks,commands} is already a symlink pointing at .claude/,
// installing to .claude/ is sufficient — the symlink propagates automatically.
// If no symlink exists, install to both locations separately (no symlink created).

const CFG_HOOKS_PATH = path.join(CFG_DIR, 'hooks');
const CFG_CMDS_PATH  = path.join(CFG_DIR, 'commands');

function isSymlink(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

const cfgHooksIsSymlink = isSymlink(CFG_HOOKS_PATH);
const cfgCmdsIsSymlink  = isSymlink(CFG_CMDS_PATH);

if (cfgHooksIsSymlink) {
  console.log(`  symlink detected: ${CFG_HOOKS_PATH} — hooks installed once via .claude/hooks`);
} else {
  ensureDir(CFG_HOOKS_PATH);
  console.log(`  no symlink: will install hooks to both .claude/hooks and claude-config/hooks`);
}
if (cfgCmdsIsSymlink) {
  console.log(`  symlink detected: ${CFG_CMDS_PATH} — commands installed once via .claude/commands`);
} else {
  ensureDir(CFG_CMDS_PATH);
  console.log(`  no symlink: will install commands to both .claude/commands and claude-config/commands`);
}

// ── 4. hooks ─────────────────────────────────────────────────────────────────

for (const hook of ['calibra-notify.js', 'calibra-debug.js', 'calibra-toggle.js']) {
  const src  = path.join(SRC, 'hooks', hook);
  const dest = path.join(HOOKS_DIR, hook);
  copy(src, dest);
  if (!IS_WIN) try { fs.chmodSync(dest, 0o755); } catch {}

  if (!cfgHooksIsSymlink) {
    const cfgDest = path.join(CFG_HOOKS_PATH, hook);
    copy(src, cfgDest);
    if (!IS_WIN) try { fs.chmodSync(cfgDest, 0o755); } catch {}
  }
}

// ── 5. commands ──────────────────────────────────────────────────────────────

copy(path.join(SRC, 'commands', 'calibra.md'), path.join(CMDS_DIR, 'calibra.md'));
if (!cfgCmdsIsSymlink) {
  copy(path.join(SRC, 'commands', 'calibra.md'), path.join(CFG_CMDS_PATH, 'calibra.md'));
}

// ── 6. patch ~/.claude/settings.json (direct `claude` runs) ──────────────────

const DIRECT_HOOKS = [
  { type: 'command', command: `${q(NODE_BIN)} ${q(path.join(HOOKS_DIR, 'calibra-toggle.js'))}`, timeout: 3 },
  { type: 'command', command: `${q(NODE_BIN)} ${q(path.join(HOOKS_DIR, 'calibra-debug.js'))}`,  timeout: 3 },
  { type: 'command', command: `${q(NODE_BIN)} ${q(path.join(HOOKS_DIR, 'calibra-notify.js'))}`, timeout: 3, statusMessage: 'Calibra routing...' }
];

patchSettings(path.join(CLAUDE_DIR, 'settings.json'), DIRECT_HOOKS);

// ── 7. patch ~/.claude-corp/claude-config/settings.json (wrapper runs) ───────
// Only patch if it already exists — wrapper creates it on first run.
// Hooks use CFG_DIR/hooks path (via symlink) so they work in wrapper's context.

function cfgHookCmd(hookFile) {
  const via = path.join(CFG_DIR, 'hooks', hookFile);
  return IS_WIN ? `${q(NODE_BIN)} ${q(via)}` : q(via);
}

const WRAPPER_HOOKS = [
  { type: 'command', command: cfgHookCmd('calibra-toggle.js'), timeout: 3 },
  { type: 'command', command: cfgHookCmd('calibra-debug.js'),  timeout: 3 },
  { type: 'command', command: cfgHookCmd('calibra-notify.js'), timeout: 3, statusMessage: 'Calibra routing...' }
];

const CFG_SETTINGS_PATH = path.join(CFG_DIR, 'settings.json');
if (fs.existsSync(CFG_SETTINGS_PATH)) {
  patchSettings(CFG_SETTINGS_PATH, WRAPPER_HOOKS);
} else {
  console.log(`  skip wrapper settings (not yet created by wrapper): ${CFG_SETTINGS_PATH}`);
}

console.log('\nCalibra installed. Run /calibra status in Claude Code to verify.\n');

// ─────────────────────────────────────────────────────────────────────────────

function patchSettings(settingsPath, calibraHooks) {
  let settings = {};
  if (fs.existsSync(settingsPath)) {
    let raw;
    try { raw = fs.readFileSync(settingsPath, 'utf8'); } catch (e) {
      console.warn(`  warning: cannot read ${settingsPath}: ${e.message} — skipping`);
      return;
    }
    try { settings = JSON.parse(raw); } catch (e) {
      console.warn(`  warning: ${settingsPath} is not valid JSON — skipping`);
      return;
    }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      console.warn(`  warning: ${settingsPath} root is not an object — skipping`);
      return;
    }
  }

  if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) settings.hooks = {};
  if (!Array.isArray(settings.hooks.UserPromptSubmit)) settings.hooks.UserPromptSubmit = [];

  let group = settings.hooks.UserPromptSubmit.find(g => g && typeof g === 'object' && !g.matcher);
  if (!group) { group = { hooks: [] }; settings.hooks.UserPromptSubmit.push(group); }
  if (!Array.isArray(group.hooks)) group.hooks = [];

  let changed = false;
  for (const calibraHook of calibraHooks) {
    const hookFile = path.basename(calibraHook.command.replace(/"/g, '').trim().split(/\s+/).pop());
    const existingIdx = group.hooks.findIndex(h => h && typeof h === 'object' && h.command && h.command.includes(hookFile));
    if (existingIdx === -1) {
      group.hooks.push(calibraHook);
      console.log(`  hook registered: ${hookFile}`);
      changed = true;
    } else if (group.hooks[existingIdx].command !== calibraHook.command) {
      group.hooks[existingIdx] = Object.assign({}, group.hooks[existingIdx], calibraHook);
      console.log(`  hook updated: ${hookFile}`);
      changed = true;
    } else {
      console.log(`  hook up-to-date: ${hookFile}`);
    }
  }

  if (!changed) { console.log('  settings.json: no changes needed'); return; }

  const tmp = settingsPath + '.calibra-tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
    fs.renameSync(tmp, settingsPath);
    console.log('  settings.json updated');
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    console.error(`  error writing settings.json: ${e.message}`);
  }
}
