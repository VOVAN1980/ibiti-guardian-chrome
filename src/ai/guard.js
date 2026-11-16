// Keeps Guardian's own AI honest.
//
// An answer is checked before the user sees it, one sentence at a time: a
// sentence appears only after it passed. What is checked (and only this is
// claimed in the window):
//   - every address in it is an address of this request, and an address
//     named with its part ("the spender 0x…") plays that part;
//   - every amount is an amount of this request, with its own token
//     ("0.01 ETH" passes only where the request moves 0.01 ETH);
//   - every other number, percentage and token name is in the facts;
//   - every network, site and app it names is in the facts;
//   - it does not say "unlimited", "everything" or "all your tokens" where
//     the facts do not, nor "verified" where the analyzer verified nothing;
//   - it does not swap who gets what, and does not say anything comes to
//     the user;
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

import { ownAddresses } from '../analyzer/index.js';
import { CHAINS } from '../analyzer/registry.js';

// Requests the analyzer could not decode.
export const UNDECODED = new Set(['contractCall', 'typedData', 'unknown', 'blindSign', 'deploy']);

export const isUndecoded = (result) =>
  UNDECODED.has(result.kind) ||
  (result.kind === 'message' && Boolean(result.subject) && result.subject.readable === false) ||
  // A batch is only as decoded as its least decoded call.
  (result.kind === 'batch' && (!Array.isArray(result.parts) || result.parts.length === 0 || result.parts.some(isUndecoded)));

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
export function groundTruth(result, extra = '', { own = [], chainId = null, host = '' } = {}) {
  const text = [
    result.headline,
    ...result.facts.map((f) => `${f.label}: ${f.value} ${f.note || ''}`),
    ...result.reasons,
    extra,
    // The site that asked: the model is told its name and may repeat it.
    host ? `Site: ${host}` : '',
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
  // Tokens this request is about, as opposed to the coin its fee is paid in.
  const assets = new Set(tickers);
  // The network's own coin may be named (gas is paid in it).
  const chain = CHAINS[chainId];
  if (chain) tickers.add(chain.native.toUpperCase());
  for (const c of Object.values(CHAINS)) {
    if (plain.includes(c.name)) tickers.add(c.native.toUpperCase());
  }
  if (!chain && tickers.size === 0) tickers.add('ETH');
  // Which tokens the request puts no limit on ("Unlimited … for USDT", "any amount of USDT").
  const unlimitedTickers = new Set(
    [...plain.matchAll(new RegExp(String.raw`(?:unlimited[^.\n]{0,40}?\bfor|any amount of|all of (?:your|the)|all your)\s+(${TICKERS.join('|')})\b`, 'gi'))].map((m) =>
      m[1].toUpperCase(),
    ),
  );

  const unlimited = /unlimited|any amount|all of your|all your|every item|:\s*all\b|anything|any transaction/i.test(plain);
  // "Almost all of the ETH in this wallet": nearly everything, not everything.
  const almostAll = !unlimited && /\balmost all\b/i.test(plain);
  const to = String((result.subject && result.subject.to) || '').toLowerCase();
  const toSelf = to !== '' && own.map((a) => a.toLowerCase()).includes(to);
  const lower = plain.toLowerCase();
  return {
    lower,
    hexes,
    pairs,
    numbers,
    percents,
    tickers,
    assets,
    unlimited,
    unlimitedTickers,
    almostAll,
    toSelf,
    // The token's contract is the real one only where the analyzer said so.
    verified: /\bverified contract\b/i.test(plain),
    // Networks that may be named: the ones in the facts and the request's own.
    networks: `${lower} ${chain ? chain.name.toLowerCase() : ''}`,
    // Sign-in: the site the message signs in to, and the site the user is on.
    signInTo: String((result.subject && result.subject.domain) || '').toLowerCase(),
    onSite: String((result.facts.find((f) => f.label === 'You are on') || {}).value || '').toLowerCase(),
    // Which address plays which part in the decoded request.
    roles: rolesOf(result),
  };
}

/** spender / operator / collection / recipient / token → their addresses. */
function rolesOf(result) {
  const roles = { spender: new Set(), operator: new Set(), collection: new Set(), recipient: new Set(), token: new Set() };
  const add = (role, value) => {
    if (typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)) roles[role].add(value.toLowerCase());
  };
  const take = (s) => {
    if (!s || typeof s !== 'object') return;
    add('spender', s.spender);
    add('operator', s.operator);
    add('collection', s.collection);
    add('recipient', s.to);
    add('token', s.token && s.token.address);
    (Array.isArray(s.actions) ? s.actions : []).forEach(take);
  };
  take(result.subject);
  (result.parts || []).forEach((p) => take(p.subject));
  return roles;
}

