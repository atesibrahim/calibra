#!/usr/bin/env node
'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const HOME       = os.homedir();
const CORP_ROOT  = path.join(HOME, '.claude-corp');
const CORP_DIR   = path.join(CORP_ROOT, 'calibra'); // calibra config, flags, ML assets
const CFG_DIR    = path.join(HOME, '.claude-corp', 'claude-config'); // enterprise wrapper — fixed
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

const CALIBRA_HOOK_RE = /calibra-(debug|notify|toggle)/;

function isCalibraHook(h) {
  return h && typeof h === 'object' && h.command && CALIBRA_HOOK_RE.test(h.command);
}

// ── 1. hooks ─────────────────────────────────────────────────────────────────

for (const hook of ['calibra-notify.js', 'calibra-debug.js', 'calibra-toggle.js']) {
  remove(path.join(HOOKS_DIR, hook));
}

// ── 2. commands ──────────────────────────────────────────────────────────────

remove(path.join(CMDS_DIR, 'calibra.md'));

// ── 3. corp files ────────────────────────────────────────────────────────────

remove(path.join(CORP_ROOT, 'saka-proxy.js'));
remove(path.join(CORP_DIR, 'saka-proxy.js')); // legacy install path
remove(path.join(CORP_DIR, 'calibra-models.json'));
remove(path.join(CORP_DIR, 'calibra-disabled'));
remove(path.join(CORP_DIR, 'calibra-ml.json'));
remove(path.join(CORP_DIR, 'calibra-engine'));

// ── 3a. ml/ assets ───────────────────────────────────────────────────────────

const ML_DEST = path.join(CORP_DIR, 'ml');
if (fs.existsSync(ML_DEST)) {
  try {
    fs.rmSync(ML_DEST, { force: true, recursive: true });
    console.log(`  removed dir: ${ML_DEST}`);
  } catch (e) {
    console.warn(`  warning: could not remove ${ML_DEST}: ${e.message}`);
  }
}

// ── 3b. downloaded model assets ──────────────────────────────────────────────

const MODELS_DIR = path.join(CORP_DIR, 'models');
if (fs.existsSync(MODELS_DIR)) {
  try {
    fs.rmSync(MODELS_DIR, { force: true, recursive: true });
    console.log(`  removed dir: ${MODELS_DIR}`);
  } catch (e) {
    console.warn(`  warning: could not remove ${MODELS_DIR}: ${e.message}`);
  }
}

// ── 3c. onnxruntime-node ──────────────────────────────────────────────────────
// Only remove if Calibra created the package.json (marker: name === 'calibra-runtime').

(function removeOnnxRuntime() {
  const corpPkg = path.join(CORP_DIR, 'package.json');
  if (!fs.existsSync(corpPkg)) return;
  try {
    const pkg = JSON.parse(fs.readFileSync(corpPkg, 'utf8'));
    if (pkg.name !== 'calibra-runtime') {
      console.log('  skip onnxruntime removal (package.json not owned by calibra)');
      return;
    }
  } catch { return; }

  const ortPath = path.join(CORP_DIR, 'node_modules', 'onnxruntime-node');
  if (fs.existsSync(ortPath)) {
    try {
      fs.rmSync(ortPath, { force: true, recursive: true });
      console.log(`  removed: ${ortPath}`);
    } catch (e) {
      console.warn(`  warning: could not remove onnxruntime-node: ${e.message}`);
    }
  }

  // Remove package.json and package-lock.json if node_modules is now empty
  const nmDir = path.join(CORP_DIR, 'node_modules');
  try {
    if (fs.existsSync(nmDir) && fs.readdirSync(nmDir).length === 0) {
      fs.rmdirSync(nmDir);
      console.log(`  removed empty dir: ${nmDir}`);
    }
  } catch {}
  remove(corpPkg);
  remove(path.join(CORP_DIR, 'package-lock.json'));
})();

// ── 4. cfg dir hooks/commands ────────────────────────────────────────────────
// Mirrors install logic: symlink → remove symlink; real dir → remove files only.

const CFG_HOOKS_PATH = path.join(CFG_DIR, 'hooks');
const CFG_CMDS_PATH  = path.join(CFG_DIR, 'commands');

function isSymlink(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

if (isSymlink(CFG_HOOKS_PATH)) {
  removeSymlink(CFG_HOOKS_PATH);
} else {
  for (const hook of ['calibra-notify.js', 'calibra-debug.js', 'calibra-toggle.js']) {
    remove(path.join(CFG_HOOKS_PATH, hook));
  }
}

if (isSymlink(CFG_CMDS_PATH)) {
  removeSymlink(CFG_CMDS_PATH);
} else {
  remove(path.join(CFG_CMDS_PATH, 'calibra.md'));
}

// ── 5. remove calibra hooks from both settings.json files ────────────────────

removeHooksFromSettings(path.join(CLAUDE_DIR, 'settings.json'));
removeHooksFromSettings(path.join(CFG_DIR, 'settings.json'));

// ── 6. remove empty dirs left by calibra (deepest first) ─────────────────────

function removeIfEmpty(p) {
  try {
    if (fs.readdirSync(p).length === 0) {
      fs.rmdirSync(p);
      console.log(`  removed empty dir: ${p}`);
    }
  } catch {}
}

removeIfEmpty(path.join(CORP_DIR, 'ml'));
removeIfEmpty(path.join(CORP_DIR, 'models'));
removeIfEmpty(CFG_HOOKS_PATH);
removeIfEmpty(CFG_CMDS_PATH);
removeIfEmpty(CFG_DIR);
removeIfEmpty(CORP_DIR);

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

  const hooksObj = settings.hooks;
  if (!hooksObj || typeof hooksObj !== 'object' || Array.isArray(hooksObj)) return;

  let changed = false;
  const label = path.relative(os.homedir(), settingsPath);

  // Sweep every event type (UserPromptSubmit, PreToolUse, PostToolUse, etc.)
  for (const event of Object.keys(hooksObj)) {
    if (!Array.isArray(hooksObj[event])) continue;

    for (const group of hooksObj[event]) {
      if (!group || !Array.isArray(group.hooks)) continue;
      const before = group.hooks.length;
      group.hooks = group.hooks.filter(h => !isCalibraHook(h));
      if (group.hooks.length < before) {
        console.log(`  removed ${before - group.hooks.length} calibra hook(s) [${event}] from ~/${label}`);
        changed = true;
      }
    }

    // Drop empty catch-all groups calibra created
    const before = hooksObj[event].length;
    hooksObj[event] = hooksObj[event].filter(
      g => g && (g.matcher || (Array.isArray(g.hooks) && g.hooks.length > 0))
    );
    if (hooksObj[event].length < before) changed = true;

    // Drop event key entirely if now empty
    if (hooksObj[event].length === 0) {
      delete hooksObj[event];
      changed = true;
    }
  }

  if (!changed) { console.log(`  no calibra hooks found in ~/${label}`); return; }

  const tmp = settingsPath + '.calibra-tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
    fs.renameSync(tmp, settingsPath);
    console.log(`  updated: ~/${label}`);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    console.error(`  error writing ${settingsPath}: ${e.message}`);
  }
}
