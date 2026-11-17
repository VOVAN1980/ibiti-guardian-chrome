// What Gemini contributes to Guardian's window, as data that code can check.
//
// Free text cannot be checked for meaning: "the spender gets permission" and
// "permission ends up with you" differ by a few words, and every new wording
// needs a new rule. So Gemini does not tell the user who gets what. Code does
// (meaning() in prompt.js), from the decoded request. Gemini answers a form:
//
//   action     what kind of request this is
//   who_gains  who could move or receive the user's assets
//   direction  which way the user's own assets can move
//   limit      how much: unlimited, limited, or not a matter of amount
//   reasons    which of the analyzer's reasons matter most (by number)
//   note       one or two sentences on why it matters, naming nothing
//
// and, for the deeper analysis, the same reading plus a scam pattern from a
// fixed list, a one-sentence summary and things to check.
//
// Code compares every field with what the analyzer decoded. A swap of who
// gains or of the direction is a wrong value in a field, whatever words the
// model would have used, and then nothing from the model is shown. The
// free-text parts (note, summary, checks) may not name anything: no token, no
// amount, no address, no number, no site. Names come from code only; the
// model's words are also checked for the claims code can recognise (src/ai/
// guard.js): "safe", "verified", "unlimited", "you get the permission".

import { BRANDS, NEGATED, NETWORKS, answerChecker, isUndecoded } from './guard.js';

// Words that turn a "normal …" into a warning.
const SCAM = 'scam|drainer|trick|attack|fraud|phishing|theft|lure|tactic|scheme|ploy|trap|bait|red flag|sign of|warning sign';

export const ACTIONS = [
  'spending_permission',
  'collection_access',
  'payment',
  'remove_permission',
  'sign_in',
  'sign_text',
  'marketplace_order',
  'several_actions',
];
export const WHO = ['another_party', 'you', 'nobody'];
export const DIRECTIONS = ['out_of_your_wallet', 'into_your_wallet', 'nothing_moves'];
export const LIMITS = ['unlimited', 'limited', 'does_not_apply'];

const READING_PROPERTIES = {
  action: { type: 'string', enum: ACTIONS },
  who_gains: { type: 'string', enum: WHO },
  direction: { type: 'string', enum: DIRECTIONS },
  limit: { type: 'string', enum: LIMITS },
};

/** The short explanation's form, as JSON Schema: on the device and in the cloud alike. */
export const READING_SCHEMA = {
  type: 'object',
  properties: {
    ...READING_PROPERTIES,
    reasons: { type: 'array', items: { type: 'integer' }, maxItems: 2 },
    note: { type: 'string' },
  },
  required: ['action', 'who_gains', 'direction', 'limit', 'reasons', 'note'],
  additionalProperties: false,
};

// Scam patterns the deeper analysis may name. The label the user reads is
// written here; the model only picks one, and code checks that the request
// has what the pattern is about.
export const PATTERNS = {
  approval_phishing: {
    label: 'Matches a known scam pattern: approval phishing, a spending permission for someone else',
    // A permit is an approval given by signature.
    fits: (r) => r.kind === 'approve' || r.kind === 'permit' || r.kind === 'permit2',
  },
  permit_phishing: {
    label: 'Matches a known scam pattern: permit phishing, a signature that lets someone take tokens',
    fits: (r) => r.kind === 'permit' || r.kind === 'permit2',
  },
  collection_approval_phishing: {
    label: 'Matches a known scam pattern: collection approval phishing, access to every item in a collection',
    fits: (r) => r.kind === 'approveAll',
  },
  fake_token: {
    label: 'Matches a known scam pattern: a fake token that borrows a famous name',
    fits: (r) => tokensOf(r).some((t) => t && t.impersonates),
  },
  sign_in_phishing: {
    label: 'Matches a known scam pattern: a sign-in message for a different site',
    fits: (r) => r.kind === 'signIn' && Boolean(r.subject && r.subject.mismatch),
  },
  marketplace_order_phishing: {
    label: 'Matches a known scam pattern: a marketplace order signature that gives items away',
    fits: (r) => r.kind === 'order',
  },
  risky_action_in_a_batch: {
    label: 'Matches a known scam pattern: a risky action hidden among others in one confirmation',
    // At least one part that is not ordinary.
    fits: (r) => r.kind === 'batch' && (r.parts || []).length > 1 && r.parts.some((p) => p.risk !== 'info'),
  },
  no_known_pattern: {
    label: 'No known scam pattern matched. That alone does not make it safe',
    fits: () => true,
  },
  cannot_determine: {
    label: 'Could not tell whether this matches a known scam pattern',
    fits: () => true,
  },
};
const KNOWN = (pattern) => pattern !== 'no_known_pattern' && pattern !== 'cannot_determine';

