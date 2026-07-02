'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Calibra classifier contract
//
// calibraClassify(prompt)  → { tier, score, reason, engine: 'heuristic' }
// classifyML(prompt)       → { tier, score, reason, engine: 'ml' }
//
//   tier:   'light' | 'mid' | 'deep' | 'ultra'
//   score:  number  (p ∈ [0,1] for ml; heuristic axis sum; -1 for fast-exits)
//   reason: string  ('score' | 'greeting' | 'trivial-regex' | 'short-conversational' |
//                    'slash/empty' | 'ml' | 'ml-fallback:<cause>')
//   engine: 'heuristic' | 'ml'
//
// Both functions MUST be total — on any internal failure return a valid result,
// never throw to the caller.
// ─────────────────────────────────────────────────────────────────────────────

// Axis 2a — DEEP_INTENT: synthesis, judgment, architecture, investigation verbs.
const CALIBRA_DEEP_INTENT = /\b(architect|architecture|design|analyse|analyze|analysis|refactor|audit|investigate|diagnose|review|security|optimize|optimise|harden\w*|trade-?offs?|pros.and.cons|deep.dive|compare|evaluate|assess|strategy|strategic|propose|plan|mimari\w*|mimarilendir|tasarla\w*|tasar[ıi]m\w*|analiz\w*|incele\w*|g[üu]venli\w*|kar[şs][ıi]la[şs]t[ıi]r\w*|derinlemesine|ara[şs]t[ıi]r\w*|do[ğg]rula\w*|denetle\w*|planla\w*|strateji\w*|[öo]ner\w*|de[ğg]erlendir\w*|y[öo]net\w*|g[öo]zden\s+ge[çc]ir\w*|moderniz\w*|d[öo]n[üu][şs][üu]m\w*)\b/iu;

// Axis 2b — MID_INTENT: concrete implementation/creation tasks.
const CALIBRA_MID_INTENT = /\b(implement|build|create|write|add|fix|debug|update|migrate|deploy|configure|setup|install|generate|parse|extract|convert|transform|integrate|explain|describe|summarize|summarise|outline|list|show|tell|d[üu]zelt\w*|hata\w*|ekle\w*|olu[şs]tur\w*|yaz|kur|ta[şs][ıi]|g[üu]ncelle\w*|uygula\w*|a[çc][ıi]kla\w*|anlat\w*|listele\w*|g[öo]ster\w*|[çc]evir\w*|entegre\w*|ge[çc]ir|[çc][öo]z\w*|de[ğg]i[şs]tir\w*|standardize|standartla[şs]t[ıi]r)\b/iu;

// Axis 3 — SCOPE: breadth/thoroughness signals.
const CALIBRA_SCOPE_HIGH = /\b(comprehensive|complete|entire|whole|full|end.to.end|e2e|all|every|thorough|exhaustive|detailed|in.depth|from.scratch|overall|holistic|across|spanning|(company|organi[sz]ation\w*|org|platform|system|enterprise|fleet|product|network|cluster|nation|state|industry|world|global)[-\s]?wide|multi[-\s](year|quarter|region|tenant|cloud)|kapsaml[ıi]|t[üu]m|b[üu]t[üu]n|detayl[ıi]|ba[şs]tan.sona|[çc]ap[ıi]nda|u[çc]tan.u[çc]a|genelinde|([şs]irket|org|kurum|organizasyon)\s+geneli)\b/iu;

// Axis 4 — DOMAIN: technical complexity vocabulary.
const CALIBRA_DOMAIN_DEEP = /\b(distributed|concurren\w+|race\s+condition|deadlock|consensus|raft|paxos|consistency|cap\s+theorem|schema.migration|backfill|scalab\w+|throughput|latency|algorithm\w*|complexity|big.?o|state.machine|event.sourcing|cqrs|protocol|cryptograph\w+|system\s+design|system\s+architecture|microservice\w*|monolith\w*|authentication|authorization|bottleneck|infrastructure|kubernetes|k8s|terraform|docker|graphql|grpc|webhook|observabilit\w*|reliabilit\w*|fault.toleran\w*|load.balanc\w*|service.mesh|api.gateway|event.driven|message.queue|pub.?sub|sla|slo|sli|rto|rpo|sharding|replication|partition\w*|circuit.breaker|rate.limit\w*|technical.debt|containeriz\w*|dağıtık|eşzamanl\w+|tutarlılık|ölçeklen\w+|şema\s+migrasyon|kilitlen\w+|yarış\s+koşul\w*)\b/iu;

