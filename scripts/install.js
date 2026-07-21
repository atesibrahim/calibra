#!/usr/bin/env node
'use strict';

const fs      = require('fs');
const path    = require('path');
const os      = require('os');

const IS_WIN     = process.platform === 'win32';
const HOME       = os.homedir();
const CORP_ROOT  = path.join(HOME, '.claude-corp');
const CORP_DIR   = path.join(CORP_ROOT, 'calibra'); // calibra config, flags, ML assets
const PROXY_DEST = path.join(CORP_ROOT, 'saka-proxy.js'); // enterprise wrapper expects this at root
const CFG_DIR    = path.join(HOME, '.claude-corp', 'claude-config'); // enterprise wrapper — fixed, not under CORP_DIR
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

// ── migrate shared flag → per-env flags ──────────────────────────────────────
// Older installs used one shared `calibra-disabled` flag. Split it so Claude
// and Codex can be toggled independently. If the old flag exists, preserve its
// state in both per-env flags, then remove the old one.
(function migrateDisabledFlag() {
  const legacyFlag = path.join(CORP_DIR, 'calibra-disabled');
  if (!fs.existsSync(legacyFlag)) return;
  const claudeFlag = path.join(CORP_DIR, 'calibra-disabled-claude');
  const codexFlag  = path.join(CORP_DIR, 'calibra-disabled-codex');
  if (!fs.existsSync(claudeFlag)) fs.writeFileSync(claudeFlag, '');
  if (!fs.existsSync(codexFlag))  fs.writeFileSync(codexFlag, '');
  fs.rmSync(legacyFlag, { force: true });
  console.log('  migrated calibra-disabled → calibra-disabled-claude + calibra-disabled-codex');
})();

ensureDir(CFG_DIR);
ensureDir(HOOKS_DIR);
ensureDir(CMDS_DIR);

// ── 2. core files ────────────────────────────────────────────────────────────