/** The deeper analysis's form. */
export const DEEP_SCHEMA = {
  type: 'object',
  properties: {
    ...READING_PROPERTIES,
    pattern: { type: 'string', enum: Object.keys(PATTERNS) },
    summary: { type: 'string' },
    checks: { type: 'array', items: { type: 'string' }, maxItems: 3 },
  },
  required: ['action', 'who_gains', 'direction', 'limit', 'pattern', 'summary', 'checks'],
  additionalProperties: false,
};

/** How to fill the reading in: part of every prompt that asks for it. */
export const READING_GUIDE = [
  `- action: what kind of request this is: ${ACTIONS.join(', ')}.`,
  '- who_gains: who could move or receive the user\'s assets if the user confirms: another_party, you (the user), or nobody.',
  '- direction: which way the user\'s own assets can move as a result: out_of_your_wallet, into_your_wallet, or nothing_moves.',
  '- limit: for a spending permission, unlimited or limited (unlimited if any token in it is unlimited); for a payment, limited; for access to a whole collection, unlimited; for several actions, unlimited if any of them is, otherwise limited; otherwise does_not_apply.',
].join('\n');
export const REASONS_GUIDE =
  '- reasons: the numbers of the one or two most important lines under "Why it matters", most important first.';
export const PATTERN_GUIDE = [
  `- pattern: a known wallet-scam pattern this request has the shape of (${Object.keys(PATTERNS)
    .filter(KNOWN)
    .join(', ')}); no_known_pattern if it matches none (that does not make it safe); cannot_determine if the facts are not enough to tell.`,
].join('\n');

// ── What the analyzer decoded, in the form's terms ─────────────────────────

const tokensOf = (r) => {
  const s = r.subject || {};
  return [s.token, ...((s.actions || []).map((a) => a && a.token))].filter(Boolean);
};

const field = (action, who, direction, limit) => ({ action, who_gains: who, direction, limit });
const OUT = ['out_of_your_wallet'];
const OTHER = ['another_party'];

/**
 * For each field, the values that are right for this request. Null when the
 * request was not decoded: then no AI is asked at all.
 */
export function decodedReading(result) {
  if (isUndecoded(result)) return null;
  const reading = readingOf(result);
  // Coins sent along with a token call leave the wallet, to the contract,
  // whatever the call itself does.
  if (reading && result.subject && result.subject.coins) {
    return { ...reading, who_gains: OTHER, direction: OUT };
  }
  return reading;
}