// TRIVIAL: cheap one-liners — always → light.
const CALIBRA_TRIVIAL = /\b(write\s+(a\s+)?unit\s+tests?|add\s+(a\s+)?(console\.(log|warn|error|info|debug)|print|log|comment|note|todo)|rename\s+(var|variable|function|method|file)|format\s+(this|the)\s+(file|code)|fix\s+(a\s+|the\s+)?typo|correct\s+(the\s+)?(misspelled|spelling|typo)|fix\s+(the\s+)?broken\s+(markdown|link|formatting|bullet)|change\s+the\s+\w+\s+(number|value|text|string|label|color|colour)\s+(from|to)|update\s+(the\s+)?(comment|docstring|readme)|typo\s+d[üu]zelt|yorum\s+ekle|log\s+ekle|print\s+ekle|yeniden\s+adland[ıi]r|formatla|unit\s+test\s+yaz)\b/iu;

// GREETING: pure social prompts → always light.
const CALIBRA_GREETING = /^(hi+|hey+|hello+|yo|sup|howdy|good\s+(morning|afternoon|evening|night)|gm|gn|merhaba|selam|günaydın|iyi\s+(akşamlar|geceler|günler)|thanks?|thank\s+you|thx|ty|ok(ay)?|cool|great|nice|got\s+it|sounds?\s+good|perfect|awesome|yes+|no+|yep|nope|sure|alright|bye|goodbye|cya|see\s+ya|tamam|peki|olur|sağ\s*ol|sağol|teşekkür(ler)?|tşk|eyvallah|harika|süper|güzel|evet|hayır|yok|var)\b[\s!.?,]*$/iu;

// ─────────────────────────────────────────────────────────────────────────────
// Lexical features — hybrid signal for the ML classifier.
//
// The MiniLM embedding captures semantics but smears strong keyword signals
// (e.g. "console.log" → trivial, "audit security" → deep). These global-flag
// variants let us COUNT axis hits and feed them as features alongside the
// embedding, so the linear head can learn keyword→tier mappings the embedding
// alone misses. Source kept in sync with the single-match regexes above.
// ─────────────────────────────────────────────────────────────────────────────
const DEEP_INTENT_G  = new RegExp(CALIBRA_DEEP_INTENT.source, 'giu');
const MID_INTENT_G   = new RegExp(CALIBRA_MID_INTENT.source, 'giu');
const SCOPE_HIGH_G   = new RegExp(CALIBRA_SCOPE_HIGH.source, 'giu');
const DOMAIN_DEEP_G  = new RegExp(CALIBRA_DOMAIN_DEEP.source, 'giu');

function countMatches(re, s) {
  re.lastIndex = 0;
  const m = s.match(re);
  return m ? m.length : 0;
}

function scopeCount(s) {
  SCOPE_HIGH_G.lastIndex = 0;
  const m = (s || '').match(SCOPE_HIGH_G);
  return m ? m.length : 0;
}

// applyRoutingGuards — crisp lexical overrides applied on top of the ML tier.
// The ML head is strong on the mid/deep core but unreliable at the extremes
// (ultra is data-starved; short light prompts get over-routed). These guards
// encode signals that are near-deterministic in held-out data, so they correct
// the ML's systematic blind spots without disturbing its core judgment.
// Enumeration of ≥3 items: "a, b, and c" / "a, b ve c" / "a, b, c". A prompt
// that lists three or more subsystems is almost always a multi-system program.
const CALIBRA_ENUM_LIST = /(\b[\w-]+,\s+){2,}|\b[\w-]+,\s+[\w-]+\s+(and|ve|&)\s+\b/i;

