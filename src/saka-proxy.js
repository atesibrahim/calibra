const http = require('http');
const https = require('https');
const fs   = require('fs');
const path = require('path');

// --- Calibra: zero-lag per-prompt model routing ---
const CALIBRA_BASE           = path.join(require('os').homedir(), '.claude-corp', 'calibra');
const CALIBRA_MODELS_PATH    = path.join(CALIBRA_BASE, 'calibra-models.json');
const CALIBRA_DISABLED_PATH  = path.join(CALIBRA_BASE, 'calibra-disabled');
const CALIBRA_TIERS = ['light', 'mid', 'deep', 'ultra'];

function requireCalibraMl(file) {
  const sourcePath = path.join(__dirname, 'ml', file);
  if (fs.existsSync(sourcePath)) return require(sourcePath);
  return require(path.join(CALIBRA_BASE, 'ml', file));
}

const {
  CALIBRA_DEEP_INTENT,
  CALIBRA_MID_INTENT,
  CALIBRA_SCOPE_HIGH,
  CALIBRA_DOMAIN_DEEP,
  CALIBRA_TRIVIAL,
  CALIBRA_GREETING,
  stripInjectedTags,
  extractPrompt,
  checkFastExits,
} = requireCalibraMl('classify-core.js');

let calibraConfigWarned = false;

