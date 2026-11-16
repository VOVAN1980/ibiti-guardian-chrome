// Keeps Guardian's own AI honest.
//
// An answer is checked before the user sees it, one sentence at a time: a
// sentence appears only after it passed. What is checked (and only this is
// claimed in the window):
//   - every address in it is an address of this request;
//   - every amount is an amount of this request, with its own token
//     ("0.01 ETH" passes only where the request moves 0.01 ETH);
//   - every other number, percentage and token name is in the facts;
//   - it does not say "unlimited" or "everything" where the facts do not;
//   - it does not swap who gets what;
//   - it never says or implies that confirming is safe, harmless or normal.
//     Guardian itself never says "safe", only "no red flags found".
// The answer stops at the first sentence that fails. If nothing passed, the
// window shows a sentence written by code instead.
//
// Requests the analyzer could not decode are not explained by AI at all:
// with no facts, a model could only guess.
//
// These checks are deliberately narrow: they catch the mistakes code can
// verify. They cannot prove that an explanation is right.

import { CHAINS } from '../analyzer/registry.js';

// Requests the analyzer could not decode.
export const UNDECODED = new Set(['contractCall', 'typedData', 'unknown', 'blindSign', 'deploy']);

export const isUndecoded = (result) =>
  UNDECODED.has(result.kind) || (result.kind === 'message' && result.subject && result.subject.readable === false);

// ── Tokens ──────────────────────────────────────────────────────────────────

// Tickers a model might name; a mention must be in the request's facts.
const TICKERS = [
  'ETH', 'WETH', 'BTC', 'WBTC', 'BNB', 'WBNB', 'tBNB', 'POL', 'MATIC', 'SOL', 'TRX', 'ARB', 'OP', 'AVAX',
  'USDT', 'USDC', 'USDE', 'DAI', 'BUSD', 'TUSD', 'FDUSD', 'PYUSD', 'LINK', 'UNI', 'AAVE', 'SHIB', 'PEPE',
  'DOGE', 'TON', 'XRP', 'ADA', 'DOT', 'LTC', 'APE', 'LDO', 'MKR', 'CRV',
];
// Written in capitals these are tickers; in small letters only the ones
// that are not also English words.
const TICKER = new RegExp(`\\b(${TICKERS.join('|')})\\b`, 'g');
const TICKER_ANYCASE = /\b(eth|weth|btc|wbtc|bnb|usdt|usdc|busd|matic|shib|pepe|doge|xrp)\b/gi;
const STABLES = ['USDT', 'USDC', 'DAI', 'BUSD', 'TUSD', 'FDUSD', 'PYUSD', 'USDE'];
// Names that stand for a ticker.
const TOKEN_NAMES = [
  [/\btether\b/gi, ['USDT']],
  [/\busd coin\b/gi, ['USDC']],
  [/\b(?:wrapped )?ether\b/gi, ['ETH', 'WETH']],
  [/\bbitcoins?\b/gi, ['BTC', 'WBTC']],
];

// ── Numbers ─────────────────────────────────────────────────────────────────

const NUMBER = String.raw`\d[\d,]*(?:\.\d+)?`;
const NUMBER_WORD =
  'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|trillion|dozen|half';
const SCALE = 'k|m|bn|thousand|million|billion|trillion';
const UNIT = `${TICKERS.join('|')}|dollars?|bucks|usd|euros?|pounds|yen|tether|ether|bitcoins?`;

// "500 USDT", "1,000.5 ETH", "5k USDT", "2 million USDC", "500 dollars".
const AMOUNT = new RegExp(String.raw`(?<![\w.,])(${NUMBER})\s*(${SCALE})?\s*-?\s*(${UNIT})\b`, 'gi');
// "$1,000", "€500".
const MONEY = new RegExp(String.raw`([$€£¥₿])\s?(${NUMBER})`, 'g');
// "five hundred USDT", "half of your ETH", "a million dollars".
const WORD_AMOUNT = new RegExp(
  String.raw`\b(?:(?:a|an)\s+)?((?:${NUMBER_WORD})(?:[\s-]+(?:and\s+)?(?:${NUMBER_WORD}))*)\s+(?:(?:of\s+)?(?:your|the|their|all)\s+)?(${UNIT}|tokens?|coins?|funds|balance)\b`,
  'gi',
);
const PERCENT = new RegExp(String.raw`(?<![\w.,])(${NUMBER})\s*(?:%|percent\b)`, 'gi');
const ANY_NUMBER = new RegExp(String.raw`(?<![\w.,])${NUMBER}(?![\w])`, 'g');
// Names with digits that are not numbers about this request.
// So are "the first and last 4 characters" of an address and a list number.
const NOT_NUMBERS =
  /\b(?:ERC|EIP|BEP)-?\d+\b|\bPermit2\b|\bWeb3\b|\b24\/7\b|\b2FA\b|\b(?:first|last)\s+\d{1,2}\b|\b\d{1,2}\s+(?:characters|chars|digits|letters)\b|^\s*\d{1,2}[.)]\s+/gi;