function readingOf(result) {
  const s = result.subject || {};
  switch (s.action) {
    case 'approve':
      return field(['spending_permission'], OTHER, OUT, [s.unlimited ? 'unlimited' : 'limited']);
    case 'permitTransfer':
      // One-time: the spender takes the amount once. Either word fits it.
      return field(['spending_permission', 'payment'], OTHER, OUT, [s.unlimited ? 'unlimited' : 'limited']);
    case 'permit2Batch': {
      // Unlimited if any token in it is: "limited" would hide that one.
      const any = (s.actions || []).some((a) => a && a.unlimited);
      return field(
        s.once ? ['spending_permission', 'payment'] : ['spending_permission'],
        OTHER,
        OUT,
        any ? ['unlimited'] : ['limited'],
      );
    }
    case 'approveAll':
      return field(['collection_access'], OTHER, OUT, ['unlimited']);
    case 'transfer':
    case 'nativeTransfer': {
      if (s.empty) return field(['payment'], ['nobody', 'another_party'], ['nothing_moves'], ['does_not_apply', 'limited']);
      const limit = ['limited'];
      if (s.fromSelf === false) {
        // Someone else's tokens, moved with their permission: none of the
        // user's own assets move. The recipient gains them, so either
        // reading of who gains is right; "you" is not, unless they come here.
        return s.toSelf
          ? field(['payment'], ['you'], ['into_your_wallet'], limit)
          : field(['payment'], ['nobody', 'another_party'], ['nothing_moves'], limit);
      }
      // To another address of this same wallet.
      if (s.toSelf) return field(['payment'], ['you'], ['out_of_your_wallet', 'nothing_moves'], limit);
      return field(['payment'], OTHER, OUT, limit);
    }
    case 'revoke':
    case 'revokeAll':
      return field(['remove_permission'], ['nobody'], ['nothing_moves'], ['does_not_apply', 'limited']);
    case 'signIn':
      // A sign-in for a different site: nothing moves, but the other site
      // could use the signature to sign in as the user. Either reading of
      // who gains is right there; "you" is not.
      return field(['sign_in'], s.mismatch ? ['nobody', 'another_party'] : ['nobody'], ['nothing_moves'], ['does_not_apply']);
    case 'signMessage':
      return field(['sign_text'], ['nobody'], ['nothing_moves'], ['does_not_apply']);
    case 'marketOrder':
      return field(['marketplace_order'], OTHER, OUT, LIMITS);
    case 'batch': {
      const parts = (result.parts || []).map(decodedReading);
      if (parts.length === 0 || parts.some((p) => p === null)) return null;
      const leaves = parts.some((p) => p.direction.includes('out_of_your_wallet'));
      // Unlimited if any action is; otherwise limited (or, read literally, not a matter of amount).
      const unlimited = parts.some((p) => p.limit.length === 1 && p.limit[0] === 'unlimited');
      return field(
        ['several_actions'],
        leaves ? OTHER : ['nobody'],
        leaves ? OUT : ['nothing_moves'],
        unlimited ? ['unlimited'] : ['limited', 'does_not_apply'],
      );
    }
    default:
      return null;
  }
}

const PLAIN = { action: 'what it is', who_gains: 'who gains', direction: 'which way assets move', limit: 'the limit', pattern: 'the scam pattern' };
const words = (value) => String(value).replace(/_/g, ' ');

/**
 * Compares the model's reading with the analyzer's.
 * @param {object} answer  the model's form, parsed
 * @param {object} result  the analyzer's result
 * @param {object} [options]
 * @param {number[]} [options.shown]  reason numbers the model was shown (1-based)
 * @param {boolean} [options.deep]    the deeper analysis: also checks the pattern
 * @returns {{match: boolean, mismatches: {field: string, said: string, decoded: string}[], top: number[]}}
 */
export function checkReading(answer, result, { shown = null, deep = false } = {}) {
  const decoded = decodedReading(result);
  const a = answer && typeof answer === 'object' && !Array.isArray(answer) ? answer : {};
  if (!decoded) return { match: false, mismatches: [{ field: PLAIN.action, said: 'an answer', decoded: 'nothing' }], top: [] };
  const mismatches = [];
  for (const name of ['action', 'who_gains', 'direction', 'limit']) {
    const said = typeof a[name] === 'string' ? a[name] : '';
    if (!decoded[name].includes(said)) {
      mismatches.push({ field: PLAIN[name], said: words(said || 'nothing'), decoded: words(decoded[name][0]) });
    }
  }
  if (deep) {
    const pattern = typeof a.pattern === 'string' ? a.pattern : '';
    const known = Object.prototype.hasOwnProperty.call(PATTERNS, pattern);
    // A known scam pattern must be one this request has the shape of, and
    // never on a request Guardian found no red flags in.
    if (!known || !PATTERNS[pattern].fits(result) || (KNOWN(pattern) && result.risk === 'info')) {
      mismatches.push({ field: PLAIN.pattern, said: words(pattern || 'nothing'), decoded: 'a pattern this request does not have' });
    }
  }
  // Only reasons the model was shown count (numbers as in the prompt).
  const count = result.reasons.length;
  const valid = (n) => Number.isInteger(n) && n >= 1 && n <= count && (!shown || shown.includes(n));
  const top = [...new Set((Array.isArray(a.reasons) ? a.reasons : []).filter(valid))].slice(0, 2);
  return { match: mismatches.length === 0, mismatches, top };
}