function applyRoutingGuards(trimmed, tier) {
  if (tier === 'ultra') return tier;
  // Ultra ceiling A — breadth: ≥2 breadth/thoroughness words ("comprehensive …
  // across the whole …") occurs in ~72% of ultra prompts and ~0% of else.
  if (scopeCount(trimmed) >= 2) return 'ultra';
  // Ultra ceiling B — enumeration: a 3+ item list signals a multi-subsystem
  // program. Across three independent eval sets this fired on 0% of
  // light/mid/deep and 50–66% of the ultra prompts the head alone misses.
  if (CALIBRA_ENUM_LIST.test(trimmed)) return 'ultra';
  return tier;
}

// lexicalFeatures(prompt) → fixed-length number[] in ~[0,1].
// MUST stay a fixed length — it defines part of the feature vector shape.
function lexicalFeatures(prompt) {
  const t = (prompt || '').trim();
  const wc = t ? t.split(/\s+/).length : 0;

  const deepC  = countMatches(DEEP_INTENT_G, t);
  const midC   = countMatches(MID_INTENT_G, t);
  const scopeC = countMatches(SCOPE_HIGH_G, t);
  const domC   = countMatches(DOMAIN_DEEP_G, t);

  const greet  = CALIBRA_GREETING.test(t) ? 1 : 0;
  const triv   = CALIBRA_TRIVIAL.test(t) ? 1 : 0;
  const code   = /```/.test(t) ? 1 : 0;
  const quest  = /\?/.test(t) ? 1 : 0;
  const shortNoSig =
    (t.length <= 55 && !deepC && !midC && !scopeC && !domC && !code) ? 1 : 0;

  return [
    greet,                       // 0 — pure social → light
    triv,                        // 1 — known one-liner → light
    shortNoSig,                  // 2 — short, no actionable signal → light
    deepC > 0 ? 1 : 0,           // 3 — any deep-intent verb present
    Math.min(1, deepC / 2),      // 4 — deep-intent density
    midC > 0 ? 1 : 0,            // 5 — any mid-intent verb present
    Math.min(1, midC / 2),       // 6 — mid-intent density
    scopeC > 0 ? 1 : 0,          // 7 — any breadth word present
    Math.min(1, scopeC / 2),     // 8 — breadth density (→ ultra)
    domC > 0 ? 1 : 0,            // 9 — any technical-domain term
    Math.min(1, domC / 3),       // 10 — domain density
    code,                        // 11 — fenced code block
    quest,                       // 12 — question mark
    Math.min(1, wc / 60),        // 13 — word-count ramp
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule-first layer — deterministic bright-line rubric (plan §3).
//
// ruleClassify(prompt) → { tier, confident:true, reason:'rule:<n>' }   (decidable)
//                      | { confident:false }                            (→ ML)
//
// Pure, total, never throws. First match wins (decision order rules 1–7).
// This does NOT change the feature vector — no retrain required.
// ─────────────────────────────────────────────────────────────────────────────

// asciiFold — strip Turkish diacritics so typo-tolerant stem matching works on
// both diacritic and ascii spellings ("düzelt" / "duzelt").
function asciiFold(s) {
  return (s || '')
    .replace(/İ/g, 'i').replace(/I/g, 'i')
    .toLowerCase()
    .replace(/ı/g, 'i').replace(/ş/g, 's').replace(/ğ/g, 'g')
    .replace(/ü/g, 'u').replace(/ö/g, 'o').replace(/ç/g, 'c');
}

// boundedDamerauLevenshtein — edit distance with transposition, early-exit once
// the best possible distance exceeds `max`. Returns max+1 when over budget.
function boundedDL(a, b, max) {
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  if (!la) return lb; if (!lb) return la;
  const prevprev = new Array(lb + 1);
  const prev = new Array(lb + 1);
  const cur = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prevprev[j - 2] + 1);
      }
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    for (let j = 0; j <= lb; j++) { prevprev[j] = prev[j]; prev[j] = cur[j]; }
  }
  return prev[lb];
}

// Turkish action stems (ascii-folded). Used only when the diacritic-aware
// regexes above miss a transposition typo. Matched per-token with DL ≤ 1.
// NOTE: no 'optimiz'/'moderniz' — the English regex already covers
// optimize/modernize, and as typo stems they FP-match "optimistic" (DL=1).
const TYPO_DEEP_STEMS = [
  'tasarla', 'mimari', 'analiz', 'incele', 'arastir', 'degerlendir', 'denetle',
  'karsilastir', 'dogrula', 'planla', 'strateji', 'gozden',
];
const TYPO_MID_STEMS = [
  'duzelt', 'ekle', 'olustur', 'guncelle', 'uygula', 'acikla', 'anlat',
  'listele', 'goster', 'entegre', 'degistir', 'dockerize',
];

// matchTypoStem — true if any token (ascii-folded, length ≥5) is within DL ≤1 of
// a stem prefix. Conservative: only long tokens, distance 1, prefix-anchored.
function matchTypoStem(folded, stems) {
  const tokens = folded.split(/[^a-z0-9]+/).filter(t => t.length >= 5);
  for (const tok of tokens) {
    for (const stem of stems) {
      if (tok.startsWith(stem)) return true;            // exact prefix (agglutinated)
      const head = tok.slice(0, stem.length);
      if (head.length === stem.length && boundedDL(head, stem, 1) <= 1) return true;
    }
  }
  return false;
}

// Single-statement mechanical edits → light (rubric: no new logic). Curated
// whitelist of ATOMIC edits, distinct from feature work ("add pagination" = mid).
const CALIBRA_SINGLE_EDIT = /\b(add|insert|put|include|wrap|remove|delete|drop)\b[^.?!]{0,40}\b(import|return\s+(statement|false|true|null|undefined|0|this)|null\s+(check|guard)|guard\s+clause|early\s+return|type\s+(annotation|hint)|semicolon|trailing\s+comma|missing\s+(comma|paren\w*|bracket|brace)|closing\s+(paren\w*|bracket|brace)|break\s+statement|continue\s+statement|log\s+(line|statement)|console\.(log|warn|error|info|debug)|print\s+statement|comment|docstring|todo|fixme|new\s*line|blank\s+line|readonly\s+attribute|required\s+attribute|attribute|try.?catch(\s+block)?)\b|\b(wrap|add|insert)\b[^.?!]{0,40}\b(try.?catch|try\/catch)\b|\bimport\s+statement\b|\brename\s+(the\s+|a\s+|this\s+)?(var|variable|function|method|file|symbol|field|parameter|argument)\b/iu;

// Turkish parity for single mechanical edits (ascii-folded input). Atomic object
// + "ekle" (add), or a standalone format/rename/typo-fix verb. Same rubric: one
// statement, no new logic → light. Kept tight to avoid firing on feature work.
const CALIBRA_SINGLE_EDIT_TR = /\b(import\w*|null\s*kontrol\w*|noktali\s*virgul\w*|virgul\w*|parantez\w*|yeni\s*satir|satir\s*sonu\w*|todo|yorum\w*|log|print|console\.\w+|readonly|required|nitelik\w*|attribute|tip\s*belirt\w*|donus\s*deger\w*|return|try.?catch(\s*blogu)?)\b[^.?!]{0,30}\bekle\w*\b|\b(formatla|bicimlendir|girintile)\w*|\byeniden\s+(adlandir|isimlendir)\w*|\bgirintiyi?\s+duzelt\w*\b|\b(degisken\w*|fonksiyon\w*|dosya\w*|metod\w*|alan\w*)\b[^.?!]{0,30}\b(olarak\s+)?(degistir\w*|yeniden\s+(adlandir|isimlendir)\w*)\b|\b(typo|yazim\s*hatas\w*)\b[^.?!]{0,25}\bduzelt\w*|\bduzelt\w*\b[^.?!]{0,25}\b(typo|yazim)\b/iu;

// Recall / lookup → light (rubric §3 light: "what is X", "list the HTTP methods").
// Pure factual recall, no logic chosen. Anchored at the start so it only fires on
// genuine question/lookup leads, and gated downstream by length + no-deep-verb.
const CALIBRA_RECALL = /^\s*(list|show|name|give\s+(me\s+)?|tell\s+me|what(\s+is|\s+are|'s|\s+does)?|which|how\s+many|how\s+do\s+(i|you)|when\s+(do|to)|where\s+(is|do)|define|hangi|nelerdir)\b/iu;
// Turkish is verb-final: recall verbs ("listele", "söyle", "göster") and the
// question words land at the END. Matched on ascii-folded text, anchored to the
// tail, gated downstream by length + no-deep-verb to avoid swallowing mid work.
const CALIBRA_RECALL_TR = /\b(listele|soyle|nedir|nelerdir|hangisi|hangileri|kac\s+\w+)\b[\s.?!]*$/iu;

// Named subsystems — curated bounded-context lexicon (rule 4). Each entry is a
// distinct system; ≥2 DISTINCT entries ⇒ multi-system ⇒ ultra. Deliberately
// EXCLUDES generic nouns (service/module/users/table) to stay ~0% FP on
// single-component mid prompts. EN + ascii-folded TR keys.
const NAMED_SUBSYSTEMS = [
  ['auth',          /\b(auth|authentication|authorization|login|oauth|sso|kimlik\s*dogrulama|oturum\s*acma)\b/iu],
  ['payments',      /\b(payments?|odeme\w*|tahsilat)\b/iu],
  ['billing',       /\b(billing|invoic\w*|fatura\w*)\b/iu],
  ['checkout',      /\b(checkout|sepet|odeme\s*sayfasi)\b/iu],
  ['notifications', /\b(notifications?|bildirim\w*|messaging)\b/iu],
  ['orders',        /\b(orders?|siparis\w*)\b/iu],
  ['inventory',     /\b(inventory|envanter|stok\s*yonetimi)\b/iu],
  ['catalog',       /\b(catalog\w*|katalog\w*)\b/iu],
  ['analytics',     /\b(analytics|telemetry|analitik)\b/iu],
  ['shipping',      /\b(shipping|fulfillment|kargo\w*|teslimat)\b/iu],
  ['dashboard',     /\b(dashboard|gosterge\s*paneli)\b/iu],
  ['search',        /\b(search\s+(service|engine|index)|arama\s*(servisi|motoru))\b/iu],
  ['reporting',     /\b(reporting|raporlama)\b/iu],
  ['recommendation',/\b(recommendation\w*|oneri\s*motoru)\b/iu],
  ['pricing',       /\b(pricing|fiyatland\w*)\b/iu],
  ['wallet',        /\b(wallet|cuzdan)\b/iu],
  ['ledger',        /\b(ledger|muhasebe|defter)\b/iu],
  ['gateway',       /\b(api\s*gateway|gateway)\b/iu],
  ['scheduler',     /\b(scheduler|zamanlay\w*|cron\s*service)\b/iu],
  ['ingestion',     /\b(ingestion|veri\s*alma|etl\s*pipeline)\b/iu],
  ['onboarding',    /\b(onboarding|kyc|uye\s*kabul)\b/iu],
  ['fraud',         /\b(fraud\s*(detection|service)?|doland\w*|sahtekarlik)\b/iu],
  ['account',       /\b(account\b|accounts\b|account\s*service|hesap\s*servis\w*|musteri\s*hesab\w*)\b/iu],
  ['crm',           /\bcrm\b/iu],
];

// Multi-region / cross-datacenter work is multi-system by definition → ultra
// (rubric §3). Tight phrase list (ascii-folded), distinct from single-region work.
const CALIBRA_MULTI_REGION = /\b(cross.?region\w*|multi.?region\w*|cross.?datacenter\w*|two\s+regions?|both\s+regions?|across\s+regions?|iki\s+bolge\w*|cok\s+bolge\w*|birden\s+fazla\s+bolge\w*|avrupa\s+ve\s+asya|regional\s+data\s*center\w*|bolgesel\s+veri\s*merkez\w*|datacenter\w*\s+(and|ve)\s+\w*\s*datacenter\w*)/iu;

// Program / multi-system DEFER signal. When present, the rule layer does NOT
// commit to deep/mid (rules 5/6) — it hands off to the ML head, which is strong
// on ultra. Measured fire-rate: ultra 12–53%, deep ≤2%, light/mid 0% across all
// eval sets ⇒ high-precision "this is broad/ambiguous, let ML judge" detector.
// Tested on ascii-folded text (Turkish-safe).
const CALIBRA_MULTISYS_DEFER = /(\b[a-z0-9]{3,}\s+(and|ve|&|plus|ile)\s+[a-z0-9]{3,}\s+(service|servis|databas|veritaban|modul|module|system|sistem|interface|arayuz|pipeline|hat|layer|katman|stack|component|servisler|gecis)\w*)|multi.?(quarter|region|year|tenant|cloud)|cok.?(bolge|bolgeli|ceyrek)|zero.?downtime|kesintisiz|dual.?write|roll.?out|rollout|asamali\s+gec|olculebilir\s+kap|koordine\s+et|standartlas|yonetisim|governance|company.?wide|platform.?wide|shared\s+data\s+layer|ortak\s+(data|veri|yonetisim)|modernize\s+et|yeniden\s+(tasarla|kur)|gecis\s+ve|migrat\w*\s+\w+\s+(and|to)\b/u;

function distinctNamedSubsystems(s) {
  const hits = new Set();
  for (const [key, re] of NAMED_SUBSYSTEMS) {
    re.lastIndex = 0;
    if (re.test(s)) hits.add(key);
    if (hits.size >= 2) break;
  }
  return hits.size;
}

// multiNamedSubsystem — ≥2 DISTINCT named subsystems separated by a coordinator
// (and / ve / , / & / + / plus / ile). The coordinator requirement avoids the
// compound-noun FP ("analytics dashboard", "payments gateway" = ONE system),
// keeping the rule scoped to genuine multi-system work ("auth and payments").
const COORDINATOR = /[,&+]|\b(and|ve|plus|ile|veya|or)\b/iu;
function multiNamedSubsystem(s) {
  const spans = [];
  for (const [key, re] of NAMED_SUBSYSTEMS) {
    const g = new RegExp(re.source, 'giu');
    let m;
    while ((m = g.exec(s)) !== null) {
      spans.push({ key, start: m.index, end: m.index + m[0].length });
      if (m.index === g.lastIndex) g.lastIndex++;
    }
  }
  if (spans.length < 2) return false;
  spans.sort((a, b) => a.start - b.start);
  // need two distinct keys with a coordinator in the gap between them
  for (let i = 0; i < spans.length; i++) {
    for (let j = i + 1; j < spans.length; j++) {
      if (spans[i].key === spans[j].key) continue;
      const gap = s.slice(spans[i].end, spans[j].start);
      if (COORDINATOR.test(gap)) return true;
    }
  }
  return false;
}

// ruleClassify — the deterministic cascade. Returns a confident tier for
// rule-decidable prompts, else { confident:false } to defer to the ML head.
function ruleClassify(prompt) {
  try {
    const trimmed = (prompt || '').trim();

    // Rule 1 — empty / slash command → mid (tool invocation, not NL).
    if (!trimmed || trimmed.startsWith('/')) {
      return { tier: 'mid', confident: true, reason: 'rule:1' };
    }

    // Rule 2 — pure social/greeting → light.
    if (CALIBRA_GREETING.test(trimmed)) {
      return { tier: 'light', confident: true, reason: 'rule:2' };
    }

    const folded = asciiFold(trimmed);

    // Rule 3 — trivial one-liner / single-statement mechanical edit → light
    // (English + Turkish parity).
    if (CALIBRA_TRIVIAL.test(trimmed) || CALIBRA_SINGLE_EDIT.test(trimmed) ||
        CALIBRA_SINGLE_EDIT_TR.test(folded)) {
      return { tier: 'light', confident: true, reason: 'rule:3' };
    }

    // Rule 4 — scope → ultra: ≥2 breadth words OR 3+ enumeration (checked on
    // ascii-folded text too, so Turkish "satıcı, alıcı ve operasyon" counts) OR
    // ≥2 distinct named subsystems. (named-subsystem rule = the new lever.)
    // Runs before recall so "list every service across the platform" → ultra.
    // multiNamedSubsystem runs on `folded`: the lexicon keys are ascii-folded, so
    // matching raw text would miss Turkish diacritic systems ("ödeme"/"sipariş").
    // asciiFold is length-preserving (1:1 char swaps) so match offsets stay valid.
    if (scopeCount(trimmed) >= 2 ||
        CALIBRA_ENUM_LIST.test(trimmed) || CALIBRA_ENUM_LIST.test(folded) ||
        multiNamedSubsystem(folded) || CALIBRA_MULTI_REGION.test(folded)) {
      return { tier: 'ultra', confident: true, reason: 'rule:4' };
    }

    // Rule 3b — pure recall/lookup → light (rubric §3: "what is X", "list the
    // HTTP methods"). Gated to SHORT prompts with no deep verb and no code; rule 4
    // already removed any scoped/multi-system recall above.
    if (trimmed.length <= 80 &&
        (CALIBRA_RECALL.test(trimmed) || CALIBRA_RECALL_TR.test(folded)) &&
        !CALIBRA_DEEP_INTENT.test(trimmed) && !/```/.test(trimmed)) {
      return { tier: 'light', confident: true, reason: 'rule:3b' };
    }

    // Rules 5–7 (intent-verb → deep/mid, short → light) are DEFERRED to the ML
    // head. A head-to-head on every eval set showed the ML matches or beats the
    // rule on these zones (rule 78–87% vs ML 86–95% on the light↔mid↔deep
    // boundary), because an intent verb alone does NOT pin the tier — that is the
    // genuinely-ambiguous residual the ML must own (plan §1.2, §4). Only the
    // proven-decidable rules 1–4 commit (each ≥ ML precision on every set).
    //
    // `folded`, the typo-stem matchers, and CALIBRA_MULTISYS_DEFER remain exported
    // and unit-tested; they are retained as the rubric's intent signals and for
    // potential future high-precision sub-rules, but are not used to COMMIT here.
    void folded;
    return { confident: false };
  } catch {
    return { confident: false };
  }
}

