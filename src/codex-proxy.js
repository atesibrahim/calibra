#!/usr/bin/env node
'use strict';

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const os    = require('os');

// --- Calibra: Codex/OpenAI model routing (Responses API) ---
const CALIBRA_BASE          = path.join(os.homedir(), '.claude-corp', 'calibra');
const CALIBRA_MODELS_PATH   = path.join(CALIBRA_BASE, 'calibra-models.json');
const CALIBRA_DISABLED_PATH = path.join(CALIBRA_BASE, 'calibra-disabled');

function requireCalibraMl(file) {
  const sourcePath = path.join(__dirname, 'ml', file);
  if (fs.existsSync(sourcePath)) return require(sourcePath);
  return require(path.join(CALIBRA_BASE, 'ml', file));
}

const { extractPromptOpenAI, calibraClassify } = requireCalibraMl('classify-core.js');

let calibraConfigWarned = false;

function loadOpenAiModels() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CALIBRA_MODELS_PATH, 'utf8'));
    return (cfg && typeof cfg.openai === 'object') ? cfg.openai : null;
  } catch {
    return null;
  }
}

// calibraRouteOpenAI — same on/off flag and tier map as the Claude side
// (calibra-disabled), just a different wire format to extract the prompt from.
function calibraRouteOpenAI(parsedBody) {
  if (process.env.CALIBRA_DISABLED === '1') return null;
  if (fs.existsSync(CALIBRA_DISABLED_PATH)) return null;

  const models = loadOpenAiModels();
  if (!models) {
    if (!calibraConfigWarned) {
      process.stderr.write('[calibra-codex] no calibra-models.json "openai" block — routing disabled\n');
      calibraConfigWarned = true;
    }
    return null;
  }

  const prompt = extractPromptOpenAI(parsedBody);
  const { tier, reason } = calibraClassify(prompt);
  const routed = models[tier];
  if (!routed) return null;

  const currentModel = parsedBody.model || '';
  if (routed === currentModel) return null;

  process.stderr.write(`[calibra-codex] routing to ${routed} (tier: ${tier}, reason: ${reason})\n`);
  return { model: routed, tier, reason };
}

// --- Calibra: /calibra on|off|status|toggle for Codex ------------------------
// Codex has no hook system (unlike Claude Code's UserPromptSubmit), so a slash
// command typed in the TUI goes straight to the model as plain text — there's
// no interception point before it reaches the wire. codex-proxy.js IS that wire,
// so it intercepts the command here: toggles calibra-disabled synchronously,
// then forces the real upstream call to just relay the confirmation message
// verbatim, on the cheapest tier. This reuses the actual model's real SSE
// response rather than hand-fabricating Responses-API streaming events — Codex's
// Rust client parses each event into an internal ResponseItem via an
// undocumented schema, and a hand-built stream that doesn't match exactly risks
// hanging or breaking the turn with no way to verify short of live testing.
const CALIBRA_TOGGLE_CMD = /^\/calibra(?:\s+(on|off|status|toggle|enable|disable))?$/i;
const CALIBRA_CHAT_CMD   = /^(status|enable|disable|turn\s+on|turn\s+off)\s+calibra$/i;