function loadCalibraModels() {
  try {
    return JSON.parse(fs.readFileSync(CALIBRA_MODELS_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function calibraClassify(prompt) {
  const trimmed = (prompt || '').trim();

  // Signal probes — run once, used in fast-exit gate and scoring axes
  const hasDeepIntent = CALIBRA_DEEP_INTENT.test(trimmed);
  const hasMidIntent  = CALIBRA_MID_INTENT.test(trimmed);
  const hasScopeHigh  = CALIBRA_SCOPE_HIGH.test(trimmed);
  const hasDomain     = CALIBRA_DOMAIN_DEEP.test(trimmed);
  const hasCode       = /```/.test(trimmed);

  // Fast-exits (slash/empty, greeting, trivial, short-conversational)
  const fastExit = checkFastExits(trimmed, { hasDeepIntent, hasMidIntent, hasScopeHigh, hasDomain, hasCode });
  if (fastExit) return { ...fastExit, engine: 'heuristic' };

  const len = trimmed.length;

  // --- Scoring: five orthogonal axes, no word counted twice ---

  let s = 0;

  // Axis 1 — LENGTH: proxy for problem verbosity / detail
  if (len > 500) s += 3;

  else if (len > 200) s += 2;
  else if (len >= 80) s += 1;

  // Axis 2 — INTENT: what action is requested
  if (hasDeepIntent) s += 3;
  else if (hasMidIntent) s += 1;

  // Axis 3 — SCOPE: breadth/thoroughness modifier
  if (hasScopeHigh) s += 2;

  // Axis 4 — DOMAIN: technical complexity vocabulary
  if (hasDomain) s += 2;

  // Axis 5 — STRUCTURE: code blocks, step-by-step, multi-part
  const codeBlocks = trimmed.match(/```[\s\S]*?```/g) || [];
  const longBlock  = codeBlocks.some(b => b.split('\n').length > 52);
  if (codeBlocks.length > 1 || longBlock) s += 2;
  else if (codeBlocks.length === 1) s += 1;
  // step-by-step / walk-me-through style → +1 structure
  if (/\b(step.by.step|walk.?me.?through|break.?it.?down|multi.?part|adım\s+adım|aşama\s+aşama)\b/iu.test(trimmed)) s += 1;

  // --- Tier thresholds (max realistic ≈ 13) ---
  //
  //   light : s <= 2, no deep or mid intent     (no actionable signal)
  //   mid   : s <= 7, no deep intent            (concrete implementation tasks)
  //   deep  : s <= 7 with deep intent, or s<=7 with domain+scope  (design/analysis)
  //   ultra : s >= 8                            (long + deep + scope + domain together)
  //
  // Floor rules:
  //   hasDeepIntent → minimum deep (never mid, even if score is low)
  //   hasMidIntent  → minimum mid  (never light, even if score is 1)
  let tier;
  if (s <= 2 && !hasDeepIntent && !hasMidIntent)  tier = 'light';
  else if (s <= 7 && !hasDeepIntent)              tier = 'mid';
  else if (s <= 7)                                tier = 'deep';
  else                                            tier = 'ultra';

  return { tier, score: s, reason: 'score', engine: 'heuristic' };
}

async function calibraRoute(parsedBody) {
  if (process.env.CALIBRA_DISABLED === '1') return null;
  if (fs.existsSync(CALIBRA_DISABLED_PATH)) return null;

  const calibraModels = loadCalibraModels();
  if (!calibraModels) {
    if (!calibraConfigWarned) {
      process.stderr.write('[calibra] no calibra-models.json — routing disabled\n');
      calibraConfigWarned = true;
    }
    return null;
  }

  const prompt = extractPrompt(parsedBody.messages);

  // Engine selection — read flag per request (cheap fs read; flag may flip mid-session)
  let result;
  const engine = (() => {
    try {
      return requireCalibraMl('engine-flag.js').readEngine();
    } catch { return 'heuristic'; }
  })();

  if (engine === 'ml') {
    try {
      const { classifyML } = requireCalibraMl('calibra-ml.js');
      result = await classifyML(prompt);
    } catch (e) {
      // require failed (ml/ not installed) — fall back
      result = { ...calibraClassify(prompt), engine: 'heuristic', reason: 'ml-fallback:require-failed' };
    }
  } else {
    result = calibraClassify(prompt);
  }

  const { tier, score, reason } = result;
  const routed = calibraModels[tier];
  if (!routed) return null;

  // Normalize current model: strip variant suffixes like [1m], [2m]
  const currentModel = (parsedBody.model || '').replace(/\[[^\]]*\]$/, '');
  if (routed === currentModel) return null;

  // Write switch info to temp file for Stop hook to display
  const switchInfo = { currentModel, routed, tier, score, reason, engine: result.engine || engine, timestamp: Date.now() };
  const infoPath = path.join(require('os').tmpdir(), '.calibra-switch.json');
  try {
    fs.writeFileSync(infoPath, JSON.stringify(switchInfo));
  } catch (e) {
    process.stderr.write(`[calibra] failed to write switch info: ${e.message}\n`);
  }

  process.stderr.write(`[calibra] routing to ${routed} (engine: ${result.engine || engine})\n`);
  return routed;
}
// --- end Calibra ---

function resolveRemoteHost() {
  if (process.env.CALIBRA_REMOTE_HOST) return process.env.CALIBRA_REMOTE_HOST;
  try {
    const hostFile = require('path').join(require('os').homedir(), '.claude-corp', 'calibra', 'calibra-proxy-host');
    const h = require('fs').readFileSync(hostFile, 'utf8').trim();
    if (h) return h;
  } catch {}
  return '';
}
const REMOTE_HOST = resolveRemoteHost();
const MIN_MAX_TOKENS = 16384;
const MAX_BODY_SIZE = 10 * 1024 * 1024;
const UPSTREAM_TIMEOUT = 120000;
const STRIP_PARAMS = new Set(['output_config', 'top_k', 'anthropic_version']);
let _nonAnthropicModels;
function getNonAnthropicModels() {
  if (_nonAnthropicModels) return _nonAnthropicModels;
  try {
    const cfg = JSON.parse(fs.readFileSync(CALIBRA_MODELS_PATH, 'utf8'));
    _nonAnthropicModels = new Set(Array.isArray(cfg.nonAnthropicModels) ? cfg.nonAnthropicModels : []);
  } catch { _nonAnthropicModels = new Set(); }
  return _nonAnthropicModels;
}
const NON_ANTHROPIC_MODELS = { has: (m) => getNonAnthropicModels().has(m) };
const UPSTREAM_AGENT = new https.Agent({ keepAlive: true, maxSockets: 32 });

function cleanMessages(messages) {
  messages.forEach(msg => {
    msg.thinking_blocks = undefined;
    msg.signature = undefined;
    if (Array.isArray(msg.content)) {
      const kept = msg.content.filter(b => b.type !== 'thinking');
      msg.content = kept.length === 1 && typeof kept[0].text === 'string' ? kept[0].text : kept;
    }
  });
}

const HAIKU_UNSUPPORTED_TOP_LEVEL_KEYS = new Set([
  'effort',
  'effortLevel',
  'effort_level',
  'thinking',
  'betas',
  'budget_tokens',
  'reasoning',
  'reasoning_effort',
  'context_management',
  'output_config',
]);

function stripThinkingBlocks(messages) {
  if (!Array.isArray(messages)) return false;

  let modified = false;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message || typeof message !== 'object') continue;

    if ('thinking_blocks' in message) {
      delete message.thinking_blocks;
      modified = true;
    }
    if ('signature' in message) {
      delete message.signature;
      modified = true;
    }

    if (!Array.isArray(message.content)) continue;
    const kept = message.content.filter(block =>
      !block || (block.type !== 'thinking' && block.type !== 'redacted_thinking')
    );
    if (kept.length === message.content.length) continue;

    modified = true;
    if (kept.length === 0) {
      messages.splice(index, 1);
    } else {
      message.content = kept;
    }
  }

  return modified;
}

function sanitizeHaikuRequest(parsed) {
  let modified = false;

  for (const key of HAIKU_UNSUPPORTED_TOP_LEVEL_KEYS) {
    if (key in parsed) {
      delete parsed[key];
      modified = true;
    }
  }

  // Thinking blocks are signed, model-specific replay data. When Calibra routes
  // an existing conversation to Haiku, remove each whole block. Never delete
  // only block.thinking: that leaves an invalid { type: "thinking" } object.
  if (stripThinkingBlocks(parsed.messages)) modified = true;

  return modified;
}

const server = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    const headers = { ...req.headers, host: REMOTE_HOST };
    delete headers['connection'];
    const proxy = https.request({ hostname: REMOTE_HOST, port: 443, path: req.url, method: req.method, headers, agent: UPSTREAM_AGENT }, p => { res.writeHead(p.statusCode, p.headers); p.pipe(res); });
    proxy.on('error', () => { if (!res.headersSent) { res.writeHead(502); res.end(); } });
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

  req.on('end', async () => {
    if (size > MAX_BODY_SIZE) return;
    let body = Buffer.concat(chunks);

    try {
      const parsed = JSON.parse(body);
      let modified = false;

      // Calibra: score prompt and reroute to correct model tier
      const routedModel = await calibraRoute(parsed);
      if (routedModel) {
        parsed.model = routedModel;
        modified = true;
      }

      // Strip unsupported Haiku options without corrupting nested content blocks.
      if ((parsed.model || '').includes('haiku')) {
        if (sanitizeHaikuRequest(parsed)) modified = true;
      }

      const model = parsed.model || '';
      if (NON_ANTHROPIC_MODELS.has(model)) {
        if (parsed.max_tokens != null && parsed.max_tokens < MIN_MAX_TOKENS) parsed.max_tokens = MIN_MAX_TOKENS;
        for (const p of STRIP_PARAMS) if (p in parsed) parsed[p] = undefined;
        if (parsed.messages) cleanMessages(parsed.messages);
        modified = true;
      }

      if (modified) body = Buffer.from(JSON.stringify(parsed));
    } catch {}

    const headers = { ...req.headers, host: REMOTE_HOST, 'content-length': body.length };
    delete headers['connection'];

    // Strip effort/reasoning from URL query + headers when haiku
    let upstreamPath = req.url;
    try {
      const parsedAgain = JSON.parse(body);
      if ((parsedAgain.model || '').includes('haiku')) {
        const u = new URL(upstreamPath, 'http://x');
        ['effort', 'effortLevel', 'effort_level', 'reasoning', 'reasoning_effort', 'thinking'].forEach(k => u.searchParams.delete(k));
        upstreamPath = u.pathname + (u.search || '');
        for (const h of Object.keys(headers)) {
          if (/^x-.*(effort|reasoning|thinking)/i.test(h)) delete headers[h];
        }
      }
    } catch {}

    const proxy = https.request({
      hostname: REMOTE_HOST, port: 443, path: upstreamPath, method: 'POST', headers, timeout: UPSTREAM_TIMEOUT, agent: UPSTREAM_AGENT,
    }, proxyRes => { res.writeHead(proxyRes.statusCode, proxyRes.headers); proxyRes.pipe(res); });

    proxy.on('timeout', () => { proxy.destroy(); if (!res.headersSent) { res.writeHead(504); res.end(); } });
    proxy.on('error', () => { if (!res.headersSent) { res.writeHead(502); res.end(); } });
    proxy.write(body);
    proxy.end();
  });
});

server.keepAliveTimeout = 65000;

if (require.main === module) {
  server.listen(0, '127.0.0.1', () => {
    console.log('SAKA_PROXY_PORT=' + server.address().port);
    // Warmup ML session at startup if engine flag is set — eliminates cold-start on first request
    try {
      const { readEngine } = requireCalibraMl('engine-flag.js');
      if (readEngine() === 'ml') {
        const { warmup } = requireCalibraMl('calibra-ml.js');
        warmup();
      }
    } catch {}
  });
}

module.exports = {
  calibraClassify,
  sanitizeHaikuRequest,
  stripThinkingBlocks,
};
