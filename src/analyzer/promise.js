// What the page promised against what the request does.
//
// Drainers rarely ask for a permission in so many words: the button says
// "Claim airdrop" or "Verify wallet", and the request it sends gives someone
// the right to take tokens. Guardian keeps the words of the button the user
// pressed just before the request (src/inpage.js) and compares what they
// offer with what the analyzer decoded.
//
// Code reads plain offers itself, from fixed words; Gemini can read the
// unclear ones (src/ai/reading.js). Only a clear contradiction is a warning:
// a button that offers to receive something, to sign in, or to remove a
// permission, on a request that moves the user's assets out or grants a
// permission (a sign-in or a revoke also on coins sent to a contract call
// Guardian cannot read or to a new contract, and a revoke on a request that
// removes no permission); or a mint, swap, payment or stake that asks for
// every item in a collection. approve(spender, 0) on a contract that may be
// an NFT collection is a revoke or a permission for item #0: a revoke fits it.

// The offers code can read from a button's words. A button may name more
// than one ("Approve and claim"): all of them count, and only a button whose
// every offer contradicts the request is a warning. The first is the one
// shown.
//
// Only verbs approve. "Approve" and "authorize" do anywhere; the verbs that
// have other meanings too do only at the start of the button or of a clause
// ("Enable USDC", "Claim and sell"), not inside a lure ("Claim grant",
// "You're on the list! Claim"). Nouns never do: "Connect wallet to check
// approvals" offers a sign-in, "Revoke approval" offers to revoke.
const CLAUSE = String.raw`(?:^\W*|[&,;:+/|·•(]\s*|\b(?:and|then|to)\s+|\d[.)]\s*)`;
const WEAK_APPROVE = new RegExp(String.raw`${CLAUSE}(?:grant|enable|allow|unlock|list|sell|permit)\b`, 'i');
const STRONG_APPROVE = /\b(?:approve|authori[sz]e)\b/i;
export const OFFERS = {
  receive: {
    words: /\b(?:claim|airdrop|reward|rewards|bonus|free|giveaway|receive|get\s+(?:your|free|my)|prize|refund|eligib\w*)\b/i,
    label: 'receive something',
  },
  revoke: {
    words: /(?<!\b(?:can|may|could|will)\s)\b(?:revoke|disconnect|(?:remove|cancel|clear|reset|clean\s+up)\s+(?:\S+\s+){0,3}?(?:access|approvals?|permissions?|allowances?|permits?))\b/i,
    label: 'remove a permission',
  },
  sign_in: {
    words: /\b(?:sign[\s-]?in|log[\s-]?in|connect(?:\s+wallet)?|verify(?:\s+(?:wallet|ownership|account|eligibility))?|authenticate|confirm\s+ownership)\b/i,
    label: 'sign in or verify the wallet',
  },
  mint: { words: /\bmint\b/i, label: 'mint' },
  swap: { words: /\b(?:swap|exchange|trade|buy|bridge)\b/i, label: 'swap or buy' },
  pay: { words: /\b(?:pay|send|donate|deposit|checkout|purchase|tip|transfer)\b/i, label: 'pay' },
  stake: { words: /\b(?:stake|unstake|farm|lock)\b/i, label: 'stake' },
  approve: { words: new RegExp(`${STRONG_APPROVE.source}|${WEAK_APPROVE.source}`, 'i'), label: 'approve or list' },
};
export const OFFER_KINDS = Object.keys(OFFERS);

// Words that may offer something for a price ("Redeem", "Collect", "Enter to
// win"): redeeming shares, a paid edition or a paid entry can rightly need a
// token permission. Code reads them only against a marketplace order for the
// user's own items, which no purchase needs; otherwise Gemini judges them.
const MAYBE_PAID = /\b(?:redeem|collect|win)\b/i;

const MAX = 80;
// Addresses in the site's words, whole or shortened ("0x71C7…976F"), go
// before anything is cut short: a cut one could not be recognised as the
// user's own any more (src/inpage.js does the same before it cuts).
const ADDRESS = /0x[0-9a-fA-F]{2,}(?:[.…·•⋯‥*]+|-{2,})[0-9a-fA-F]{2,}|0x[0-9a-fA-F]{4,}|\b[0-9a-fA-F]{40}\b/g;
const clean = (value) =>
  typeof value === 'string'
    ? value
        .slice(0, 2000)
        // Letters drawn another way (full-width, ligatures) as the plain
        // ones, and no invisible characters (zero-width, soft hyphen,
        // direction marks): they could split a word code reads, or an address.
        .normalize('NFKC')
        .replace(/\p{Cf}/gu, '')
        .replace(ADDRESS, 'an address')
        .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, MAX)
    : '';