// Before overwriting saka-proxy.js: extract and persist the upstream host so
// the new proxy can forward to the same endpoint (e.g. corporate LiteLLM gateway).
(function saveProxyHost() {
  const hostFile = path.join(CORP_DIR, 'calibra-proxy-host');
  if (fs.existsSync(hostFile)) return; // already saved — don't overwrite user edits

  let host = '';

  // 1. Try reading from existing saka-proxy.js (hardcoded REMOTE_HOST constant)
  const existingProxy = fs.existsSync(PROXY_DEST) ? PROXY_DEST : path.join(CORP_DIR, 'saka-proxy.js');
  if (!host && fs.existsSync(existingProxy)) {
    try {
      const src = fs.readFileSync(existingProxy, 'utf8');
      const m = src.match(/const\s+REMOTE_HOST\s*=\s*['"`]([^'"`]+)['"`]/);
      if (m) host = m[1];
    } catch {}
  }

  // 2. Try reading LITELLM_URL from wrapper.sh (lives in ~/.claude-corp/, not calibra/)
  const wrapperSh = path.join(HOME, '.claude-corp', 'wrapper.sh');
  if (!host && fs.existsSync(wrapperSh)) {
    try {
      const src = fs.readFileSync(wrapperSh, 'utf8');
      const m = src.match(/LITELLM_URL\s*=\s*["']?https?:\/\/([^/"'\s]+)/);
      if (m) host = m[1];
    } catch {}
  }

  if (host) {
    fs.writeFileSync(hostFile, host);
    console.log(`  saved proxy host: ${hostFile} (${host})`);
  }
})();

copy(path.join(SRC, 'saka-proxy.js'), PROXY_DEST);

const legacyProxy = path.join(CORP_DIR, 'saka-proxy.js');
if (fs.existsSync(legacyProxy)) {
  try {
    fs.rmSync(legacyProxy, { force: true });
    console.log(`  removed legacy proxy: ${legacyProxy}`);
  } catch (e) {
    console.warn(`  warning: could not remove legacy proxy ${legacyProxy}: ${e.message}`);
  }
}

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

// ── 6. ml/ assets ────────────────────────────────────────────────────────────
// Copy runtime ML assets to ~/.claude-corp/calibra/ml/.
// The standalone proxy is installed at ~/.claude-corp/saka-proxy.js and loads
// these files by absolute path.

const ML_SRC  = path.join(SRC, 'ml');
const ML_DEST = path.join(CORP_DIR, 'ml');

if (fs.existsSync(ML_SRC)) {
  ensureDir(ML_DEST);
  const ML_EXTS = new Set(['.js', '.json']);
  for (const file of fs.readdirSync(ML_SRC)) {
    if (ML_EXTS.has(path.extname(file)) || file === 'vocab.txt') {
      copy(path.join(ML_SRC, file), path.join(ML_DEST, file));
    }
  }
  try { fs.rmSync(path.join(ML_DEST, 'MODEL_CARD.md'), { force: true }); } catch {}
} else {
  console.log('  skip ml/ (src/ml not present)');
}

// calibra-ml.json: never overwrite — user may have customised configuration
copy(path.join(SRC, 'calibra-ml.json'), path.join(CORP_DIR, 'calibra-ml.json'), { overwrite: false });

// ── 6z. Codex/OpenAI support ─────────────────────────────────────────────────
// Codex's config.toml has a STATIC base_url (unlike Claude Code, which gets a
// fresh ANTHROPIC_BASE_URL env var + freshly-spawned proxy every session from
// wrapper.sh). So codex-proxy.js must run as an always-on background service on
// a fixed port, auto-started at login. Detects and patches both personal
// (~/.codex) and corp (~/.codex-corp/codex-config) installs, if present.

copy(path.join(SRC, 'codex-proxy.js'), path.join(CORP_DIR, 'codex-proxy.js'));
if (!IS_WIN) try { fs.chmodSync(path.join(CORP_DIR, 'codex-proxy.js'), 0o755); } catch {}

const CODEX_TARGETS = [
  { key: 'personal', configDir: path.join(HOME, '.codex') },
  { key: 'corp',     configDir: path.join(HOME, '.codex-corp', 'codex-config') },
];

// patchCodexConfig — rewrites config.toml so model_provider points at Calibra's
// local proxy, preserving the original provider's base_url/wire_api as the
// proxy's real upstream. Idempotent: re-running install just refreshes the
// proxy config file, it won't re-back-up or double-patch. Original config is
// backed up once to <configDir>/config.toml.calibra-backup for uninstall.
function patchCodexConfig(target) {
  const configPath = path.join(target.configDir, 'config.toml');
  if (!fs.existsSync(configPath)) return null; // Codex not installed here — skip

  let raw;
  try { raw = fs.readFileSync(configPath, 'utf8'); } catch (e) {
    console.warn(`  warning: cannot read ${configPath}: ${e.message}`);
    return null;
  }

  const providerMatch = raw.match(/^model_provider\s*=\s*"([^"]+)"/m);
  const currentProvider = providerMatch ? providerMatch[1] : null;
  const alreadyPatched = currentProvider === 'calibra';

  // The real upstream (base_url + wire_api) must be resolved from the ORIGINAL
  // provider. Once we've patched model_provider="calibra" that information is no
  // longer discoverable from config.toml, so persist it on first patch and
  // recover it on every re-install. Without this, a reinstall/upgrade silently
  // resets the upstream to the api.openai.com default and the proxy 502s against
  // corp networks that only reach the internal gateway. See CLAUDE.md.
  const originFile = path.join(CORP_DIR, `codex-origin-${target.key}.json`);
  let origin = null;

  if (currentProvider && !alreadyPatched) {
    const sectionRe = new RegExp(`\\[model_providers\\.${currentProvider}\\]([\\s\\S]*?)(?=\\n\\[|$)`);
    const sectionMatch = raw.match(sectionRe);
    if (sectionMatch) {
      const body = sectionMatch[1];
      const baseUrlMatch = body.match(/base_url\s*=\s*"([^"]+)"/);
      const wireApiMatch = body.match(/wire_api\s*=\s*"([^"]+)"/);
      origin = {
        baseUrl: baseUrlMatch ? baseUrlMatch[1] : 'https://api.openai.com/v1',
        wireApi: wireApiMatch ? wireApiMatch[1] : 'responses',
      };
    }
    try { fs.writeFileSync(originFile, JSON.stringify(origin, null, 2) + '\n'); } catch {}
  }

  if (!origin && fs.existsSync(originFile)) {
    try { origin = JSON.parse(fs.readFileSync(originFile, 'utf8')); } catch {}
  }

  // Recovery for configs patched by a pre-origin-file install (or a missing
  // origin file): the original provider's [model_providers.X] section is left
  // intact by patchCodexConfig, so scan for the first non-calibra provider whose
  // base_url isn't our own local loopback proxy. Prefer the backup if present.
  if (!origin) {
    const sources = [];
    const backupPath = configPath + '.calibra-backup';
    if (fs.existsSync(backupPath)) { try { sources.push(fs.readFileSync(backupPath, 'utf8')); } catch {} }
    sources.push(raw);
    for (const src of sources) {
      const re = /\[model_providers\.([^\]]+)\]([\s\S]*?)(?=\n\[|$)/g;
      let m;
      while ((m = re.exec(src))) {
        if (m[1] === 'calibra') continue;
        const b = m[2].match(/base_url\s*=\s*"([^"]+)"/);
        if (!b || /127\.0\.0\.1|localhost/.test(b[1])) continue;
        const w = m[2].match(/wire_api\s*=\s*"([^"]+)"/);
        origin = { baseUrl: b[1], wireApi: w ? w[1] : 'responses' };
        break;
      }
      if (origin) break;
    }
    if (origin) { try { fs.writeFileSync(originFile, JSON.stringify(origin, null, 2) + '\n'); } catch {} }
  }

  if (!origin) origin = { baseUrl: 'https://api.openai.com/v1', wireApi: 'responses' };

  // Split the upstream base_url into host / port / path. The proxy dials
  // host:port and forwards req.url unchanged, so config.toml's local base_url
  // must carry the SAME path prefix as the real upstream (e.g. "/v1"), otherwise
  // Codex's "{base_url}/responses" would resolve to the wrong upstream path.
  let upstreamHost = 'api.openai.com';
  let upstreamPort = 443;
  let basePath = '/v1';
  try {
    const u = new URL(origin.baseUrl);
    upstreamHost = u.hostname;
    upstreamPort = u.port ? parseInt(u.port, 10) : 443;
    basePath = u.pathname.replace(/\/+$/, '') || '';
  } catch {}
  const wireApi = origin.wireApi || 'responses';

  // Fixed port per target — persisted so config.toml's base_url stays valid
  // across reinstalls/upgrades.
  const portFile = path.join(CORP_DIR, `calibra-codex-port-${target.key}`);
  let port = fs.existsSync(portFile) ? parseInt(fs.readFileSync(portFile, 'utf8').trim(), 10) : NaN;
  if (!Number.isInteger(port)) {
    port = target.key === 'corp' ? 45201 : 45200;
    fs.writeFileSync(portFile, String(port));
  }

  const localBaseUrl = `http://127.0.0.1:${port}${basePath}`;
  const proxyConfigPath = path.join(CORP_DIR, `codex-proxy-${target.key}.json`);
  fs.writeFileSync(proxyConfigPath, JSON.stringify({ port, upstreamHost, upstreamPort }, null, 2) + '\n');

  if (alreadyPatched) {
    console.log(`  codex config already patched: ${configPath} (upstream: ${upstreamHost}:${upstreamPort}${basePath})`);
    return { proxyConfigPath, port, target };
  }

  const backupPath = configPath + '.calibra-backup';
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(configPath, backupPath);
    console.log(`  backed up: ${backupPath}`);
  }

  let patched = providerMatch
    ? raw.replace(/^model_provider\s*=\s*"([^"]+)"/m, 'model_provider = "calibra"')
    : 'model_provider = "calibra"\n' + raw;

  const calibraSection = `\n[model_providers.calibra]\nname = "Calibra"\nbase_url = "${localBaseUrl}"\nwire_api = "${wireApi}"\nsupports_websockets = false\n`;
  patched += calibraSection;

  const tmp = configPath + '.calibra-tmp';
  fs.writeFileSync(tmp, patched);
  fs.renameSync(tmp, configPath);
  console.log(`  patched: ${configPath} -> model_provider=calibra, base_url=${localBaseUrl} (upstream: ${upstreamHost}:${upstreamPort}${basePath})`);

  return { proxyConfigPath, port, target };
}

// registerCodexAutostart — always-on background service, platform-native:
// macOS LaunchAgent (RunAtLoad + KeepAlive), Windows Registry Run key (via a
// hidden .vbs launcher so no console window pops up).
function registerCodexAutostart(target, proxyConfigPath) {
  const proxyScript = path.join(CORP_DIR, 'codex-proxy.js');
  const { execFileSync } = require('child_process');

  // Corp networks TLS-intercept upstream traffic with a private root CA that
  // Node's bundled store doesn't trust. The Claude side gets this from
  // wrapper.sh (which exports NODE_EXTRA_CA_CERTS), but codex-proxy.js runs as a
  // login-launched service that inherits none of the interactive shell env, so
  // the CA bundle must be baked into the autostart entry — otherwise every
  // upstream request fails with SELF_SIGNED_CERT_IN_CHAIN → 502.
  const caFile = path.join(CORP_ROOT, 'corp-ca.pem');
  const hasCa = fs.existsSync(caFile) && fs.statSync(caFile).size > 0;
  const caEnv = hasCa
    ? { NODE_EXTRA_CA_CERTS: caFile, SSL_CERT_FILE: caFile, CURL_CA_BUNDLE: caFile, REQUESTS_CA_BUNDLE: caFile }
    : {};

  if (process.platform === 'darwin') {
    const agentsDir = path.join(HOME, 'Library', 'LaunchAgents');
    ensureDir(agentsDir);
    const label = `com.calibra.codex-proxy.${target.key}`;
    const plistPath = path.join(agentsDir, `${label}.plist`);
    const envEntries = Object.entries(caEnv)
      .map(([k, v]) => `    <key>${k}</key><string>${v}</string>`)
      .join('\n');
    const envBlock = envEntries
      ? `  <key>EnvironmentVariables</key>\n  <dict>\n${envEntries}\n  </dict>\n`
      : '';
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${proxyScript}</string>
    <string>${proxyConfigPath}</string>
  </array>
${envBlock}  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${path.join(CORP_DIR, `codex-proxy-${target.key}.out`)}</string>
  <key>StandardErrorPath</key><string>${path.join(CORP_DIR, `codex-proxy-${target.key}.err`)}</string>
</dict>
</plist>
`;
    fs.writeFileSync(plistPath, plist);
    try { execFileSync('launchctl', ['unload', plistPath], { stdio: 'ignore' }); } catch {}
    try {
      execFileSync('launchctl', ['load', '-w', plistPath], { stdio: 'ignore' });
      console.log(`  registered + started LaunchAgent: ${plistPath}`);
    } catch (e) {
      console.warn(`  warning: launchctl load failed: ${e.message} — start manually: launchctl load -w ${q(plistPath)}`);
    }
  } else if (IS_WIN) {
    const vbsPath = path.join(CORP_DIR, `codex-proxy-${target.key}-launcher.vbs`);
    const vbsEnv = Object.entries(caEnv)
      .map(([k, v]) => `env("${k}") = "${v.replace(/"/g, '""')}"\r\n`)
      .join('');
    const vbs = `Set sh = CreateObject("WScript.Shell")\r\n` +
      (vbsEnv ? `Set env = sh.Environment("Process")\r\n${vbsEnv}` : '') +
      `sh.Run "` +
      `""${NODE_BIN}"" ""${proxyScript}"" ""${proxyConfigPath}""` + `", 0, False\r\n`;
    fs.writeFileSync(vbsPath, vbs);

    const regName = `CalibraCodexProxy${target.key[0].toUpperCase()}${target.key.slice(1)}`;
    try {
      execFileSync('reg', [
        'add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
        '/v', regName, '/t', 'REG_SZ', '/d', `wscript.exe "${vbsPath}"`, '/f',
      ], { stdio: 'ignore' });
      console.log(`  registered autostart (Run key): ${regName}`);
    } catch (e) {
      console.warn(`  warning: could not register Run key: ${e.message}`);
    }
    try {
      execFileSync('wscript.exe', [vbsPath], { stdio: 'ignore' });
      console.log(`  started codex-proxy (${target.key})`);
    } catch (e) {
      console.warn(`  warning: could not start proxy now: ${e.message} — it will start at next login`);
    }
  } else {
    console.log(`  skip autostart registration (unsupported platform: ${process.platform})`);
    console.log(`  start manually: ${NODE_BIN} ${proxyScript} ${proxyConfigPath}`);
  }
}

for (const target of CODEX_TARGETS) {
  const result = patchCodexConfig(target);
  if (result) registerCodexAutostart(target, result.proxyConfigPath);
}

// ── 6a. ONNX model download ───────────────────────────────────────────────────
// Fetches router.onnx (all-MiniLM-L6-v2 quantized, ~22 MB) per calibra-ml.json's
// download block. Verified by SHA-256, written via tmp+rename (atomic, never
// leaves a partial file at the final path). Fail-soft: any failure just logs a
// warning — classifyML() checks fs.existsSync() and falls back to heuristic,
// per the "never hard-fail if ML deps are missing" invariant.

function downloadModel() {
  return new Promise((resolve) => {
    let mlConfig;
    try {
      mlConfig = JSON.parse(fs.readFileSync(path.join(CORP_DIR, 'calibra-ml.json'), 'utf8'));
    } catch (e) {
      console.warn(`  warning: could not read calibra-ml.json: ${e.message}`);
      return resolve(false);
    }

    const dl = mlConfig.download;
    if (!dl || !Array.isArray(dl.urls) || !dl.urls.length || !dl.sha256) {
      console.warn('  warning: calibra-ml.json has no download block — skipping model download');
      return resolve(false);
    }

    const modelPath = process.env.CALIBRA_ML_MODEL_PATH || path.join(CORP_DIR, 'models', 'router.onnx');
    if (fs.existsSync(modelPath)) {
      console.log(`  model already present: ${modelPath} — skipping download`);
      return resolve(true);
    }

    ensureDir(path.dirname(modelPath));
    const tmpPath = modelPath + '.download-tmp';

    const https = require('https');
    const crypto = require('crypto');

    function tryUrl(i) {
      if (i >= dl.urls.length) {
        console.warn('  warning: all model download URLs failed — ML mode will fall back to heuristic');
        console.warn(`  To retry manually: download ${dl.urls[0]} to ${modelPath}`);
        return resolve(false);
      }

      const url = dl.urls[i];
      console.log(`  downloading ONNX model (~${Math.round((dl.sizeBytes || 0) / 1e6)} MB): ${url}`);

      const cleanup = () => { try { fs.rmSync(tmpPath, { force: true }); } catch {} };

      const request = (u, redirectsLeft) => {
        const req = https.get(u, { timeout: 60000 }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
            res.resume();
            return request(res.headers.location, redirectsLeft - 1);
          }
          if (res.statusCode !== 200) {
            cleanup();
            console.warn(`  warning: HTTP ${res.statusCode} from ${u}`);
            res.resume();
            return tryUrl(i + 1);
          }

          const hash = crypto.createHash('sha256');
          const out = fs.createWriteStream(tmpPath);
          res.on('data', (chunk) => hash.update(chunk));
          res.pipe(out);

          out.on('finish', () => {
            const actual = hash.digest('hex');
            if (actual !== dl.sha256) {
              cleanup();
              console.warn(`  warning: checksum mismatch for ${u} (expected ${dl.sha256}, got ${actual})`);
              return tryUrl(i + 1);
            }
            try {
              fs.renameSync(tmpPath, modelPath);
              console.log(`  model verified + installed: ${modelPath}`);
              resolve(true);
            } catch (e) {
              cleanup();
              console.warn(`  warning: could not finalize model file: ${e.message}`);
              resolve(false);
            }
          });
          out.on('error', (e) => {
            cleanup();
            console.warn(`  warning: write failed for ${u}: ${e.message}`);
            tryUrl(i + 1);
          });
        });
        req.on('timeout', () => { req.destroy(); cleanup(); console.warn(`  warning: timeout downloading ${u}`); tryUrl(i + 1); });
        req.on('error', (e) => { cleanup(); console.warn(`  warning: request failed for ${u}: ${e.message}`); tryUrl(i + 1); });
      };

      request(url, 5);
    }

    tryUrl(0);
  });
}

