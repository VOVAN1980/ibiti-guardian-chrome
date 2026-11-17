// What Gemini contributes to Guardian's window, as data that code can check.
//
// Nothing Gemini writes is shown as text. Free text cannot be checked for
// meaning: "the spender gets permission" and "you get permission" differ by
// a word, and blind tests showed every new wording slipping past new rules.
// So the window shows only words written by code, and Gemini answers a form:
//
//   action     what kind of request this is
//   who_gains  who could move or receive the user's assets
//   direction  which way the user's own assets can move
//   limit      unlimited, limited, or not a matter of amount
//   reasons    which of the analyzer's reasons matter most (by number)
//
// Gemini reads the decoded facts, but not the code's sentence on what
// confirming does: its reading is its own. Code compares every field with
// what the analyzer decoded. If they agree, the window says so, in code's
// words, and lists the reasons Gemini picked (the analyzer's own text). If
// any field differs, nothing from Gemini is shown, whatever it would have
// said. A swap of roles or direction is a wrong value in a field.
//
// The deeper analysis answers the same reading, plus a scam pattern and the
// things to check, each picked from a fixed list written here. Code checks
// that the request has what the pattern and each check are about.

import { isUndecoded } from './guard.js';

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
  },
  required: ['action', 'who_gains', 'direction', 'limit', 'reasons'],
  additionalProperties: false,
};

// ── What the analyzer decoded, in the form's terms ─────────────────────────

const sub = (r) => r.subject || {};
const partsOf = (r) => (r.kind === 'batch' ? r.parts || [] : [r]);
const has = (r, ...actions) => partsOf(r).some((p) => actions.includes(sub(p).action));
const tokensOf = (r) => {
  const s = sub(r);
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
  if (reading && sub(result).coins) return { ...reading, who_gains: OTHER, direction: OUT };
  return reading;
}