// Strip harness-injected tag blocks so they don't pollute scoring.
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

// checkFastExits — run before scoring axes.
// Returns {tier, score, reason} if a fast-exit fires, or null to proceed to scoring.
// Accepts pre-computed signal flags to avoid re-running expensive regexes.
function checkFastExits(trimmed, { hasDeepIntent, hasMidIntent, hasScopeHigh, hasDomain, hasCode } = {}) {
  // Slash command or empty → mid (tool invocation, not natural language)
  if (!trimmed || trimmed.startsWith('/')) return { tier: 'mid', score: -1, reason: 'slash/empty' };

  // Pure social prompt → light
  if (CALIBRA_GREETING.test(trimmed)) return { tier: 'light', score: 0, reason: 'greeting' };

  // Known trivial one-liner → light
  if (CALIBRA_TRIVIAL.test(trimmed)) return { tier: 'light', score: 0, reason: 'trivial-regex' };

  // Short-conversational gate: ≤55 chars, no actionable signal → light
  if (trimmed.length <= 55 && !hasDeepIntent && !hasMidIntent && !hasScopeHigh && !hasDomain && !hasCode) {
    return { tier: 'light', score: 0, reason: 'short-conversational' };
  }

  return null; // proceed to full scoring
}

module.exports = {
  CALIBRA_DEEP_INTENT,
  CALIBRA_MID_INTENT,
  CALIBRA_SCOPE_HIGH,
  CALIBRA_DOMAIN_DEEP,
  CALIBRA_TRIVIAL,
  CALIBRA_GREETING,
  lexicalFeatures,
  scopeCount,
  applyRoutingGuards,
  stripInjectedTags,
  extractPrompt,
  checkFastExits,
  ruleClassify,
  asciiFold,
  boundedDL,
  distinctNamedSubsystems,
  multiNamedSubsystem,
  CALIBRA_SINGLE_EDIT,
  CALIBRA_SINGLE_EDIT_TR,
  CALIBRA_RECALL,
  CALIBRA_RECALL_TR,
  NAMED_SUBSYSTEMS,
  CALIBRA_MULTISYS_DEFER,
};
