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
// permission; or a mint, swap, payment or stake that asks for every item in
// a collection.

// The offers code can read from a button's words. Order matters: the first
// that matches wins ("Claim and stake" is a claim).
export const OFFERS = {
  receive: {
    words: /\b(?:claim|airdrop|reward|rewards|bonus|free|giveaway|redeem|collect|receive|get\s+(?:your|free|my)|win|prize|refund)\b/i,
    label: 'receive something',
  },
  revoke: { words: /\b(?:revoke|disconnect|remove\s+(?:access|approval|permission)|cancel\s+approval)\b/i, label: 'remove a permission' },
  sign_in: {
    words: /\b(?:sign[\s-]?in|log[\s-]?in|connect(?:\s+wallet)?|verify(?:\s+(?:wallet|ownership|account|eligibility))?|authenticate|confirm\s+ownership)\b/i,
    label: 'sign in or verify the wallet',
  },
  mint: { words: /\bmint\b/i, label: 'mint' },
  swap: { words: /\b(?:swap|exchange|trade|buy|bridge)\b/i, label: 'swap or buy' },
  pay: { words: /\b(?:pay|send|donate|deposit|checkout|purchase|tip|transfer)\b/i, label: 'pay' },
  stake: { words: /\b(?:stake|unstake|farm|lock)\b/i, label: 'stake' },
  approve: { words: /\b(?:approve|enable|allow|unlock|list|sell)\b/i, label: 'approve or list' },
};
export const OFFER_KINDS = Object.keys(OFFERS);

const MAX = 80;
const clean = (value) =>
  typeof value === 'string'
    ? value
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

/** What a button's words offer, as code reads them, or null if unclear. */
export function offerOf(button) {
  for (const [kind, offer] of Object.entries(OFFERS)) if (offer.words.test(button)) return kind;
  return null;
}

const sub = (r) => r.subject || {};
const partsOf = (r) => (r.kind === 'batch' ? r.parts || [] : [r]);
const GRANTS = new Set(['approve', 'permitTransfer', 'permit2Batch', 'approveAll']);

/** Whether the request moves the user's assets out, now or through a permission. */
function takesOut(r) {
  return partsOf(r).some((p) => {
    const s = sub(p);
    if (s.coins) return true;
    if (GRANTS.has(s.action) || s.action === 'marketOrder') return true;
    if ((s.action === 'transfer' || s.action === 'nativeTransfer') && !s.empty && s.fromSelf !== false) return true;
    return false;
  });
}

/** What the request does, in a few words, for the warning. */
export function whatItDoes(r) {
  const s = sub(r);
  const symbol = s.token && s.token.symbol ? s.token.symbol : 'a token';
  if (s.coins) return `sends ${s.coins} to a contract`;
  switch (s.action) {
    case 'approve':
      return s.unlimited
        ? `gives someone permission to take any amount of ${symbol} out of your wallet`
        : `gives someone permission to take ${symbol} out of your wallet`;
    case 'permitTransfer':
    case 'permit2Batch':
      return 'lets someone take tokens out of your wallet';
    case 'approveAll':
      return 'gives someone access to every item you own in a collection';
    case 'transfer':
    case 'nativeTransfer':
      return `sends ${s.amount} out of your wallet`;
    case 'marketOrder':
      return 'signs a marketplace order for your items';
    case 'batch':
      return 'carries out several actions, including one that moves assets out of your wallet';
    default:
      return 'does something else';
  }
}

/**
 * Whether an offer contradicts the decoded request. Returns the code's
 * sentence about it, or null.
 */
export function contradiction(offer, result, button) {
  if (!offer) return null;
  const out = takesOut(result);
  const grants = partsOf(result).some((p) => GRANTS.has(sub(p).action));
  const collection = partsOf(result).some((p) => sub(p).action === 'approveAll');
  let clash = false;
  if (offer === 'receive' || offer === 'sign_in') clash = out;
  else if (offer === 'revoke') clash = out || grants;
  else if (['mint', 'swap', 'pay', 'stake'].includes(offer)) clash = collection;
  if (!clash) return null;
  return `The button you pressed said ${quote(button)}, an offer to ${OFFERS[offer].label}, but this request ${whatItDoes(result)}.`;
}

/** A button's words in quotes; its own double quotes become single ones. */
export function quote(button) {
  const inner = String(button)
    .replace(/"([^"]*)"/g, '‘$1’')
    .replace(/“/g, '‘')
    .replace(/[”"]/g, '’');
  return `“${inner}”`;
}