// ── Sites and networks ──────────────────────────────────────────────────────

// A site name: something.tld, written in small letters ("wallet.This" at a
// missing space is not one). Sentence-starting words are left out of the list.
const DOMAIN =
  /\b(?:[A-Za-z0-9-]+\.)+(?:com|org|net|io|xyz|app|finance|exchange|example|co|dev|gg|fi|market|trade|site|online|info|ai|network|money|cash|club|pro|tech|link|top|vip|cc|ru|uk|eu|cn|ly|sh|page|cloud|store|shop|zone|bet|wiki|tools|capital|fund|bank|pay|crypto|nft|dao|defi|swap|eth)\b(?::\d+)?/g;

// Networks an answer might name. "Your Ethereum account" is how any EVM
// wallet is called; "Base" is a network only as "on Base" or "Base network".
const NETWORKS = [
  ['ethereum', /\bEthereum\b(?!\s+(?:account|wallet|address|key|signature|apps?|users?))/],
  ['bnb chain', /\b(?:BNB (?:Smart )?Chain|Binance Smart Chain|BSC)\b/],
  ['polygon', /\bPolygon\b/],
  ['arbitrum', /\bArbitrum\b/],
  ['optimism', /\bOptimism\b/],
  ['base', /\b(?:on|to|the|via)\s+Base\b(?!\s+(?:of|unit|layer|fee))|\bBase\s+(?:network|chain|mainnet)\b/],
  ['avalanche', /\bAvalanche\b/],
  ['solana', /\bSolana\b/],
  ['tron', /\bTron\b/],
  ['zksync', /\bzkSync\b/i],
  ['linea', /\bLinea\b/],
  ['fantom', /\bFantom\b/],
  ['gnosis', /\bGnosis\b/],
  ['sepolia', /\bSepolia\b/],
  ['holesky', /\bHolesky\b/],
  ['opbnb', /\bopBNB\b/],
  ['scroll', /\bScroll\b(?=\s+(?:network|chain|mainnet)|\s*[,.]|\s+(?:to|and|until)\b)/],
  ['blast', /\bBlast\b/],
  ['mantle', /\bMantle\b/],
  ['celo', /\bCelo\b/],
  ['cronos', /\bCronos\b/],
  ['starknet', /\bStarknet\b/i],
  ['zkevm', /\bzkEVM\b/],
  ['zora', /\bZora\b/],
  ['metis', /\bMetis\b/],
  ['moonbeam', /\bMoonbeam\b/],
  ['aurora', /\bAurora\b/],
];
// "the Foo network": whatever is called a network must be this request's.
const NAMED_NETWORK = /\b((?:[A-Za-z][A-Za-z0-9]*\s+)?[A-Za-z][A-Za-z0-9]*)\s+(?:network|chain|blockchain|testnet)\b(?!\s+(?:fees?|costs?|charges?|gas)\b)/g;
const NOT_A_NAME = /^(?:the|this|that|a|an|same|another|different|other|its|their|your|main|test|block|wrong|right|whole|entire|every|each|which|what|on the|of the|to the|in the|for the|on this|on that|on a|on another|the same|a different|the wrong|the right)$/i;

// Marketplaces, exchanges and protocols an answer might name as the app or
// the other party. Only the ones in the facts may be named.
const BRANDS =
  /\b(?:OpenSea|Blur|LooksRare|X2Y2|Rarible|Magic Eden|Seaport|Uniswap|SushiSwap|PancakeSwap|1inch|Curve|Balancer|Aave|Compound|Lido|MakerDAO|Coinbase|Kraken|OKX|Bybit|Permit2|Universal Router|SwapRouter|Swap Router|Binance(?!\s+Smart Chain))\b/g;

// "the spender 0x…", "the collection 0x…": the address must be the one that
// plays that part in this request.
const ROLE_ADDRESS =
  /\b(spender|operator|collection|recipient|receiver|destination|token contract|token)\s+(?:(?:address|wallet|contract|account|with|whose|is|at|of|named|called|the|its)\s+){0,4}?0x\s?([0-9a-f]{2,})(?:\s*(?:…|⋯|\.{2,}|[-–—*]{1,3})\s*([0-9a-f]{4,})(?![0-9a-z]))?/gi;