/** Which part of the reading differed, for the window; never the model's value. */
export function mismatchWords(mismatches) {
  return mismatches.map((m) => m.field).join(', ');
}

// ── The model's own words ──────────────────────────────────────────────────

// Words in capitals that are not token tickers.
const NOT_TICKERS = new Set(['NFT', 'DEX', 'URL', 'ID', 'OK', 'NOT', 'ALL', 'ANY', 'ONLY', 'NEVER']);
const DIGIT = /\d/;
const HEX = /0x/i;
const CAPS = /\b[A-Z]{2,6}\b/g;
const DOMAIN = /\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/i;
const CURRENCY = /[$€£¥₿]/;

/**
 * The note, the summary and the checks name nothing: every name, amount and
 * address the user reads comes from code. Returns what looks like a name, or null.
 */
export function namesIn(text) {
  const s = String(text);
  for (const re of [DIGIT, HEX, DOMAIN, CURRENCY]) {
    const m = re.exec(s);
    if (m) return m[0];
  }
  for (const m of s.matchAll(CAPS)) {
    if (!NOT_TICKERS.has(m[0])) return m[0];
  }
  return null;
}

// Long enough for two plain sentences; a model that writes more has not
// followed the form.
const MAX_CHARS = 400;

/**
 * Checks one piece of the model's own words.
 * @returns {{problem: string, detail: string}|null}  null: it may be shown
 */
export function wordsProblem(text, result, codeSentence, options = {}) {
  const t = String(text || '').trim();
  if (!t) return { problem: 'nothing', detail: '' };
  if (t.length > MAX_CHARS) return { problem: 'too much text', detail: `${t.length} characters` };
  const name = namesIn(t) || namedIn(t, result);
  if (name) return { problem: 'a name, number or address of its own', detail: name };
  const verdict = answerChecker(result, codeSentence, options).finish(t);
  if (verdict.problem) return { problem: verdict.problem, detail: verdict.detail || '' };
  return contradicts(t, result, { advice: Boolean(options.advice) });
}

/** A network, a well-known app, or a name the request itself carries. */
function namedIn(text, result) {
  for (const [, re] of NETWORKS) {
    const m = re.exec(text);
    if (m) return m[0];
  }
  const brand = new RegExp(BRANDS.source).exec(text);
  if (brand) return brand[0];
  for (const f of result.facts) {
    if ((f.label === 'App' || f.label === 'Sign-in for') && f.value.length >= 3 && text.toLowerCase().includes(f.value.toLowerCase())) {
      return f.value;
    }
  }
  return null;
}

/**
 * The model's JSON answer as an object, or null. Only a JSON object counts;
 * a code fence around it (some models add one) is not part of the answer.
 */