// ── 7. install onnxruntime-node + spell-check dependencies, download ONNX model
// onnxruntime-node provides native ONNX inference for the ML routing engine.
// cspell-lib (and its transitive deps: cspell-trie-lib, @cspell/dict-en_us,
// @cspell/dict-en-gb) + @cspell/dict-tr-tr provide generic typo tolerance for
// the classifier (both heuristic and ML engines call correctTypos() before
// scoring). All installed into ~/.claude-corp/calibra/node_modules/ so the
// engine code can require() them from ~/.claude-corp/calibra/ml/*.js.
// Failure is non-fatal: ML mode falls back to heuristic; missing spell-check
// deps just mean typo correction silently no-ops.
//
// Everything from here on runs inside an async IIFE so the (network-bound)
// model download can be awaited before the remaining synchronous steps run.

(async function main() {

await downloadModel();

(function installRuntimeDeps() {
  const corpPkg = path.join(CORP_DIR, 'package.json');
  if (!fs.existsSync(corpPkg)) {
    try {
      fs.writeFileSync(corpPkg, JSON.stringify(
        { name: 'calibra-runtime', version: '1.0.0', private: true }, null, 2
      ) + '\n');
    } catch (e) {
      console.warn(`  warning: could not create ${corpPkg}: ${e.message}`);
      return;
    }
  }

  const RUNTIME_PKGS = ['onnxruntime-node', 'cspell-lib', '@cspell/dict-tr-tr'];
  const missing = RUNTIME_PKGS.filter(pkg => !fs.existsSync(path.join(CORP_DIR, 'node_modules', pkg)));

  if (!missing.length) {
    console.log('  runtime dependencies already installed — skipping');
    return;
  }

  try {
    const { execFileSync } = require('child_process');
    const npmBin = IS_WIN ? 'npm.cmd' : 'npm';
    console.log(`  installing ${missing.join(', ')} (this may take a moment) ...`);
    execFileSync(npmBin, [
      'install',
      '--prefix', CORP_DIR,
      ...missing,
      '--omit=dev',
      '--no-audit',
      '--no-fund',
      '--loglevel=error',
    ], { stdio: 'pipe', timeout: 180000 });
    console.log('  runtime dependencies installed');
  } catch (e) {
    console.warn('  warning: runtime dependency install failed — ML mode falls back to heuristic,');
    console.warn('  and typo correction will silently no-op until dependencies are installed');
    console.warn(`  To retry manually: npm install --prefix ${CORP_DIR} ${missing.join(' ')}`);
  }
})();

// ── 8. patch ~/.claude/settings.json (direct `claude` runs) ──────────────────

const DIRECT_HOOKS = [
  { type: 'command', command: `${q(NODE_BIN)} ${q(path.join(HOOKS_DIR, 'calibra-toggle.js'))}`, timeout: 3 },
  { type: 'command', command: `${q(NODE_BIN)} ${q(path.join(HOOKS_DIR, 'calibra-debug.js'))}`,  timeout: 3 },
  { type: 'command', command: `${q(NODE_BIN)} ${q(path.join(HOOKS_DIR, 'calibra-notify.js'))}`, timeout: 10, statusMessage: 'Calibra routing...' }
];

patchSettings(path.join(CLAUDE_DIR, 'settings.json'), DIRECT_HOOKS);

// ── 9. patch ~/.claude-corp/claude-config/settings.json (wrapper runs) ───────
// Only patch if it already exists — wrapper creates it on first run.
// Hooks use CFG_DIR/hooks path (via symlink) so they work in wrapper's context.

function cfgHookCmd(hookFile) {
  const via = path.join(CFG_DIR, 'hooks', hookFile);
  return IS_WIN ? `${q(NODE_BIN)} ${q(via)}` : q(via);
}

const WRAPPER_HOOKS = [
  { type: 'command', command: cfgHookCmd('calibra-toggle.js'), timeout: 3 },
  { type: 'command', command: cfgHookCmd('calibra-debug.js'),  timeout: 3 },
  { type: 'command', command: cfgHookCmd('calibra-notify.js'), timeout: 10, statusMessage: 'Calibra routing...' }
];

const CFG_SETTINGS_PATH = path.join(CFG_DIR, 'settings.json');
if (fs.existsSync(CFG_SETTINGS_PATH)) {
  patchSettings(CFG_SETTINGS_PATH, WRAPPER_HOOKS);
} else {
  console.log(`  skip wrapper settings (not yet created by wrapper): ${CFG_SETTINGS_PATH}`);
}

console.log('\nCalibra installed. Run /calibra status in Claude Code to verify.\n');

})();

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
    } else if (JSON.stringify(group.hooks[existingIdx]) !== JSON.stringify(Object.assign({}, group.hooks[existingIdx], calibraHook))) {
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