/**
 * The page's promise as the in-page guard saw it, checked: the words of the
 * button pressed just before the request, the page title and the nearest
 * heading, each short and plain. Null when no button was pressed.
 */
export function cleanPromise(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const button = clean(raw.button);
  if (!button) return null;
  const ageMs = Number(raw.ageMs);
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > 15000) return null;
  return { button, title: clean(raw.title), heading: clean(raw.heading), ageMs: Math.round(ageMs) };
}

// Cyrillic and Greek letters that look like Latin ones ("Clаim" with a
// Cyrillic а), each followed by the Latin letter it imitates.
const LOOKALIKES =
  'аaвbеeёeкkмmнhоoрpсcтtуyхxіiїiјjѕsԁdӏlһhԛqԝwАaВbЕeКkМmНhОoРpСcТtУyХxІiЈjЅsԀdӀlҺhԚqԜwαaιiκkνvοoρpτtυuχxεeΑaΒbΕeΗhΙiΚkΜmΝnΟoΡpΤtΥyΧxΖz';
const LOOKALIKE = new Map(Array.from({ length: LOOKALIKES.length / 2 }, (_, i) => [LOOKALIKES[2 * i], LOOKALIKES[2 * i + 1]]));

/**
 * A button's words as code reads them: lookalike letters as the Latin ones
 * they imitate, but only where they imitate Latin (in a word that mixes them
 * with Latin letters, or in a button with no other non-Latin letters), so
 * "Получить бонус" stays as it is.
 */
function readable(button) {
  const text = String(button);
  const otherScript = Array.from(text).some((ch) => /\p{L}/u.test(ch) && !/\p{Script=Latin}/u.test(ch) && !LOOKALIKE.has(ch));
  return text.replace(/\p{L}+/gu, (word) => {
    const mixed = /\p{Script=Latin}/u.test(word) && Array.from(word).some((ch) => LOOKALIKE.has(ch));
    return mixed || !otherScript ? Array.from(word, (ch) => LOOKALIKE.get(ch) || ch).join('') : word;
  });
}

/** Every offer code reads in a button's words, in the list's order. */
export function offersOf(button) {
  const text = readable(button);
  return Object.entries(OFFERS)
    .filter(([, offer]) => offer.words.test(text))
    .map(([kind]) => kind);
}

/** The first offer code reads in a button's words, or null if unclear. */
export function offerOf(button) {
  return offersOf(button)[0] || null;
}

const sub = (r) => r.subject || {};
const partsOf = (r) => (r.kind === 'batch' ? r.parts || [] : [r]);
const GRANTS = new Set(['approve', 'permitTransfer', 'permit2Batch', 'approveAll']);
// approve(spender, 0) on a contract that may be an NFT collection: a revoke,
// or a permission for item #0 (src/analyzer/index.js). An offer to revoke
// fits it; an offer to receive something or to sign in does not.
const maybeRevoke = (p) => Boolean(sub(p).itemZero);

/**
 * Whether the request moves the user's assets out, now or through a
 * permission. `revoking`: against an offer to revoke, where a part that may
 * be a revoke does not count (unless it sends coins).
 */
function takesOut(r, { revoking = false } = {}) {
  return partsOf(r).some((p) => {
    const s = sub(p);
    if (s.coins) return true;
    if (revoking && maybeRevoke(p)) return false;
    if (GRANTS.has(s.action) || s.action === 'marketOrder') return true;
    if ((s.action === 'transfer' || s.action === 'nativeTransfer') && !s.empty && s.fromSelf !== false) return true;
    return false;
  });
}

/**
 * Whether the request removes no permission while it touches one: an
 * increaseAllowance of 0 adds nothing, and a fake revoke page may send it.
 */
function removesNothing(r) {
  const parts = partsOf(r);
  return (
    parts.some((p) => sub(p).action === 'noChange') &&
    !parts.some((p) => ['revoke', 'revokeAll'].includes(sub(p).action) || maybeRevoke(p))
  );
}

/** Whether the request sends coins to a contract call Guardian cannot read, or to a new contract. */
function paysUnknownCall(r) {
  return partsOf(r).some((p) => ['contractCall', 'deploy'].includes(sub(p).action) && Boolean(sub(p).sends));
}