function readingOf(result) {
  const s = sub(result);
  switch (s.action) {
    case 'approve':
      return field(['spending_permission'], OTHER, OUT, [s.unlimited ? 'unlimited' : 'limited']);
    case 'permitTransfer':
      // One-time: the spender takes the amount once. Either word fits it.
      return field(['spending_permission', 'payment'], OTHER, OUT, [s.unlimited ? 'unlimited' : 'limited']);
    case 'permit2Batch': {
      // Unlimited if any token in it is: "limited" would hide that one.
      const any = (s.actions || []).some((a) => a && a.unlimited);
      return field(s.once ? ['spending_permission', 'payment'] : ['spending_permission'], OTHER, OUT, any ? ['unlimited'] : ['limited']);
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

// ── The deeper analysis: a pattern and things to check, from fixed lists ───

// Scam patterns the deeper analysis may name. The model picks one; code
// checks that the request has what the pattern is about, and the label the
// user reads is written here.
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
    fits: (r) => r.kind === 'signIn' && Boolean(sub(r).mismatch),
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

const PERMISSIONS = ['approve', 'permitTransfer', 'permit2Batch'];
const LASTING = (r) => partsOf(r).some((p) => ['approve', 'approveAll'].includes(sub(p).action) || (sub(p).action === 'permit2Batch' && !sub(p).once));

const personal = (r) => partsOf(r).some((p) => (p.facts || []).some((f) => f.note === 'personal wallet'));

// Things to check, for the deeper analysis. The model picks two or three;
// each must be about something this request has. Some are shown by code
// whatever the model picks (`must`): the model may add to them, never drop them.
export const CHECKS = {
  who_is_the_spender: {
    text: 'Find out who the spender is, and whether it is the service you meant to use.',
    fits: (r) => has(r, ...PERMISSIONS),
    must: (r) => has(r, ...PERMISSIONS) && personal(r),
  },
  who_is_the_operator: {
    text: 'Find out who the operator is, and whether it is the marketplace you meant to use.',
    fits: (r) => has(r, 'approveAll'),
    must: (r) => has(r, 'approveAll') && personal(r),
  },
  is_the_amount_needed: {
    text: 'Ask whether it needs more than the amount you mean to spend now.',
    fits: (r) => has(r, ...PERMISSIONS),
  },
  is_the_token_real: {
    text: 'Check that the token is the real one: its contract address should be the official one on this network.',
    fits: (r) => partsOf(r).some((p) => tokensOf(p).some((t) => t && !t.verified)),
    must: (r) => partsOf(r).some((p) => tokensOf(p).some((t) => t && t.impersonates)),
  },
  revoke_when_done: {
    text: 'If you do confirm, revoke the permission once you no longer need it.',
    fits: LASTING,
  },
  how_long_it_is_valid: {
    text: 'Note how long the signature stays valid: whoever holds it can use it until then.',
    fits: (r) => r.kind === 'permit' || r.kind === 'permit2',
  },
  check_the_recipient: {
    text: 'Compare the recipient’s address, character by character, with the address you meant to pay.',
    fits: (r) => has(r, 'transfer', 'nativeTransfer'),
    must: (r) => has(r, 'transfer', 'nativeTransfer'),
  },
  payments_are_final: {
    text: 'Remember that a confirmed payment cannot be undone.',
    fits: (r) => has(r, 'transfer', 'nativeTransfer'),
  },
  which_permission: {
    text: 'Check that this is the permission you meant to remove.',
    fits: (r) => has(r, 'revoke', 'revokeAll'),
  },
  compare_the_sites: {
    text: 'Compare the site named in the message, letter by letter, with the site in your address bar.',
    fits: (r) => r.kind === 'signIn',
    must: (r) => r.kind === 'signIn' && Boolean(sub(r).mismatch),
  },
  read_the_whole_text: {
    text: 'Read the whole message before you sign it: sign only what you agree with.',
    fits: (r) => r.kind === 'signIn' || r.kind === 'message',
  },
  what_the_order_gives: {
    text: 'Check, in the marketplace itself, what this order gives away and what you get for it.',
    fits: (r) => r.kind === 'order',
  },
  each_action: {
    text: 'Go through every action in the list: one confirmation carries out all of them.',
    fits: (r) => r.kind === 'batch',
  },
  why_coins_attached: {
    text: 'Ask why coins are attached: this kind of request never needs them.',
    fits: (r) => partsOf(r).some((p) => Boolean(sub(p).coins)),
    must: (r) => partsOf(r).some((p) => Boolean(sub(p).coins)),
  },
  did_you_start_this: {
    text: 'Ask whether you started this on the site yourself, and why the site would need it.',
    fits: () => true,
  },
};

/** The deeper analysis's form. */
export const DEEP_SCHEMA = {
  type: 'object',
  properties: {
    ...READING_PROPERTIES,
    pattern: { type: 'string', enum: Object.keys(PATTERNS) },
    checks: { type: 'array', items: { type: 'string', enum: Object.keys(CHECKS) }, maxItems: 3 },
  },
  required: ['action', 'who_gains', 'direction', 'limit', 'pattern', 'checks'],
  additionalProperties: false,
};

// ── How to fill the forms in: part of the prompts ───────────────────────────

// Rules for every request, not answers for this one. Measured on Gemini Nano
// in Chrome (2026-11-17, demo requests): with one-line definitions it read 4
// of 9 right, with these 6 of 9 (giving it the code's sentence did not help).
// The cloud model read 27 of 27 right. A wrong reading is never used.
export const READING_GUIDE = [
  `- action: what kind of request this is: ${ACTIONS.join(', ')}. A transfer or "Send" is a payment; an approval or permit is a spending_permission; "Approval for all" (every item in a collection) is collection_access; "Revoke" is remove_permission; several_actions only for a list of actions.`,
  '- who_gains: another_party if someone other than the user could take, move or receive the user\'s assets, or use the signature as the user; you only if assets would come to the user; nobody if no assets can move (signing in, signing text, removing a permission).',
  '- direction: out_of_your_wallet if the user\'s assets can leave, now or later through a permission; into_your_wallet only if assets would come to the user; nothing_moves when signing in, signing text or removing a permission.',
  '- limit: unlimited if the facts say Unlimited, all items, or any amount (for several tokens or actions: if any of them is); limited if there is a fixed amount, as in a payment; does_not_apply when signing in, signing text or removing a permission.',
].join('\n');
export const REASONS_GUIDE =
  '- reasons: the numbers of the one or two most important lines under "Why it matters", most important first.';
export const PATTERN_GUIDE = `- pattern: a known wallet-scam pattern this request has the shape of (${Object.keys(PATTERNS)
  .filter(KNOWN)
  .join(', ')}); no_known_pattern if it matches none (that does not make it safe); cannot_determine if the facts are not enough to tell.`;
export const CHECKS_GUIDE = [
  '- checks: the two or three things the user should verify before deciding, most important first, from this list (answer the names):',
  ...Object.entries(CHECKS).map(([id, c]) => `  ${id}: ${c.text}`),
].join('\n');

// ── Checking an answer ──────────────────────────────────────────────────────

const PLAIN = { action: 'what it is', who_gains: 'who gains', direction: 'which way assets move', limit: 'the limit', pattern: 'the scam pattern', checks: 'what to check' };
const words = (value) => String(value).replace(/_/g, ' ');

/**
 * Compares the model's reading with the analyzer's.
 * @param {object} answer  the model's form, parsed
 * @param {object} result  the analyzer's result
 * @param {object} [options]
 * @param {number[]} [options.shown]  reason numbers the model was shown (1-based)
 * @param {boolean} [options.deep]    the deeper analysis: also checks the pattern and the checks
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
    // A known scam pattern must be one this request has the shape of: never
    // on a request Guardian found no red flags in, and on a high-risk one the
    // model may not say that none matched.
    const knownFits = Object.keys(PATTERNS).some((p) => KNOWN(p) && PATTERNS[p].fits(result));
    if (
      !known ||
      !PATTERNS[pattern].fits(result) ||
      (KNOWN(pattern) && result.risk === 'info') ||
      (!KNOWN(pattern) && result.risk === 'danger' && knownFits)
    ) {
      mismatches.push({ field: PLAIN.pattern, said: words(pattern || 'nothing'), decoded: 'a pattern this request does not have' });
    }
    const checks = Array.isArray(a.checks) ? a.checks : [];
    const wrong = checks.filter((id) => !Object.prototype.hasOwnProperty.call(CHECKS, id) || !CHECKS[id].fits(result));
    if (checks.length === 0 || wrong.length > 0) {
      mismatches.push({ field: PLAIN.checks, said: words(wrong.join(', ') || 'nothing'), decoded: 'things this request has' });
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

/** "who gains: you / decoded: another party; …": for tests and logs, never the window. */
const mismatchDetail = (mismatches) => mismatches.map((m) => `${m.field}: ${m.said} / decoded: ${m.decoded}`).join('; ');

// The window's words for a verified reading.
const SAYS = {
  action: {
    spending_permission: 'a spending permission',
    collection_access: 'access to a whole collection',
    payment: 'a payment',
    remove_permission: 'removing a permission',
    sign_in: 'a sign-in',
    sign_text: 'signing a text',
    marketplace_order: 'a marketplace order',
    several_actions: 'several actions at once',
  },
  who_gains: { another_party: 'someone else gains', you: 'you gain', nobody: 'nobody gains' },
  direction: { out_of_your_wallet: 'out of your wallet', into_your_wallet: 'into your wallet', nothing_moves: 'nothing moves' },
  limit: { unlimited: 'unlimited', limited: 'limited', does_not_apply: null },
};

/** "a spending permission · someone else gains · out of your wallet · unlimited" */
export function readingWords(answer) {
  return ['action', 'who_gains', 'direction', 'limit']
    .map((name) => SAYS[name][answer[name]])
    .filter(Boolean)
    .join(' · ');
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

/**
 * Gemini's answer to the short explanation, checked.
 * @param {string} text    the model's answer (the form, as JSON)
 * @param {object} result  the analyzer's result
 * @param {object} [options]
 * @param {number[]} [options.shown] the reason numbers the prompt showed
 * @returns {{checked: 'passed'|'withheld', words: string, top: number[], problem: string|null, detail: string}}
 *   passed: the window says Gemini agrees (`words`, written here) and lists
 *   the reasons it picked; withheld: nothing from the model is shown.
 */
export function checkExplanation(text, result, { shown = null } = {}) {
  const answer = parseAnswer(text);
  if (!answer) return { checked: 'withheld', words: '', top: [], problem: 'no usable answer', detail: String(text || '').slice(0, 200) };
  const reading = checkReading(answer, result, { shown });
  if (!reading.match) {
    return {
      checked: 'withheld',
      words: '',
      top: [],
      problem: `a different reading of the request (${mismatchWords(reading.mismatches)})`,
      detail: mismatchDetail(reading.mismatches),
    };
  }
  return { checked: 'passed', words: readingWords(answer), top: reading.top, problem: null, detail: '' };
}

/**
 * Gemini's deeper analysis, checked: its reading, the scam pattern it names
 * and the things it picks to check must all fit the decoded request. All of
 * it is shown, in code's words, or none of it.
 * @returns {{passed: boolean, words?: string, pattern?: string, label?: string, checks?: {text: string, by: string}[],
 *   problem?: string, detail?: string}}
 */
export function checkAnalysis(text, result) {
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
  return {
    passed: true,
    words: readingWords(answer),
    pattern: answer.pattern,
    label: PATTERNS[answer.pattern].label,
    // Code's own checks first (marked), then the model's picks.
    checks: checksFor(result, answer.checks).map((id) => ({
      text: CHECKS[id].text,
      by: CHECKS[id].must && CHECKS[id].must(result) ? 'guardian' : 'gemini',
    })),
  };
}

/**
 * The things to check the window lists: the ones code always shows for this
 * request, then the model's picks, in its order.
 */
export function checksFor(result, picked = []) {
  const must = Object.keys(CHECKS).filter((id) => CHECKS[id].must && CHECKS[id].must(result));
  return [...new Set([...must, ...picked])];
}

/**
 * The reasons the window lists as most important: the analyzer's warnings
 * first, always (an AI may not hide them), then the model's picks.
 * @returns {{n: number, text: string, by: 'guardian'|'gemini'}[]}
 */
export function mostImportant(result, top = []) {
  const warnings = new Set(result.warnings || []);
  const out = result.reasons.map((text, i) => ({ n: i + 1, text, by: 'guardian' })).filter((r) => warnings.has(r.text));
  for (const n of top) {
    if (!out.some((r) => r.n === n)) out.push({ n, text: result.reasons[n - 1], by: 'gemini' });
  }
  return out;
}