const ROLE_NAME = { receiver: 'recipient', destination: 'recipient', 'token contract': 'token' };

// "the wallet ending in c21e", "the address starting with 0x9f3a".
const ENDS_WITH = /\b(?:ending|ends|end)\s+(?:in|with)\s+(?:…|\.{2,})?([0-9a-f]{4,})\b/gi;
const STARTS_WITH = /\b(?:starting|starts|beginning|begins)\s+with\s+(?:0x)?([0-9a-f]{4,})\b/gi;

// ── Saying it is safe ───────────────────────────────────────────────────────

// Each clause (split at , ; : and dashes) is judged by itself, so "Check the
// address; this is safe" cannot hide the claim behind the advice.
// "It is safe", "looks legit", "safe to sign": never acceptable.
const SAFE_CLAIM =
  /\b(?:(?:is|are|looks?|seems?|appears?|be|sounds?|remains?|stays?|it's|that's|this's)\s+(?:\w+\s+){0,2}?(?:safe|secure|harmless|legitimate|legit|trustworthy|trusted|genuine|risk[- ]free|fine|okay|ok|alright|benign|verified)\b|safe to\b|safely\b|perfectly\s+(?:normal|fine|safe|ok|okay)\b)/i;
// "It is a standard approval": fine for an ordinary request, not for one
// Guardian flags. "A common drainer trick" is a warning, not a claim.
const SCAM_WORDS = 'scam|drainer|trick|attack|fraud|phishing|theft|lure|tactic|scheme|ploy|trap|bait|red flag|sign of|warning sign';
const ORDINARY_CLAIM = new RegExp(
  // "is a standard approval", "just a routine signature"
  String.raw`\b(?:(?:is|looks like|seems like|appears to be|just|simply|only)\s+(?:a|an)\s+(?:common|standard|normal|ordinary|routine|typical|legitimate|regular|everyday|usual|simple|harmless)\b(?!,?\s+(?:\w+\s+)?(?:${SCAM_WORDS})s?\b)` +
    // "is routine", "are perfectly normal" (but "is common in drainer scams" is a warning)
    String.raw`|(?:is|are|looks?|seems?|appears?)\s+(?:\w+\s+){0,2}?(?:routine|normal|standard|ordinary|typical|common|usual|expected)\b(?![^.;,]{0,40}\b(?:${SCAM_WORDS})s?\b))`,
  'i',
);
// "You can treat this as a standard approval" (but "do not treat this as a
// normal sign-in" is a warning).
const AS_ORDINARY =
  /\b(?:as|like)\s+(?:a|an|any)\s+(?:(?:other|completely|perfectly)\s+)?(?:standard|normal|routine|ordinary|typical|regular|usual|common|everyday)\b/i;
// "It looks like a harmless signature, but it really …": saying how it
// looks and then "but" concedes; it does not claim. ("This IS a normal
// transfer, but …" does claim, and is not excused.)
const CONTRAST =
  /\b(?:(?:may|might|can|could)\s+)?(?:looks?|seems?|appears?|sounds?)\s+(?:like\s+|to be\s+)?(?:(?:a|an)\s+)?(?:\w+\s+){0,2}?(?:safe|harmless|simple|innocent|legitimate|common|standard|normal|ordinary|routine|typical|regular|usual)\b[^.;]*?,?\s*(?:but|however|yet)\b/gi;
const NEGATED = /\b(?:not|never|no|nothing|none|nobody|cannot|can't|can not|isn't|aren't|won't|don't|doesn't|unable|nor|hardly|neither)\b|n't\b/i;
// "Verify that the spender is a legitimate service", "only continue if you
// are sure it is legitimate": advice to check, not a claim. A plain "if" is
// not enough: "If you confirm, it is safe" is a claim.
const ADVICE =
  /\b(?:verify|check|make sure|ensure|whether|unless|ask|find out|look up|research|only when|only if|confirm (?:that|whether|if|you are|you're)|if you (?:are sure|trust|know|believe|have checked|verified|recogni[sz]e))\b|^\s*(?:please\s+|always\s+|first,?\s+)?(?:confirm|double[- ]check|review|inspect|consider|remember)\b/i;

/** The text from the start of the clause holding position `at`. */
// (A colon inside "127.0.0.1:5179" does not end a clause.)
const clauseBefore = (text, at) => text.slice(0, at).split(/[,;()]|:(?!\d)|\s[-–—]\s|[.!?]\s/).pop();
// "To be safe, check the address" is advice; "the token is verified" repeats a fact.
const SAFE_IDIOM = /\bto\s+(?:be|stay|remain|keep|play it)\s+(?:\w+\s+)?safe\b|\bon the safe side\b|\bverified (?:contract|token)\b|\b(?:contract|token) is verified\b/gi;
// "Although it looks like a normal approval, …": the clause concedes, it does not claim.
const CONCEDES = /^\s*(?:although|though|while|even though|even if|despite|whereas)\b/i;

// Saying nothing bad can happen, in other words.
const DENIES_HARM = [
  new RegExp(
    String.raw`\b(?:cannot|can't|can not|won't|will not|will never|would not|wouldn't|does not|doesn't|do not|don't|is not able to|isn't able to|unable to|never|not going to)\s+(?:(?:really|actually|ever|even|directly|itself|simply|possibly|be able to|in any way)\s+){0,2}?(?:harm|hurt|damage|endanger|steal|drain|compromise|affect|touch|move|take|spend|access|cost|lose|risk|put)\s+(?:\w+\s+){0,3}?(?:funds?|money|wallet|tokens?|assets?|coins?|balance|nfts?|items?|account|anything|you\b|at risk|(?:${TICKERS.join('|')})\b)`,
    'i',
  ),
  /\bno\s+(?:\w+\s+)?(?:harm|danger|risk|threat|problem|downside|cost)s?\b/i,
  /\b(?:not|isn't|is not|aren't|are not|nothing)\s+(?:\w+\s+)?(?:dangerous|risky|harmful|a scam|a threat|malicious|a problem|suspicious|to fear)\b/i,
  /\bwithout\s+(?:any\s+)?(?:risk|danger)\b/i,
  /\b(?:low|little|minimal|zero)[- ]risk\b/i,
  /\bnothing\s+(?:\w+\s+){0,3}?(?:bad|to worry|happens?|wrong|leaves?|changes?|sent|taken|moved|lost|lose|spent|stolen|at stake|at risk)\b/i,
  /\b(?:lose|losing|risk|risking|cost(?:s|ing)?(?:\s+you)?)\s+nothing\b|\bnothing\s+to\s+(?:lose|fear)\b/i,
  /\b(?:little|not much|nothing|no reason|no cause|no need)\s+(?:\w+\s+){0,2}?(?:to\s+)?(?:worry|fear|concern|be concerned)\b/i,
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
  for (const clause of text.split(/[,;()]|:(?!\d)|\s[-–—]\s|\s+but\s+|\s+and\s+(?=(?:it|this|that|the|you|nothing|there)\b)/i)) {
    for (const pattern of strict ? [SAFE_CLAIM, ORDINARY_CLAIM, AS_ORDINARY] : [SAFE_CLAIM]) {
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
  // "lets your wallet spend …", "gives you unlimited permission …"
  new RegExp(
    String.raw`\b(?:lets?|allows?|enables?|permits?|authori[sz]es?)\s+${YOU}\s+(?:to\s+)?(?:spend|take|move|withdraw|transfer|use)\b`,
    'i',
  ),
  new RegExp(
    String.raw`\b(?:gives?|grants?|hands?)\s+${YOU}\s+(?:\w+\s+){0,3}?(?:permission|access|rights?|approval|allowance|control)\b`,
    'i',
  ),
];
// A sign-in, a plain message or a payment grants no spending permission.
const NO_PERMISSION_KINDS = new Set(['signIn', 'message', 'transfer', 'nativeTransfer']);
const GRANTS_PERMISSION = [
  /\b(?:permission|approval|allowance|the right|access)\s+to\s+(?:spend|take|move|use|withdraw|transfer)\b/i,
  /\baccess to (?:your|the)\s+(?:tokens?|funds|money|coins?|assets?|nfts?)\b/i,
];
const YOU_GET_FUNDS = [
  /\byou(?:'ll|'d)?\s+(?:(?:will|would|can|could|also)\s+)?(?:receive|get|earn|gain|collect|claim|win)\b(?!\s+(?:nothing|no\b|asked|a\s+warning|it\s+back|them\s+back|your\s+\w+\s+back|what|permission|access|later|in the future|afterwards))/i,
  // "… sends 250 DAI to your wallet", "… is sent into your wallet" (but not
  // "gives a stranger access to your wallet").
  /\b(?:sends?|pays?|transfers?|moves?|returns?|sent|goes|go|moved|transferred|deposited|added|paid|credited|returned|comes?|arrives?)\s+(?:(?!access|permission|control|rights?|approval)\w+\s+){0,3}?(?:into|to)\s+your\s+(?:own\s+)?(?:wallet|account)\b/i,
  /\b(?:arrives?|lands?|appears?|shows? up|ends? up|is deposited|are deposited|is credited|are credited)\s+(?:\w+\s+){0,2}?in(?:to)?\s+your\s+(?:own\s+)?(?:wallet|account)\b/i,
  /\b(?:sent|paid|transferred|credited|given)\s+to\s+you\b|\bcomes?\s+to\s+you\b|\bwill be yours\b/i,
];
// The direction things move. In everything Guardian decodes, the assets are
// the user's and can only leave: an approval lets someone else take them, a
// payment sends them out, a revoke takes someone else's permission away. So
// two kinds of phrases are wrong whatever the verb is:
//   - the other party as the owner or the source of the assets
//     ("USDC held by 0x…", "out of the personal wallet 0x…");
//   - the user as the one who ends up with something
//     ("… is granted to you", "… lands with you", "you are handed …").
const THEIRS = [
  // (a permission or an approval may be "held by" the spender; assets may not)
  /(?<!\b(?:approval|approvals|permission|permissions|allowance|access|right|rights|signature|order)\s)\b(?:held|owned|kept|stored)\s+by\s+(?!you\b|your\b)/i,
  /\bthat\s+(?:(?:the\s+(?:spender|operator|recipient|other party|site|contract|wallet|address)|it|they|he|she)\s+)?(?:owns?|holds?|keeps?)\b(?!\s+(?:your|this signature|the signature))/i,
  /\b(?:from|out of|inside)\s+(?:the|their|its|his|her|that|someone else's|another)\s+(?:(?!your\b)[\w'’-]+\s+){0,2}?(?:wallet|account|balance|holdings)\b/i,
  /\b(?:tokens?|funds|assets?|nfts?|items?|coins?|balance|money|usdt|usdc|dai|eth|weth)\s+(?:(?:that|which)\s+)?belong(?:s|ing)?\s+to\s+(?!you\b|your\b)/i,
  /\b(?:spender|operator|recipient)(?:'s|’s)\s+(?:own\s+)?(?:tokens?|funds|items?|nfts?|balance|assets?|usdt|usdc|dai|eth|weth)\b/i,
];
const TO_YOU = [
  /(?<!\bup\s)\b(?:to|with)\s+you\b(?!\s+(?:to|if|whether|about)\b)/i,
  // ("this wallet is yours" is about the wallet, not about getting something)
  /(?<!\b(?:wallet|account|address)\s)\b(?:is|are|be|becomes?|remains?|stays?)\s+(?:now\s+|then\s+|all\s+)?yours\b/i,
  /\byou(?:'ll|'d)?\s+(?:(?:will|would|can|could|may|might|now|then|also)\s+)*(?:end(?:s|ed)?\s+up|wind\s+up|come\s+away|walk\s+away|become)\b/i,
  // passive only: "you are handed …" (not "the permission you granted")
  /\byou(?:'re|(?:'ll|'d)?\s+(?:(?:will|would|can|could|may|have)\s+)?(?:are|were|get|got|be|been))\s+(?:\w+\s+)?(?:handed|granted|given|awarded|assigned|authori[sz]ed|permitted|entitled|credited|paid)\b/i,
];

// "Items you get later" is part of what an approval covers, not a gain.
const LATER_ITEMS =
  /\b(?:ones|items|tokens|nfts|anything|everything|whatever|any|those)\s+(?:that\s+)?you\s+(?:get|receive|acquire|buy|own|hold)\b(?:\s+(?:later|in the future|afterwards))?/gi;

// A revoke takes the OTHER party's permission away, not the user's.
const REVOKE_KINDS = new Set(['revoke', 'revokeAll']);
const REVOKE_SWAP = [
  /\byour\s+(?:own\s+)?(?:permission|right|access|ability)\s+to\s+(?:spend|use|move|take|withdraw|transfer)\s+(?:its|their|his|her|the spender's|the operator's)\b/i,
  /\byou\s+(?:can|could|will|would)\s+no longer\s+(?:spend|use|move|take|withdraw|transfer)\b/i,
  /\byou\s+(?:will|would)?\s*lose\s+(?:your\s+|the\s+)?(?:permission|access|right|ability)\b/i,
];

// Saying a token or contract is the real one: only where the analyzer
// verified the token's contract.
const SAYS_VERIFIED = [
  /\b(?:verified|official|genuine|authentic)\s+(?:\w+\s+)?(?:tokens?|contracts?|tether|usdt|usdc|dai|version|coin)\b/i,
  /\b(?:tokens?|contracts?)\s+(?:is|are|has been|was)\s+(?:\w+\s+)?(?:verified|official|genuine|authentic)\b/i,
  /\bthe real\s+(?:usdt|usdc|dai|tether|token|contract)\b/i,
];
// Guardian verifies token contracts and nothing else: never an address, a
// spender, a collection or a site.
const SAYS_VERIFIED_OTHER = [
  /\b(?:verified|official|genuine|authentic|trusted|reputable)\s+(?:[\w.'’-]+\s+){0,2}?(?:address(?:es)?|wallets?|recipients?|spenders?|operators?|collections?|sites?|websites?|apps?|services?|marketplaces?|part(?:y|ies)|persons?|accounts?)\b/i,
  /\b(?:address|wallet|recipient|spender|operator|collection|site|website|app|service|marketplace)\s+(?:is|are|has been|was)\s+(?:\w+\s+){0,3}?(?:verified|official|genuine|authentic)\b/i,
  // "Official" is never Guardian's word, whatever it is said about.
  /\b(?:official|genuine|authentic)\s+(?:[\w.'’-]+\s+){0,2}?(?:contract|token|version|router|protocol|deployment)\b/i,
  /(?:'s|’s)\s+(?:official|genuine|authentic|verified)\b/i,
];

// More at stake than this request covers: every token, every collection,
// the whole wallet. (Guardian's own rule from day one: say who, how much and
// why, never "all your funds will be stolen".)
// "… without moving any assets", "… without touching any of your tokens".
// Only right before the words: "without asking, take any of your tokens" is
// not a negation of the taking.
const WITHOUT_DOING = /\bwithout\s+(?:moving|sending|touching|taking|transferring|spending|giving away|losing|risking)\s*$/i;

const WALLET_WIDE = [
  // (not "all of your NFTs in this collection": that is this request's scope)
  /\b(?:all|every|any|each)\s+(?:of\s+)?(?:your\s+|the\s+)?(?:other\s+)?(?:nfts?|tokens?|assets?|coins?|funds|crypto|collections?|holdings|savings|money)\b(?![^.;]{0,40}\b(?:this|that|the same|a specific|a single|a particular|one)\s+(?:collection|token|contract)\b)/i,
  /\bevery(?:thing|\s+nft|\s+token|\s+asset|\s+coin|\s+item)?\s+in\s+your\s+wallet\b/i,
  /\byour\s+(?:entire|whole)\s+(?:wallet|portfolio)\b/i,
  /\b(?:empty|drain|wipe out|clean out)\s+your\s+(?:entire\s+|whole\s+)?wallet\b/i,
  /\bfrom\s+any\s+collection\b/i,
  // "… and your other tokens": anything beyond what this request names.
  /\b(?:your|the|any|all)\s+other\s+(?:nfts?|tokens?|assets?|coins?|funds|items?|collections?|holdings)\b/i,
];

const FACT_NEGATIONS =
  /\b(?:(?:that|which|whom)\s+)?(?:guardian|we|it)\s+(?:does\s+not|doesn't|did\s+not|didn't|cannot|can't)\s+(?:recogni[sz]e|know|identify)\b|\bnot\s+(?:recogni[sz]ed|known)\b|\b(?:and\s+|,\s*)?not\s+(?:a|an)\s+(?:contract|app|application|service|smart contract|person)\b|\b(?:almost\s+)?never\s+(?:a|an)\s+(?:person|individual|personal wallet)\b/gi;

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
  for (const m of text.matchAll(ENDS_WITH)) {
    if (!truth.hexes.some((h) => h.endsWith(m[1].toLowerCase()))) return fail('an address that is not in this request', m[0]);
  }
  for (const m of text.matchAll(STARTS_WITH)) {
    if (!truth.hexes.some((h) => h.slice(2).startsWith(m[1].toLowerCase()))) {
      return fail('an address that is not in this request', m[0]);
    }
  }
  // An address named with its part must be the address that plays that part.
  for (const m of text.matchAll(ROLE_ADDRESS)) {
    const role = ROLE_NAME[m[1].toLowerCase()] || m[1].toLowerCase();
    const fits = (address) => address.startsWith(`0x${m[2].toLowerCase()}`) && (!m[3] || address.endsWith(m[3].toLowerCase()));
    const own = [...truth.roles[role]];
    const elsewhere = Object.entries(truth.roles).some(([other, set]) => other !== role && [...set].some(fits));
    if (own.length > 0 ? !own.some(fits) : elsewhere) return fail(`the wrong address as the ${role}`, m[0]);
  }
  // Apps and marketplaces: only the ones in this request.
  for (const m of text.matchAll(BRANDS)) {
    if (!truth.lower.includes(m[0].toLowerCase())) return fail('an app or service that is not in this request', m[0]);
  }
  // Sites and names: only the ones in this request.
  for (const m of text.matchAll(DOMAIN)) {
    if (!truth.lower.includes(m[0].toLowerCase())) return fail('a site or name that is not in this request', m[0]);
  }
  // Networks: only the one this request is on.
  for (const [name, pattern] of NETWORKS) {
    const m = pattern.exec(text);
    if (m && !truth.networks.includes(name)) return fail('a network that is not in this request', m[0]);
  }
  for (const m of text.matchAll(NAMED_NETWORK)) {
    const named = m[1].replace(/^(?:on|to|of|in|for|via)\s+/i, '').replace(/^(?:the|this|that|a|an)\s+/i, '').trim();
    // A name has a capital letter in it ("Scroll", "opBNB"); "a small network" does not.
    if (!named || !/[A-Z]/.test(named) || NOT_A_NAME.test(named) || NOT_A_NAME.test(m[1].trim())) continue;
    if (!truth.networks.includes(named.toLowerCase())) return fail('a network that is not in this request', m[0]);
  }

  // Whole addresses, shortened ones and "ending in 5428" included, are not numbers.
  let plain = text
    .replace(ADDRESS, ' ')
    .replace(HEX, ' ')
    .replace(ENDS_WITH, ' ')
    .replace(STARTS_WITH, ' ')
    .replace(NOT_NUMBERS, ' ');

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
    // "two tokens" where the facts say "2 tokens" is a count, not an amount.
    const counted = /^(tokens?|coins?)$/i.test(m[2]) && value && truth.numbers.has(value);
    const ok = counted || (value && tickers && tickers.some((t) => truth.pairs.has(`${value} ${t}`)));
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

  // "A wallet Guardian does not recognise", "not a contract": these come from
  // the facts. Taken out, so their "not" does not excuse a claim next to them.
  plain = plain.replace(FACT_NEGATIONS, ' unrecognised ');

  // Tokens, by ticker or by name.
  const FEE_TALK = /\b(?:fees?|gas|network cost|transaction cost)\b/i;
  for (const m of [...plain.matchAll(TICKER), ...plain.matchAll(TICKER_ANYCASE)]) {
    const ticker = m[1].toUpperCase();
    if (!truth.tickers.has(ticker)) return fail('a token that is not in this request', m[1]);
    // The network's coin, where the request is not about it: only as what
    // the fee is paid in, or as what does not move.
    if (!truth.assets.has(ticker) && !FEE_TALK.test(plain) && !NEGATED.test(clauseBefore(plain, m.index))) {
      return fail('a token that is not in this request', m[1]);
    }
  }
  for (const [name, tickers] of TOKEN_NAMES) {
    for (const m of plain.matchAll(name)) {
      if (!tickers.some((t) => truth.tickers.has(t)) && !truth.lower.includes(m[0].toLowerCase())) {
        return fail('a token that is not in this request', m[0]);
      }
    }
  }

  const TOO_MUCH = 'a claim that more is at stake than this request covers';
  if (!truth.unlimited) {
    for (const m of plain.matchAll(/\b(?:unlimited|any amount|all of your|all your|all of the|everything|your entire|your whole)\b/gi)) {
      const before = clauseBefore(plain, m.index);
      if (NEGATED.test(before) || ADVICE.test(before)) continue;
      // "Nearly your whole balance" is what "almost all" means; "all" is more.
      if (truth.almostAll && /\b(?:nearly|almost|about|roughly|practically|virtually|close to|most of)\s*$/i.test(before)) continue;
      return fail(TOO_MUCH, m[0]);
    }
  }
  // "Any amount of your DAI" where only USDT is unlimited.
  if (truth.unlimitedTickers.size > 0) {
    const perToken = new RegExp(String.raw`\b(?:unlimited|any amount|all)\b[^.;,]{0,30}?\b(${TICKERS.join('|')})\b`, 'gi');
    for (const m of plain.matchAll(perToken)) {
      const before = clauseBefore(plain, m.index);
      if (NEGATED.test(before) || ADVICE.test(before)) continue;
      if (truth.assets.has(m[1].toUpperCase()) && !truth.unlimitedTickers.has(m[1].toUpperCase())) return fail(TOO_MUCH, m[0]);
    }
  }
  // Every token, every collection, the whole wallet: only where the facts say
  // it. A "not" does not excuse it: "can no longer move any of your tokens"
  // still speaks of more than this request.
  for (const pattern of WALLET_WIDE) {
    const re = new RegExp(pattern.source, `${pattern.flags}g`);
    for (const m of plain.matchAll(re)) {
      const before = clauseBefore(plain, m.index);
      if (ADVICE.test(before)) continue;
      // "without moving any assets": a negation, right before it.
      if (WITHOUT_DOING.test(before)) continue;
      if (NEGATED.test(before) && !/\b(?:no longer|any ?more|any longer)\b/i.test(before)) continue;
      if (!truth.lower.includes(m[0].toLowerCase())) return fail(TOO_MUCH, m[0]);
    }
  }

  // "Verified", "official", "the real USDT": only where the analyzer verified it.
  const NOT_VERIFIED = 'a claim that something is verified, which the facts do not say';
  if (!truth.verified) {
    const real = claims(SAYS_VERIFIED, plain);
    if (real) return fail(NOT_VERIFIED, real);
  }
  const other = claims(SAYS_VERIFIED_OTHER, plain);
  if (other && !truth.lower.includes(other.toLowerCase())) return fail(NOT_VERIFIED, other);

  // Guardian never says "safe"; neither may its AI.
  const strict = result.risk !== 'info' || isUndecoded(result);
  const safe = callsItSafe(plain, strict);
  if (safe) return fail('words that call this request safe or ordinary, which Guardian cannot confirm', safe);

  // Who gets what.
  const roles = plain.replace(LATER_ITEMS, ' ');
  // The direction things move: the assets are the user's and only leave.
  const theirs = claims(THEIRS, roles);
  if (theirs) return fail('words that make the other party the owner of the assets, while they are yours', theirs);
  if (!truth.toSelf) {
    const toYou = claims(TO_YOU, roles);
    if (toYou) return fail('a claim that something comes to you, which the facts do not say', toYou);
  }
  if (PERMISSION_KINDS.has(result.kind) || result.kind === 'batch') {
    const swapped = claims(YOU_GET_PERMISSION, roles);
    if (swapped) return fail('a claim that you get the permission, while the other party does', swapped);
  }
  // Nothing Guardian decodes brings funds in: not an approval, a payment out,
  // a revoke, a sign-in or an order.
  if (!truth.toSelf) {
    const gain = claims(YOU_GET_FUNDS, roles);
    if (gain) return fail('a claim that something comes to you, which the facts do not say', gain);
  }
  if (NO_PERMISSION_KINDS.has(result.kind)) {
    const grant = claims(GRANTS_PERMISSION, roles);
    if (grant) return fail('a claim that this grants a spending permission, which the facts do not say', grant);
  }
  if (REVOKE_KINDS.has(result.kind)) {
    const swapped = claims(REVOKE_SWAP, roles);
    if (swapped) return fail('a claim that you lose a permission, while it is the other party that loses it', swapped);
  }
  if (result.kind === 'signIn') {
    const site = (raw) => raw.toLowerCase().replace(/[.,;:!?"”']+$/, '');
    for (const m of text.matchAll(/\b(?:sign|log)(?:s|ged|ed|ging|ing)?\s+(?:you\s+)?in\s*to\s+["“']?([A-Za-z0-9.:-]+)/gi)) {
      const named = site(m[1]);
      if (named.includes('.') && truth.signInTo && named !== truth.signInTo) {
        return fail('the wrong site as the one this message signs you in to', m[0]);
      }
    }
    for (const m of text.matchAll(
      /\b(?:you are on|you're on|you are currently on|comes from|coming from|came from|is from|made on|while on|visiting)\s+["“']?([A-Za-z0-9.:-]+)/gi,
    )) {
      const named = site(m[1]);
      if (named.includes('.') && truth.onSite && named !== truth.onSite) {
        return fail('the wrong site as the one you are on', m[0]);
      }
    }
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

// The user's own address(es): decided by the analyzer, which needs them too.
export { ownAddresses };

/** The sentence the window shows instead of an AI answer: written by code. */
export function codeSentence(result, meaningSentence) {
  if (meaningSentence) return meaningSentence;
  if (isUndecoded(result)) return 'Guardian could not decode what this request does.';
  return `${result.headline}. The facts below are all Guardian can confirm.`;
}