const ROUGHLY = /(?:\b(?:about|around|roughly|approximately|nearly|almost|close to|just over|just under)|~)\s*$/i;

const WORD_VALUE = {
  one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
  eleven: '11', twelve: '12', twenty: '20', thirty: '30', forty: '40', fifty: '50', sixty: '60', seventy: '70',
  eighty: '80', ninety: '90', hundred: '100', thousand: '1000', million: '1000000', billion: '1000000000', dozen: '12',
};

/** "1,000" → "1000", "25.000" → "25", "01" → "1". */
function norm(raw) {
  let n = String(raw).replace(/,/g, '');
  if (n.includes('.')) n = n.replace(/0+$/, '').replace(/\.$/, '');
  n = n.replace(/^0+(?=\d)/, '');
  return n;
}

const HEX = /0x[0-9a-fA-F]+/gi;
// 0x9f3a…c21e, 0x9f3a...c21e, 0x9f3a-c21e, 0x 9f3a, or the whole address.
const ADDRESS = /0x\s?([0-9a-f]{2,})(?:\s*(?:…|⋯|\.{2,}|[-–—*]{1,3})\s*([0-9a-f]{4,})(?![0-9a-z]))?/gi;

/** Which tickers a unit word stands for; null = no token of ours at all. */
function unitTickers(unit) {
  const u = unit.toLowerCase();
  if (/^(dollars?|bucks|usd)$/.test(u)) return STABLES;
  if (/^(euros?|pounds|yen)$/.test(u)) return null;
  if (u === 'tether') return ['USDT'];
  if (u === 'ether') return ['ETH', 'WETH'];
  if (/^bitcoins?$/.test(u)) return ['BTC', 'WBTC'];
  return [unit.toUpperCase()];
}

// ── What the request really says ────────────────────────────────────────────

/**
 * Everything an answer may refer to, taken from the analyzer's result.
 * `own`: the user's own addresses; `chainId`: the network of the request.
 */
export function groundTruth(result, extra = '', { own = [], chainId = null } = {}) {
  const text = [
    result.headline,
    ...result.facts.map((f) => `${f.label}: ${f.value} ${f.note || ''}`),
    ...result.reasons,
    extra,
  ].join('\n');
  // Addresses as the facts show them, and in full from the decoded request
  // (a well-known spender is shown shortened: "Uniswap Permit2 · 0x0000…8ba3").
  const decoded = JSON.stringify([result.subject || {}, (result.parts || []).map((p) => p.subject || {})]);
  const hexes = [...`${text}\n${decoded}`.matchAll(HEX)].map((m) => m[0].toLowerCase());
  // Digits inside an address are not numbers of this request.
  const plain = text.replace(HEX, ' ');

  const pairs = new Set();
  for (const m of plain.matchAll(AMOUNT)) {
    if (!m[2]) pairs.add(`${norm(m[1])} ${m[3].toUpperCase()}`);
  }
  const numbers = new Set([...plain.matchAll(ANY_NUMBER)].map((m) => norm(m[0])));
  if (/\ba year\b/i.test(plain)) numbers.add('1');
  const percents = new Set([...plain.matchAll(PERCENT)].map((m) => norm(m[1])));
  const tickers = new Set([...plain.matchAll(TICKER)].map((m) => m[1].toUpperCase()));
  // The network's own coin may be named (gas is paid in it).
  const chain = CHAINS[chainId];
  if (chain) tickers.add(chain.native.toUpperCase());
  for (const c of Object.values(CHAINS)) {
    if (plain.includes(c.name)) tickers.add(c.native.toUpperCase());
  }
  if (!chain && tickers.size === 0) tickers.add('ETH');

  const unlimited = /unlimited|any amount|all of your|all your|every item|:\s*all\b|anything|any transaction/i.test(plain);
  const to = String((result.subject && result.subject.to) || '').toLowerCase();
  const toSelf = to !== '' && own.map((a) => a.toLowerCase()).includes(to);
  return { lower: plain.toLowerCase(), hexes, pairs, numbers, percents, tickers, unlimited, toSelf };
}