function calibraHandleCommand(parsedBody) {
  const prompt = extractPromptOpenAI(parsedBody).trim();
  if (!prompt) return null;

  let cmd;
  const slashMatch = prompt.match(CALIBRA_TOGGLE_CMD);
  const chatMatch  = prompt.match(CALIBRA_CHAT_CMD);
  if (slashMatch) {
    cmd = (slashMatch[1] || 'status').toLowerCase();
  } else if (chatMatch) {
    const verb = chatMatch[1].toLowerCase();
    cmd = (verb === 'enable' || verb === 'turn on') ? 'on' : (verb === 'status' ? 'status' : 'off');
  } else {
    return null;
  }

  const isDisabled = fs.existsSync(CALIBRA_DISABLED_PATH);
  let msg;

  if (cmd === 'on' || cmd === 'enable') {
    if (isDisabled) fs.unlinkSync(CALIBRA_DISABLED_PATH);
    msg = 'Calibra enabled — model routing active.';
  } else if (cmd === 'off' || cmd === 'disable') {
    if (!isDisabled) fs.writeFileSync(CALIBRA_DISABLED_PATH, '');
    msg = 'Calibra disabled — all prompts use the current model.';
  } else if (cmd === 'toggle') {
    if (isDisabled) { fs.unlinkSync(CALIBRA_DISABLED_PATH); msg = 'Calibra enabled — model routing active.'; }
    else            { fs.writeFileSync(CALIBRA_DISABLED_PATH, ''); msg = 'Calibra disabled — all prompts use the current model.'; }
  } else {
    msg = isDisabled ? 'Calibra: Disabled' : 'Calibra: Enabled';
    msg += isDisabled ? '\nTo enable: /calibra on' : '\nTo disable: /calibra off';
  }

  process.stderr.write(`[calibra-codex] command: ${prompt} -> ${msg.split('\n')[0]}\n`);

  const models = loadOpenAiModels();
  const cheapModel = (models && models.light) || parsedBody.model || 'gpt-5.4-mini';
  return { msg, model: cheapModel };
}

function injectCommandReply(body, decision) {
  body.instructions = `# Calibra command\n`
    + `The user ran a Calibra CLI command. Do not use any tools, do not add commentary, `
    + `do not add anything before or after. Output exactly this text and nothing else:\n\n`
    + `${decision.msg}`;
}
// --- end Calibra command handling ---

// isFreshUserTurn — true when the request represents a brand-new user prompt
// (input is a string, or the last input item is a user message), false for the
// tool-call continuations Codex fires within a single turn. Gates the inline
// routing note so it appears once per user message, not on every upstream call.
function isFreshUserTurn(body) {
  if (!body) return false;
  if (typeof body.input === 'string') return true;
  if (!Array.isArray(body.input) || body.input.length === 0) return false;
  // Codex appends developer/tool/reasoning items after the user turn and throughout
  // tool-call continuations. Skip those; the first non-skipped role tells us whether
  // this is a fresh user turn (role==='user') or a tool-call continuation (role==='assistant').
  const SKIP = new Set(['developer', 'reasoning', 'tool_search_call', 'tool_search_output',
    'function_call', 'function_call_output']);
  for (let i = body.input.length - 1; i >= 0; i--) {
    const item = body.input[i];
    if (!item || !item.role || SKIP.has(item.role)) continue;
    return item.role === 'user';
  }
  return false;
}

// injectRoutingNote — appends a directive to the request's `instructions` asking
// the model to echo the routing decision as the first line of its reply, so the
// user sees which tier/model Calibra picked inline in the Codex TUI (Codex has
// no hook to render a status line the way the Claude side does).
function injectRoutingNote(body, decision) {
  const line = `» [calibra: ${decision.model} · ${decision.tier}]`;
  const note = `# Calibra routing\n`
    + `Start your reply with the following line exactly as written, on its own `
    + `line, followed by a blank line, before anything else:\n${line}`;
  body.instructions = (typeof body.instructions === 'string' && body.instructions.length)
    ? `${body.instructions}\n\n${note}`
    : note;
}
// --- end Calibra ---

// ── proxy config ─────────────────────────────────────────────────────────────
// Loaded from a JSON file passed as argv[2] (or CALIBRA_CODEX_PROXY_CONFIG),
// written by install.js — one config per Codex install (personal / corp) since
// each has its own upstream and a fixed local port (config.toml's base_url is
// static, unlike Claude's per-session ANTHROPIC_BASE_URL):
//   { "port": <fixed local port>, "upstreamHost": "<real upstream hostname>",
//     "upstreamPort": <real upstream port, default 443> }
//
// The path prefix (e.g. "/v1") is NOT stored here: install.js sets config.toml's
// local base_url to carry the same prefix as the real upstream, so req.url is
// already the correct upstream path and is forwarded unchanged.
//
// Auth is NOT injected here: Codex CLI reads its own OPENAI_API_KEY from
// auth.json and attaches it to every outbound request regardless of base_url,
// so the incoming Authorization header is simply forwarded unchanged.