/** Whether the request is a permission or a marketplace order. */
function grantsOrLists(r) {
  return partsOf(r).some((p) => GRANTS.has(sub(p).action) || sub(p).action === 'marketOrder');
}

/** What the request does, in a few words, for the warning. */
export function whatItDoes(r) {
  const s = sub(r);
  const symbol = s.token && s.token.symbol ? s.token.symbol : 'a token';
  if (s.coins) return `sends ${s.coins} to a contract`;
  switch (s.action) {
    case 'contractCall':
      return s.sends ? `sends ${s.sends} to a contract call Guardian cannot read` : 'calls a contract Guardian cannot read';
    case 'deploy':
      return s.sends ? `sends ${s.sends} to a new contract it creates` : 'creates a new contract';
    case 'approve':
      if (s.itemZero) return 'may give someone your item #0, if this contract is an NFT collection';
      // An NFT permit: one item of a collection.
      if (s.item) return `gives someone permission to take your item #${s.item} out of your wallet`;
      return s.unlimited
        ? `gives someone permission to take any amount of ${symbol} out of your wallet`
        : `gives someone permission to take ${symbol} out of your wallet`;
    case 'noChange':
      return 'removes no permission';
    case 'permitTransfer':
    case 'permit2Batch':
      return 'lets someone take tokens out of your wallet';
    case 'approveAll':
      return 'gives someone access to every item you own in a collection';
    case 'transfer':
    case 'nativeTransfer':
      return s.authorization ? `lets someone move ${s.amount} out of your wallet` : `sends ${s.amount} out of your wallet`;
    case 'marketOrder':
      return 'signs a marketplace order for your items';
    case 'batch':
      return takesOut(r) || !removesNothing(r)
        ? 'carries out several actions, including one that moves assets out of your wallet'
        : 'carries out several actions, none of which removes a permission';
    default:
      return 'does something else';
  }
}

/** Whether one offer contradicts the decoded request. */
function clashes(offer, result) {
  const out = takesOut(result);
  const collection = partsOf(result).some((p) => sub(p).action === 'approveAll');
  // A claim may cost a fee to a contract; a sign-in or a revoke never sends coins.
  if (offer === 'receive') return out;
  if (offer === 'sign_in') return out || paysUnknownCall(result);
  if (offer === 'revoke') {
    // Revoking is one of the two readings of approve(spender, 0): only the
    // other parts count. A request that removes nothing is no revoke either.
    return takesOut(result, { revoking: true }) || paysUnknownCall(result) || removesNothing(result);
  }
  if (['mint', 'swap', 'pay', 'stake'].includes(offer)) return collection;
  return false;
}

/**
 * Whether what a button offers contradicts the decoded request: only when
 * every offer read in it does ("Approve and claim" names the permission, so
 * it does not). A word for a permission counts only on a request that is
 * one: "Unlock rewards" on a plain transfer approves nothing. `offers`: one
 * offer or a list. Returns code's sentence, or null.
 */
export function contradiction(offers, result, button) {
  const named = (Array.isArray(offers) ? offers : [offers]).filter((o) => OFFERS[o]);
  const list = grantsOrLists(result) ? named : named.filter((o) => o !== 'approve');
  if (list.length === 0 || !list.every((o) => clashes(o, result))) return null;
  return `The button you pressed said ${quote(button)}, an offer to ${OFFERS[list[0]].label}, but this request ${whatItDoes(result)}.`;
}

/**
 * What code reads in the button the user pressed, against this request: every
 * offer, the one shown, and code's warning. The offer is null where code is
 * not sure, so that Gemini may judge the words instead: "Unlock rewards" on a
 * payment (unlocking may mean paying for something), or "Redeem" on a token
 * permission.
 */
export function readButton(button, result) {
  let offers = offersOf(button);
  const words = readable(button);
  if (offers.length === 0 && MAYBE_PAID.test(words)) {
    if (!partsOf(result).some((p) => sub(p).action === 'marketOrder')) return { offers, offer: null, clash: null };
    offers = ['receive'];
  }
  if (offers.includes('approve') && !STRONG_APPROVE.test(words) && !grantsOrLists(result)) {
    return { offers, offer: null, clash: null };
  }
  return { offers, offer: offers[0] || null, clash: contradiction(offers, result, button) };
}

/** A button's words in quotes; its own double quotes become single ones. */
export function quote(button) {
  const inner = String(button)
    .replace(/"([^"]*)"/g, '‘$1’')
    .replace(/“/g, '‘')
    .replace(/[”"]/g, '’');
  return `“${inner}”`;
}