// ── Saying it is safe ───────────────────────────────────────────────────────

// Each clause (split at , ; : and dashes) is judged by itself, so "Check the
// address; this is safe" cannot hide the claim behind the advice.
// "It is safe", "looks legit", "safe to sign": never acceptable.
const SAFE_CLAIM =
  /\b(?:(?:is|are|looks?|seems?|appears?|be|sounds?|remains?|stays?|it's|that's|this's)\s+(?:\w+\s+){0,2}?(?:safe|secure|harmless|legitimate|legit|trustworthy|trusted|genuine|risk[- ]free|fine|okay|ok|alright|benign|verified)\b|safe to\b|safely\b|perfectly\s+(?:normal|fine|safe|ok|okay)\b)/i;
// "It is a standard approval": fine for an ordinary request, not for one
// Guardian flags. "A common drainer trick" is a warning, not a claim.
const ORDINARY_CLAIM =
  /\b(?:is|looks like|seems like|appears to be|just|simply|only)\s+(?:a|an)\s+(?:common|standard|normal|ordinary|routine|typical|legitimate|regular|everyday|usual|simple|harmless)\b(?!,?\s+(?:\w+\s+)?(?:scam|drainer|trick|attack|fraud|phishing|theft|lure|tactic|scheme|ploy|trap|bait|red flag|sign of)s?\b)/i;
// "This is a standard approval, but the spender …": the clause is conceded.
const CONTRAST =
  /\b(?:is|looks like|seems like|appears to be)\s+(?:a|an)\s+(?:common|standard|normal|ordinary|routine|typical|regular|usual)\b[^.;]*?,?\s*(?:but|however|yet)\b/gi;
const NEGATED = /\b(?:not|never|no|cannot|can't|can not|isn't|aren't|won't|don't|doesn't|unable|nor|hardly|neither)\b|n't\b/i;
// "Verify that the spender is a legitimate service", "only continue if you
// are sure it is legitimate": advice to check, not a claim. A plain "if" is
// not enough: "If you confirm, it is safe" is a claim.
const ADVICE =
  /\b(?:verify|check|make sure|ensure|whether|unless|ask|find out|look up|research|only when|only if|confirm (?:that|whether)|if you (?:are sure|trust|know|believe|have checked|verified|recogni[sz]e))\b/i;

/** The text from the start of the clause holding position `at`. */
const clauseBefore = (text, at) => text.slice(0, at).split(/[,;:()]|\s[-–—]\s|[.!?]\s/).pop();
// "To be safe, check the address" is advice; "the token is verified" repeats a fact.
const SAFE_IDIOM = /\bto\s+(?:be|stay|remain|keep|play it)\s+(?:\w+\s+)?safe\b|\bon the safe side\b|\bverified (?:contract|token)\b|\b(?:contract|token) is verified\b/gi;
// "Although it looks like a normal approval, …": the clause concedes, it does not claim.
const CONCEDES = /^\s*(?:although|though|while|even though|even if|despite|whereas)\b/i;

// Saying nothing bad can happen, in other words.
const DENIES_HARM = [
  /\b(?:cannot|can't|can not|won't|will not|will never|would not|wouldn't|does not|doesn't|do not|don't|is not able to|isn't able to|unable to|never|not going to)\s+(?:\w+\s+){0,2}?(?:harm|hurt|damage|endanger|steal|drain|compromise|affect|touch|move|take|spend|access|cost|lose|risk|put)\s+(?:\w+\s+){0,3}?(?:funds?|money|wallet|tokens?|assets?|coins?|balance|nfts?|items?|account|anything|you\b|at risk)/i,
  /\bno\s+(?:\w+\s+)?(?:harm|danger|risk|threat|problem|downside|cost)s?\b/i,
  /\b(?:not|isn't|is not|aren't|are not|nothing)\s+(?:\w+\s+)?(?:dangerous|risky|harmful|a scam|a threat|malicious|a problem|suspicious|to fear)\b/i,
  /\bwithout\s+(?:any\s+)?(?:risk|danger)\b/i,
  /\b(?:low|little|minimal|zero)[- ]risk\b/i,
  /\bnothing\s+(?:\w+\s+){0,2}?(?:bad|to worry|will happen|can go wrong|leaves|happens|changes|is sent|is taken|is moved|is lost|will be lost|to lose)\b/i,
  /\b(?:no need to worry|don't worry|do not worry|not to worry|rest assured|feel free|go ahead|should be (?:fine|okay|ok|safe))\b/i,
  /\byou\s+(?:can|may|could|should)\s+(?:\w+\s+)?(?:sign|confirm|approve|continue|proceed|accept|go ahead|trust)\b/i,
  /\b(?:fine|okay|ok|alright)\s+to\s+(?:sign|confirm|approve|continue|proceed|accept)\b/i,
  /\b(?:this is|that is|it is|it's|that's)\s+how\s+(?:most|all|many|every)\b/i,
  /\b(?:as expected|expected behaviou?r|as usual|nothing unusual|nothing out of the ordinary)\b/i,
  /\bthat\s+(?:most|all|many)\s+(?:apps|dapps|sites|wallets|people|users)\s+(?:use|do|need|require)\b/i,
];

/**
 * Whether a sentence says the request is safe. `strict` also catches the
 * softer "nothing can happen" forms; it is off only where the code itself
 * says such things about a decoded, ordinary request ("Nothing leaves your
 * wallet").
 */
function callsItSafe(sentence, strict) {
  const text = sentence.replace(SAFE_IDIOM, ' ').replace(CONTRAST, ' but');
  for (const clause of text.split(/[,;:()]|\s[-–—]\s|\s+but\s+|\s+and\s+(?=(?:it|this|that|the|you|nothing|there)\b)/i)) {
    for (const pattern of strict ? [SAFE_CLAIM, ORDINARY_CLAIM] : [SAFE_CLAIM]) {
      const safe = pattern.exec(clause);
      if (!safe) continue;
      const before = clause.slice(0, safe.index);
      const negated = NEGATED.test(before) || NEGATED.test(safe[0]);
      if (!negated && !ADVICE.test(before) && !CONCEDES.test(clause)) return safe[0].trim();
    }
    if (!strict) continue;
    for (const pattern of DENIES_HARM) {
      const m = pattern.exec(clause);
      if (m && !ADVICE.test(clause.slice(0, m.index))) return m[0].trim();
    }
  }
  return null;
}

// ── Who gets what ───────────────────────────────────────────────────────────

const PERMISSION_KINDS = new Set(['approve', 'approveAll', 'permit', 'permit2', 'order']);
const TRANSFER_KINDS = new Set(['transfer', 'nativeTransfer']);
const YOU = String.raw`(?:you|your wallet|your account)`;
const YOU_GET_PERMISSION = [
  new RegExp(
    String.raw`\b${YOU}(?:'ll|'d)?\s+(?:(?:will|would|can|could|may|are|is|get to)\s+)?(?:\w+\s+){0,2}?(?:get|gets|receive|receives|gain|gains|obtain|obtains|granted|given|allowed|able|authorized|authorised|permitted|have|has)\s+(?:\w+\s+){0,3}?(?:permission|access|rights?|approval|allowance|to spend|to take|to move|to use|to transfer|to withdraw)\b`,
    'i',
  ),
  new RegExp(String.raw`\b${YOU}\s+(?:can|could|may|will be able to)\s+(?:then\s+|now\s+)?(?:spend|take|move|withdraw|transfer|use)\b`, 'i'),
];
const YOU_GET_FUNDS = [
  /\byou(?:'ll|'d)?\s+(?:(?:will|would|can|could|also)\s+)?(?:receive|get|earn|gain|collect|claim|win)\b(?!\s+(?:nothing|no\b|asked|a\s+warning|it\s+back|them\s+back|your\s+\w+\s+back|what|permission|access))/i,
  /\b(?:sent|goes|go|moved|transferred|deposited|added|paid|credited|returned|comes?|arrives?)\s+(?:\w+\s+){0,3}?(?:into|to)\s+your\s+(?:own\s+)?(?:wallet|account)\b/i,
  /\b(?:sent|paid|transferred|credited|given)\s+to\s+you\b|\bcomes?\s+to\s+you\b|\bwill be yours\b/i,
];

/** The first match that nothing in its own clause turns around. */
function claims(patterns, text) {
  for (const pattern of patterns) {
    const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    for (const m of text.matchAll(re)) {
      const before = clauseBefore(text, m.index);
      if (NEGATED.test(before) || NEGATED.test(m[0]) || ADVICE.test(before)) continue;
      return m[0];
    }
  }
  return null;
}

// ── The check ───────────────────────────────────────────────────────────────

const fail = (reason, detail) => ({ reason, detail: String(detail).trim().slice(0, 60) });

/**
 * Checks one sentence of an answer. Returns null when it passes. Otherwise
 * `reason` is what the window may show (never the model's own words) and
 * `detail` is the offending piece, for tests and logs.
 */
export function checkText(text, result, truth = groundTruth(result)) {
  if (!text || !text.trim()) return null;

  for (const m of text.matchAll(ADDRESS)) {
    const head = `0x${m[1].toLowerCase()}`;
    const tail = m[2] ? m[2].toLowerCase() : '';
    const known = truth.hexes.some((h) => h.startsWith(head) && (!tail || h.endsWith(tail)));
    if (!known) return fail('an address that is not in this request', m[0]);
  }
  for (const m of text.matchAll(/\b[a-z0-9-]{2,}\.eth\b/gi)) {
    if (!truth.lower.includes(m[0].toLowerCase())) return fail('a name that is not in this request', m[0]);
  }

  let plain = text.replace(HEX, ' ').replace(NOT_NUMBERS, ' ');

  // Amounts, each with its own token.
  const NOT_AN_AMOUNT = 'an amount that is not in this request';
  for (const m of plain.matchAll(AMOUNT)) {
    const tickers = unitTickers(m[3]);
    const n = norm(m[1]);
    let ok = !m[2] && tickers && tickers.some((t) => truth.pairs.has(`${n} ${t}`));
    if (!ok && !m[2] && tickers && ROUGHLY.test(plain.slice(Math.max(0, m.index - 20), m.index))) {
      // "about 0.0077 ETH" for 0.007716 ETH.
      ok = [...truth.pairs].some((pair) => {
        const [value, ticker] = pair.split(' ');
        return tickers.includes(ticker) && Number(value) > 0 && Math.abs(Number(n) - Number(value)) / Number(value) <= 0.05;
      });
    }
    if (!ok) return fail(NOT_AN_AMOUNT, m[0]);
  }
  for (const m of plain.matchAll(MONEY)) {
    const ok = m[1] === '$' && STABLES.some((t) => truth.pairs.has(`${norm(m[2])} ${t}`));
    if (!ok) return fail(NOT_AN_AMOUNT, m[0]);
  }
  for (const m of plain.matchAll(WORD_AMOUNT)) {
    const words = m[1].toLowerCase().split(/[\s-]+/).filter((w) => w !== 'and');
    if (words.length === 1 && words[0] === 'one' && /\bof\b/i.test(m[0])) continue; // "one of the tokens"
    const tickers = /^(tokens?|coins?|funds|balance)$/i.test(m[2]) ? [...truth.tickers] : unitTickers(m[2]);
    const value = words.length === 1 ? WORD_VALUE[words[0]] : null;
    const ok = value && tickers && tickers.some((t) => truth.pairs.has(`${value} ${t}`));
    if (!ok && !truth.lower.includes(m[0].toLowerCase())) return fail(NOT_AN_AMOUNT, m[0]);
  }
  for (const m of plain.matchAll(PERCENT)) {
    const n = norm(m[1]);
    if (!truth.percents.has(n) && !(n === '100' && truth.unlimited)) {
      return fail('a share of your balance that is not in this request', m[0]);
    }
  }
  // Every other number must be one the request contains.
  plain = plain.replace(AMOUNT, ' ').replace(MONEY, ' ').replace(PERCENT, ' ');
  for (const m of plain.matchAll(ANY_NUMBER)) {
    if (!truth.numbers.has(norm(m[0]))) return fail('a number that is not in this request', m[0]);
  }

  // Tokens, by ticker or by name.
  for (const m of [...plain.matchAll(TICKER), ...plain.matchAll(TICKER_ANYCASE)]) {
    if (!truth.tickers.has(m[1].toUpperCase())) return fail('a token that is not in this request', m[1]);
  }
  for (const [name, tickers] of TOKEN_NAMES) {
    for (const m of plain.matchAll(name)) {
      if (!tickers.some((t) => truth.tickers.has(t)) && !truth.lower.includes(m[0].toLowerCase())) {
        return fail('a token that is not in this request', m[0]);
      }
    }
  }

  if (!truth.unlimited) {
    const all = claims([/\b(?:unlimited|any amount|all of your|all your|everything|your entire|your whole)\b/i], plain);
    if (all) return fail('a claim that everything or an unlimited amount is at stake, which the facts do not say', all);
  }

  // Guardian never says "safe"; neither may its AI.
  const strict = result.risk !== 'info' || isUndecoded(result);
  const safe = callsItSafe(plain, strict);
  if (safe) return fail('words that call this request safe or ordinary, which Guardian cannot confirm', safe);

  if (PERMISSION_KINDS.has(result.kind)) {
    const swapped = claims(YOU_GET_PERMISSION, plain);
    if (swapped) return fail('a claim that you get the permission, while the other party does', swapped);
  }
  if ((TRANSFER_KINDS.has(result.kind) && !truth.toSelf) || PERMISSION_KINDS.has(result.kind)) {
    const gain = claims(YOU_GET_FUNDS, plain);
    if (gain) return fail('a claim that something comes to you, while this request only lets things leave your wallet', gain);
  }
  return null;
}

/**
 * Splits into sentences; the last piece may still be unfinished. A full stop
 * ends a sentence only before a space or the end, and "..." never does, so
 * "0.01 ETH" and "0x9f3a... c21e" stay whole.
 */
function sentences(text) {
  return text.match(/(?:[^.!?]|\.{2,}|[.!?](?!\s|$))+(?:[.!?]+(?=\s|$))?\s*/g) || [];
}

/**
 * Follows a streamed answer. `push(fullTextSoFar)` returns what may be shown
 * now (only complete, checked sentences) and, once a sentence fails, why the
 * answer stops there. `finish(fullText)` checks the rest.
 * @returns {{shown: string, problem: string|null, detail: string|null}}
 */
export function answerChecker(result, extra = '', options = {}) {
  const truth = groundTruth(result, extra, options);
  let shown = '';
  let checked = 0;
  let failed = null;

  const state = () => ({ shown: shown.trim(), problem: failed ? failed.reason : null, detail: failed ? failed.detail : null });
  const advance = (text, complete) => {
    if (failed) return state();
    const parts = sentences(text);
    const upTo = complete ? parts.length : Math.max(0, parts.length - 1);
    for (let i = checked; i < upTo; i++) {
      failed = checkText(parts[i], result, truth);
      if (failed) return state();
      shown += parts[i];
      checked = i + 1;
    }
    if (complete && !shown.trim()) failed = { reason: 'nothing', detail: '' };
    return state();
  };

  return {
    push: (text) => advance(text, false),
    finish: (text) => advance(text, true),
  };
}

// ── The user's own address ──────────────────────────────────────────────────

/** Removes the user's own address from text that may leave the computer. */
export function scrubAddresses(text, own) {
  let out = String(text);
  for (const a of own) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(a)) continue;
    out = out.replace(new RegExp(a, 'gi'), '(your own wallet)').replace(new RegExp(a.slice(2), 'gi'), '(your own wallet)');
  }
  return out;
}

/**
 * The analyzer's result with the user's own address taken out of every
 * string, before any prompt shortens a value (a shortened address would no
 * longer be recognised).
 */
export function scrubResult(result, own) {
  if (!own || own.length === 0) return result;
  const walk = (value) => {
    if (typeof value === 'string') return scrubAddresses(value, own);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
    return value;
  };
  return walk(result);
}

/** The user's own address(es): the wallet's accounts and the request's signer. */
export function ownAddresses(record) {
  const out = new Set();
  const add = (v) => {
    if (typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v)) out.add(v.toLowerCase());
  };
  const params = Array.isArray(record && record.params) ? record.params : [];
  const method = String((record && record.method) || '');
  // The wallet's connected accounts, read by the in-page guard.
  const accounts = record && record.enrich && Array.isArray(record.enrich.accounts) ? record.enrich.accounts : [];
  accounts.forEach(add);
  if (/^eth_send|^wallet_sendCalls|^eth_signTransaction/.test(method)) {
    add(params[0] && params[0].from);
  } else if (/sign/i.test(method)) {
    // personal_sign(message, address), eth_sign(address, data),
    // eth_signTypedData*(address, data): the account is the address param.
    // Wherever else it appears (a typed-data "owner", a message text), the
    // scrub replaces it too.
    params.slice(0, 2).forEach(add);
  }
  return [...out];
}

/** The sentence the window shows instead of an AI answer: written by code. */
export function codeSentence(result, meaningSentence) {
  if (meaningSentence) return meaningSentence;
  if (isUndecoded(result)) return 'Guardian could not decode what this request does.';
  return `${result.headline}. The facts below are all Guardian can confirm.`;
}