const CONFIG_PATH = process.argv[2] || process.env.CALIBRA_CODEX_PROXY_CONFIG;
if (!CONFIG_PATH) {
  process.stderr.write('[calibra-codex] usage: codex-proxy.js <config.json>\n');
  process.exit(1);
}

let proxyConfig;
try {
  proxyConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch (e) {
  process.stderr.write(`[calibra-codex] failed to read config ${CONFIG_PATH}: ${e.message}\n`);
  process.exit(1);
}

const PORT = proxyConfig.port;
const UPSTREAM_HOST = proxyConfig.upstreamHost;
const UPSTREAM_PORT = Number.isInteger(proxyConfig.upstreamPort) ? proxyConfig.upstreamPort : 443;
if (typeof PORT !== 'number' || !UPSTREAM_HOST) {
  process.stderr.write('[calibra-codex] config must include numeric "port" and "upstreamHost"\n');
  process.exit(1);
}

const MAX_BODY_SIZE = 25 * 1024 * 1024;
const UPSTREAM_TIMEOUT = 180000;
const UPSTREAM_AGENT = new https.Agent({ keepAlive: true, maxSockets: 32 });

const server = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    const headers = { ...req.headers, host: UPSTREAM_HOST };
    delete headers['connection'];
    const proxy = https.request({ hostname: UPSTREAM_HOST, port: UPSTREAM_PORT, path: req.url, method: req.method, headers, agent: UPSTREAM_AGENT }, p => { res.writeHead(p.statusCode, p.headers); p.pipe(res); });
    proxy.on('error', (e) => { console.error('[calibra-codex] upstream error:', e.code, e.message); if (!res.headersSent) { res.writeHead(502); res.end(); } });
    req.pipe(proxy);
    return;
  }

  req.on('error', () => { if (!res.headersSent) { res.writeHead(400); res.end(); } });

  let size = 0;
  const chunks = [];
  req.on('data', c => {
    size += c.length;
    if (size > MAX_BODY_SIZE) { req.destroy(); res.writeHead(413); res.end(); return; }
    chunks.push(c);
  });

  req.on('end', () => {
    if (size > MAX_BODY_SIZE) return;
    let body = Buffer.concat(chunks);

    try {
      const parsed = JSON.parse(body);
      const cmdDecision = isFreshUserTurn(parsed) ? calibraHandleCommand(parsed) : null;
      if (cmdDecision) {
        parsed.model = cmdDecision.model;
        injectCommandReply(parsed, cmdDecision);
        body = Buffer.from(JSON.stringify(parsed));
      } else {
        const decision = calibraRouteOpenAI(parsed);
        if (decision) {
          parsed.model = decision.model;
          if (isFreshUserTurn(parsed)) injectRoutingNote(parsed, decision);
          body = Buffer.from(JSON.stringify(parsed));
        }
      }
    } catch {}

    const headers = { ...req.headers, host: UPSTREAM_HOST, 'content-length': body.length };
    delete headers['connection'];

    const proxy = https.request({
      hostname: UPSTREAM_HOST, port: UPSTREAM_PORT, path: req.url, method: 'POST', headers, timeout: UPSTREAM_TIMEOUT, agent: UPSTREAM_AGENT,
    }, proxyRes => { res.writeHead(proxyRes.statusCode, proxyRes.headers); proxyRes.pipe(res); });

    proxy.on('timeout', () => { proxy.destroy(); if (!res.headersSent) { res.writeHead(504); res.end(); } });
    proxy.on('error', (e) => { console.error('[calibra-codex] upstream error:', e.code, e.message); if (!res.headersSent) { res.writeHead(502); res.end(); } });
    proxy.write(body);
    proxy.end();
  });
});

server.keepAliveTimeout = 65000;

if (require.main === module) {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`CALIBRA_CODEX_PROXY_PORT=${server.address().port} upstream=${UPSTREAM_HOST}:${UPSTREAM_PORT}`);
  });
  server.on('error', (e) => {
    process.stderr.write(`[calibra-codex] server error: ${e.message}\n`);
    process.exit(1);
  });
}

module.exports = { calibraRouteOpenAI, calibraHandleCommand, isFreshUserTurn, injectRoutingNote, injectCommandReply };
