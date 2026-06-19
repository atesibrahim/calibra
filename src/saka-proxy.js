const http = require('http');
const https = require('https');
const fs   = require('fs');
const path = require('path');

// --- Calibra: zero-lag per-prompt model routing ---
const CALIBRA_TIERS = ['light', 'mid', 'deep', 'ultra'];

const CALIBRA_KW_HIGH = /\b(architect|design|analyze|analyse|security|refactor|review|optimize|optimise|investigate|trade-?offs?|pros.and.cons|deep.dive|compare|test|verify|ensure|check|validate|confirm)\b/i;
const CALIBRA_KW_MID  = /\b(fix|debug|implement|write|add|create|build|update|migrate)\b/i;
const CALIBRA_MK_HIGH = /\b(trade-?offs?|pros.and.cons|deep.dive|compare|analyse|analyze|investigate)\b/i;
const CALIBRA_MK_MID  = /\b(step.by.step|step by step|multi.?part|walk.?me.?through|break.?it.?down)\b/i;
const CALIBRA_TRIVIAL = /\b(write\s+(a\s+)?unit\s+tests?|add\s+(a\s+)?(console\.log|print|log|comment)|rename\s+(var|variable|function|method|file)|format\s+(this|the)\s+(file|code)|fix\s+typo|update\s+(the\s+)?(comment|docstring|readme))/i;
// Greetings, acks, and ultra-short conversational prompts → light tier
const CALIBRA_GREETING = /^(hi+|hey+|hello+|yo|sup|howdy|good\s+(morning|afternoon|evening|night)|gm|gn|merhaba|selam|thanks?|thank\s+you|thx|ty|ok(ay)?|cool|great|nice|got\s+it|sounds?\s+good|perfect|awesome|yes+|no+|yep|nope|sure|alright|bye|goodbye|cya|see\s+ya)\b[\s!.?,]*$/i;
const CALIBRA_SHORT_CONVERSATIONAL = /^[\s\S]{0,40}$/;

const CALIBRA_MODELS_PATH    = path.join(require('os').homedir(), '.claude-corp', 'calibra-models.json');
const CALIBRA_DISABLED_PATH  = path.join(require('os').homedir(), '.claude-corp', 'calibra-disabled');
let calibraConfigWarned = false;

function loadCalibraModels() {
  try {
    return JSON.parse(fs.readFileSync(CALIBRA_MODELS_PATH, 'utf8'));
  } catch {
    return null;
  }
}

// Strip harness-injected tag blocks (system-reminders, command-*, local-command-*,
// hook output) so they don't pollute Calibra scoring with skill-catalog keywords.
function stripInjectedTags(text) {
  if (!text) return '';
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
    .replace(/<command-(name|message|args|stdout|stderr)>[\s\S]*?<\/command-\1>/gi, '')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/gi, '')
    .replace(/<local-command-stderr>[\s\S]*?<\/local-command-stderr>/gi, '')
    .replace(/<user-prompt-submit-hook>[\s\S]*?<\/user-prompt-submit-hook>/gi, '')
    .replace(/<bash-(stdout|stderr|input)>[\s\S]*?<\/bash-\1>/gi, '')
    .trim();
}

function extractPrompt(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'user') continue;
    if (typeof msg.content === 'string') return stripInjectedTags(msg.content);
    if (Array.isArray(msg.content)) {
      const joined = msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
      return stripInjectedTags(joined);
    }
  }
  return '';
}

function calibraClassify(prompt) {
  if (!prompt || prompt.trimStart().startsWith('/')) return { tier: 'mid', score: -1, reason: 'slash/empty' };
  const trimmed = prompt.trim();
  if (CALIBRA_GREETING.test(trimmed)) return { tier: 'light', score: 0, reason: 'greeting' };
  // Short conversational prompts without any high/mid signal → light
  if (CALIBRA_SHORT_CONVERSATIONAL.test(trimmed)
      && !CALIBRA_KW_HIGH.test(trimmed) && !CALIBRA_KW_MID.test(trimmed)
      && !CALIBRA_MK_HIGH.test(trimmed) && !CALIBRA_MK_MID.test(trimmed)
      && !/```/.test(trimmed)) {
    return { tier: 'light', score: 0, reason: 'short-conversational' };
  }
  if (CALIBRA_TRIVIAL.test(prompt)) return { tier: 'light', score: 0, reason: 'trivial-regex' };

  let s = 0;
  const len = prompt.length;
  if (len > 400) s += 2; else if (len >= 80) s += 1;
  if (CALIBRA_KW_HIGH.test(prompt)) s += 2; else if (CALIBRA_KW_MID.test(prompt)) s += 1;
  const codeBlocks = prompt.match(/```[\s\S]*?```/g) || [];
  const longBlock  = codeBlocks.some(b => b.split('\n').length > 52);
  if (codeBlocks.length > 1 || longBlock) s += 2; else if (codeBlocks.length === 1) s += 1;
  if (CALIBRA_MK_HIGH.test(prompt)) s += 2; else if (CALIBRA_MK_MID.test(prompt)) s += 1;

  let tier;
  if (s <= 2)      tier = 'light';
  else if (s <= 6) tier = 'mid';
  else if (s < 8)  tier = 'deep';
  else             tier = 'ultra';

  return { tier, score: s, reason: 'score' };
}

function calibraRoute(parsedBody) {
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
  const { tier, score, reason } = calibraClassify(prompt);
  const routed = calibraModels[tier];
  if (!routed) return null;

  // Normalize current model: strip variant suffixes like [1m], [2m]
  const currentModel = (parsedBody.model || '').replace(/\[[^\]]*\]$/, '');
  if (routed === currentModel) return null;

  // Write switch info to temp file for Stop hook to display
  const switchInfo = { currentModel, routed, tier, score, reason, timestamp: Date.now() };
  const infoPath = path.join(require('os').tmpdir(), '.calibra-switch.json');
  try {
    fs.writeFileSync(infoPath, JSON.stringify(switchInfo));
  } catch (e) {
    process.stderr.write(`[calibra] failed to write switch info: ${e.message}\n`);
  }

  process.stderr.write(`[calibra] routing to ${routed}\n`);
  return routed;
}
// --- end Calibra ---

const REMOTE_HOST = process.env.CALIBRA_REMOTE_HOST || '';
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

  req.on('end', () => {
    if (size > MAX_BODY_SIZE) return;
    let body = Buffer.concat(chunks);

    try {
      const parsed = JSON.parse(body);
      let modified = false;

      // Calibra: score prompt and reroute to correct model tier
      const routedModel = calibraRoute(parsed);
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
  server.listen(0, '127.0.0.1', () => { console.log('SAKA_PROXY_PORT=' + server.address().port); });
}

module.exports = {
  calibraClassify,
  sanitizeHaikuRequest,
  stripThinkingBlocks,
};
