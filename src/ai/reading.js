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

import { answerChecker, isUndecoded } from './guard.js';

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
    fits: (r) => r.kind === 'batch' && (r.parts || []).some((p) => p.risk === 'danger'),
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
  '- limit: for a spending permission, unlimited or limited; for a payment, limited; for access to a whole collection, unlimited; otherwise does_not_apply.',
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
      const all = (s.actions || []).every((a) => a && a.unlimited);
      const any = (s.actions || []).some((a) => a && a.unlimited);
      return field(
        s.once ? ['spending_permission', 'payment'] : ['spending_permission'],
        OTHER,
        OUT,
        all ? ['unlimited'] : any ? ['unlimited', 'limited'] : ['limited'],
      );
    }
    case 'approveAll':
      return field(['collection_access'], OTHER, OUT, ['unlimited', 'does_not_apply']);
    case 'transfer':
    case 'nativeTransfer': {
      if (s.empty) return field(['payment'], ['nobody', 'another_party'], ['nothing_moves'], ['does_not_apply', 'limited']);
      const limit = ['limited', 'does_not_apply'];
      if (s.fromSelf === false) {
        // Someone else's tokens, moved with their permission.
        return s.toSelf
          ? field(['payment'], ['you'], ['into_your_wallet'], limit)
          : field(['payment'], OTHER, ['nothing_moves'], limit);
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
      return field(['several_actions'], leaves ? OTHER : ['nobody'], leaves ? OUT : ['nothing_moves'], LIMITS);
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
  const name = namesIn(t);
  if (name) return { problem: 'a name, number or address of its own', detail: name };
  const verdict = answerChecker(result, codeSentence, options).finish(t);
  return verdict.problem ? { problem: verdict.problem, detail: verdict.detail || '' } : null;
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
    const failed = wordsProblem(piece, result, sentence, { own, chainId, host });
    if (failed) return { passed: false, problem: failed.problem, detail: failed.detail };
  }
  return { passed: true, summary, checks, pattern: answer.pattern };
}