export function parseAnswer(text) {
  const raw = String(text || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

// ── The note against the reading code has verified ─────────────────────────
//
// Once the form matches, code knows what kind of request it is, who gains,
// which way assets move and whether it is limited. The model's words may not
// say otherwise: these checks compare them with those verified values.

const CLAUSE = /[,;()]|:(?!\d)|\s[-–—]\s|[.!?]\s/;
// Words that turn what follows into its opposite, or into a comparison.
const TURNS = /\b(?:no longer|without|unlike|look(?:s|ing)?\s+like|disguised\s+as|pos(?:e|es|ing)\s+as|pretend\w*|rather\s+than|than)\b/i;
/** Whether the words right before `at`, in the same clause, deny it. */
const denied = (text, at) => {
  const before = text.slice(0, at).split(CLAUSE).pop();
  return NEGATED.test(before) || TURNS.test(before);
};
/**
 * The first match of `re` in `text` that is not denied, or null. `undone`:
 * words that, earlier in the clause, make it about something taken back
 * ("cancels a permission that let the operator move …").
 */
function said(text, re, undone = null) {
  for (const m of text.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`))) {
    if (denied(text, m.index)) continue;
    if (undone && undone.test(text.slice(0, m.index).split(/[.!?]\s/).pop())) continue;
    return m[0];
  }
  return null;
}
const UNDONE = /\b(?:cancel\w*|remov\w*|revok\w*|tak(?:e|es|ing)\s+away|ends?|ending|withdraw\w*|stops?|stopping|previously|before|earlier|already\s+gave)\b/i;

// Reassurance: never, whatever the request (Guardian says "no red flags
// found", never "safe" or "normal").
const REASSURES = [
  /\bnothing\s+(?:\w+\s+){0,2}?(?:to\s+worry|(?:can|could|will|would)\s+go\s+wrong|bad\s+(?:can|could|will))\b/i,
  /\b(?:little|not much|hardly anything)\s+(?:that\s+)?(?:can|could|will|would)\s+go\s+wrong\b/i,
  /\b(?:no|little|nothing|without)\s+(?:\w+\s+)?(?:reason\s+)?(?:to\s+)?(?:worry|fear|concern)\b/i,
  /\b(?:no|low|little|minimal|zero|small|tiny)[- ](?:risk|danger)\b/i,
  /\b(?:less|not(?:\s+(?:very|that|so|too))?)\s+serious\b|\bnot\s+a\s+big\s+deal\b|\b(?:minor|trivial|negligible|harmless|innocent|innocuous)\b(?![- ]looking)/i,
  new RegExp(
    String.raw`\b(?:is|just|simply|only|merely)\s+(?:a|an)\s+(?:\w+\s+)?(?:normal|standard|routine|ordinary|typical|common|usual|everyday|regular|simple|basic)\b(?!\s+(?:\w+\s+)?(?:${SCAM})s?\b)`,
    'i',
  ),
  /\b(?:normal|standard|routine|ordinary|typical|usual|everyday)\s+(?:sign[- ]?in|login|log[- ]in|approval|permission|payment|transfer|request|signature|transaction|step)\b/i,
];

// What the words say about the kind of request.
const SIGN_IN_WORDS = /\b(?:signs?\s+you\s+in|logs?\s+you\s+in|sign(?:ing)?[- ]in|log(?:ging)?[- ]?in|proves?\s+(?:that\s+)?(?:you\s+own|the\s+wallet\s+is\s+yours|this\s+wallet\s+is\s+yours|wallet\s+ownership))\b/i;
const GRANTS = /\b(?:gives?|giving|grants?|granting|hands?)\s+(?:\w+\s+){0,3}?(?:access|permission|control|the\s+right)\b|\b(?:lets?|allows?|allowing|enables?)\s+(?:\w+\s+){0,3}?(?:to\s+)?(?:take|move|spend|use|transfer|pull)\b/i;
const PERMISSION_WORDS = /\b(?:permission|approval|allowance|authori[sz](?:e|es|ation)|take\s+(?:\w+\s+){0,3}?later)\b/i;

// What the words say about where assets go.
const INCOMING = [
  /\b(?:you|your\s+wallet|this\s+(?:address|wallet|account))\s+(?:would\s+|will\s+|could\s+|may\s+)?(?:also\s+)?(?:receive|gain|earn|collect)s?\b/i,
  /\b(?:come|comes|coming|arrive|arrives|land|lands|flow|flows)\s+(?:back\s+)?(?:in)?to\s+(?:you\b|your\s+(?:wallet|address|account)|this\s+(?:address|wallet|account))/i,
  /\b(?:come|comes|coming)\s+into\b/i,
  /\b(?:adds?|added|adding|deposits?|deposited|credits?|credited)\s+(?:\w+\s+){0,4}?(?:to|into|in)\s+(?:your|this)\s+(?:wallet|address|account)\b/i,
  /\b(?:sent|paid|transferred|given)\s+(?:back\s+)?to\s+you\b/i,
];
const OUTGOING = [
  /\b(?:takes?|taking|charges?|deducts?|removes?|sends?|moves?|pulls?|withdraws?|spends?|costs?)\s+(?:\w+\s+){0,4}?(?:out\s+of|from)\s+your\s+(?:wallet|account|balance)\b/i,
  /\b(?:leave|leaves|leaving)\s+your\s+(?:wallet|account)\b/i,
];

// Smaller than it is.
const SMALL = /\b(?:small|tiny|limited|capped|fixed|set|modest|certain|specific|restricted)\s+(?:amount|sum|number|portion|part|quantity)\b|\bcapped\b|\bup\s+to\s+a\s+(?:limit|cap|maximum)\b|\bwith\s+a\s+(?:limit|cap)\b|\bsome\s+of\s+(?:this|the|your)\b/i;
// "Once you confirm" is a conjunction, not "one time".
// "At once" means "right away".
const ONE_TIME = /\b(?:a\s+single\s+time|one\s+time|one-time|single[- ]use|one\s+use|used\s+up|only\s+once|just\s+once|(?<!\bat\s)once(?!\s+(?:you|it|this|that|signed|confirmed|approved|the|they|someone|anyone|submitted|used))|expires?\s+(?:right\s+away|immediately|soon|shortly|quickly)|for\s+a\s+short\s+(?:time|while)|temporar(?:y|ily))\b/i;
const LASTING = /\b(?:until\s+you\s+revoke|stays?\s+(?:active|in\s+place|valid)\s+until\s+you|forever|permanent(?:ly)?|again\s+and\s+again|repeatedly|as\s+many\s+times)\b/i;
const NOW_ONLY = /\bcurrently\b(?!\s+(?:or|and)\b)|\b(?:you|that\s+you)\s+(?:already\s+)?(?:hold|have|own)\s+(?:right\s+)?now\b(?!\s*,?\s*(?:or|and)\s)|\bat\s+the\s+moment\b|\balready\s+(?:hold|have|own)\b(?![^.]{0,40}\b(?:later|future)\b)/i;
const ONLY = /\b(?:only|just|merely|simply)\s+(?:gives?|lets?|allows?|grants?|sends?|approves?|moves?|a|an|this|the)\b|\bnothing\s+(?:more|else)\b/i;

/**
 * Whether the model's words contradict what code verified, or play it down.
 * @param {string} text
 * @param {object} result  the analyzer's result
 * @returns {{problem: string, detail: string}|null}
 */
export function contradicts(text, result, { advice = false } = {}) {
  const decoded = decodedReading(result);
  if (!decoded) return null;
  const s = result.subject || {};
  const one = (values, value) => values.length === 1 && values[0] === value;
  const fail = (problem, detail) => ({ problem, detail });

  for (const re of REASSURES) {
    const m = said(text, re);
    if (m) return fail('wording that plays down the risk', m);
  }

  // The kind of request.
  const action = decoded.action;
  if (!action.includes('sign_in') && !action.includes('sign_text')) {
    const m = said(text, SIGN_IN_WORDS);
    if (m) return fail('a different kind of request', m);
  }
  if (action.includes('remove_permission') || action.includes('sign_in') || action.includes('sign_text')) {
    const m = said(text, GRANTS, action.includes('remove_permission') ? UNDONE : null);
    if (m) return fail('a different kind of request', m);
  }
  if (one(action, 'payment') && s.fromSelf !== false) {
    const m = said(text, PERMISSION_WORDS) || said(text, GRANTS);
    if (m) return fail('a different kind of request', m);
  }

  // Where assets go.
  if (!decoded.direction.includes('into_your_wallet')) {
    for (const re of INCOMING) {
      const m = said(text, re);
      if (m) return fail('a different direction for the assets', m);
    }
  }
  if (!decoded.direction.includes('out_of_your_wallet')) {
    // A revoke is a transaction: its network fee does leave the wallet.
    const fee = (m) => /\b(?:fee|gas)\b/i.test(m) && (s.action === 'revoke' || s.action === 'revokeAll');
    for (const re of OUTGOING) {
      const m = said(text, re);
      if (m && !fee(m)) return fail('a different direction for the assets', m);
    }
  }

  // How much, how long, how many things.
  // (A thing to check may suggest a smaller amount: "would a capped amount do?")
  if (one(decoded.limit, 'unlimited') && !advice) {
    const m = said(text, SMALL);
    if (m) return fail('wording that makes it smaller than it is', m);
  }
  const once = s.action === 'permitTransfer' || (s.action === 'permit2Batch' && s.once);
  const lasting = ['approve', 'approveAll'].includes(s.action) || (s.action === 'permit2Batch' && !s.once);
  if (lasting && !/^only\b/.test(s.lasts || '')) {
    const m = said(text, ONE_TIME);
    if (m) return fail('wording that makes it smaller than it is', m);
  }
  if (once) {
    const m = said(text, LASTING);
    if (m) return fail('a different duration', m);
  }
  if (s.action === 'approveAll') {
    const m = said(text, NOW_ONLY);
    if (m) return fail('wording that makes it smaller than it is', m);
  }
  // Coins on top of a token call, or several actions: "only" leaves some out.
  if (!advice && (s.coins || (s.action === 'batch' && (s.actions || []).length > 1))) {
    const m = said(text, ONLY);
    if (m) return fail('wording that makes it smaller than it is', m);
  }
  return null;
}

// ── The whole check, as the window runs it ─────────────────────────────────

/** "who gains: you / decoded: another party; …": for tests and logs, never the window. */
const mismatchDetail = (mismatches) => mismatches.map((m) => `${m.field}: ${m.said} / decoded: ${m.decoded}`).join('; ');

/**
 * Gemini's answer to the short explanation, checked.
 * @param {string} text    the model's answer (the form, as JSON)
 * @param {object} result  the analyzer's result
 * @param {object} options
 * @param {string} options.sentence  the code's sentence on what confirming does (meaning())
 * @param {string[]} [options.own]   the user's own addresses
 * @param {number|null} [options.chainId]
 * @param {string} [options.host]    the site that asked
 * @param {number[]} [options.shown] the reason numbers the prompt showed
 * @returns {{checked: 'passed'|'note-withheld'|'withheld', note: string, top: number[],
 *   problem: string|null, detail: string}}
 *   passed: the note may be shown and the picked reasons marked;
 *   note-withheld: the reading matched, so the picks are marked, but the note is not shown;
 *   withheld: nothing from the model is shown.
 */
export function checkExplanation(text, result, { sentence = '', own = [], chainId = null, host = '', shown = null } = {}) {
  const answer = parseAnswer(text);
  if (!answer) return { checked: 'withheld', note: '', top: [], problem: 'no usable answer', detail: String(text || '').slice(0, 200) };
  const reading = checkReading(answer, result, { shown });
  if (!reading.match) {
    return {
      checked: 'withheld',
      note: '',
      top: [],
      problem: `a different reading of the request (${mismatchWords(reading.mismatches)})`,
      detail: mismatchDetail(reading.mismatches),
    };
  }
  const note = typeof answer.note === 'string' ? answer.note.trim() : '';
  const failed = wordsProblem(note, result, sentence, { own, chainId, host });
  if (failed) return { checked: 'note-withheld', note: '', top: reading.top, problem: failed.problem, detail: failed.detail };
  return { checked: 'passed', note, top: reading.top, problem: null, detail: '' };
}

/**
 * Gemini's deeper analysis, checked: its reading and the scam pattern it
 * names must match the decoded request, and its words may name nothing and
 * claim nothing that code can see is wrong. All of it is shown, or none of it.
 * @returns {{passed: boolean, summary?: string, checks?: string[], pattern?: string,
 *   problem?: string, detail?: string}}
 */
export function checkAnalysis(text, result, { sentence = '', own = [], chainId = null, host = '' } = {}) {
  const answer = parseAnswer(text);
  if (!answer) return { passed: false, problem: 'no usable answer', detail: String(text || '').slice(0, 200) };
  const reading = checkReading(answer, result, { deep: true });
  if (!reading.match) {
    return {
      passed: false,
      problem: `a different reading of the request (${mismatchWords(reading.mismatches)})`,
      detail: mismatchDetail(reading.mismatches),
    };
  }
  const summary = typeof answer.summary === 'string' ? answer.summary.trim() : '';
  // A list number the model puts in front ("1. Verify …") is not part of the advice.
  const checks = (Array.isArray(answer.checks) ? answer.checks : [])
    .slice(0, 3)
    .map((item) => String(item).replace(/^\s*\d{1,2}[.)]\s+/, '').trim())
    .filter(Boolean);
  for (const piece of [summary, ...checks]) {
    const failed = wordsProblem(piece, result, sentence, { own, chainId, host, advice: piece !== summary });
    if (failed) return { passed: false, problem: failed.problem, detail: failed.detail };
  }
  return { passed: true, summary, checks, pattern: answer.pattern };
}
