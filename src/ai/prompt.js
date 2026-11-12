// Prompts are built only from the analyzer's facts. The model explains; it
// never decides what the request is or how risky it is, and the user's own
// wallet address is never part of a prompt.

function factLines(result) {
  return result.facts
    .filter((f) => f.label !== 'From') // may be the user's own address
    .map((f) => `- ${f.label}: ${f.value}${f.note ? ` (${f.note})` : ''}`)
    .join('\n');
}

// Small models read "Guardian does not recognise X" as an address named
// Guardian; prompts say "unknown" instead.
const plainReason = (text) =>
  text.replace(/Guardian does not recognise the (\w+) address\./g, 'The $1 address is unknown.');

function reasonLines(result) {
  return result.reasons.map((r) => `- ${plainReason(r)}`).join('\n');
}

/**
 * One exact sentence on who would be allowed to do what, written by code from
 * the analyzer's result. Small models mix up the roles in an approval (they
 * tend to say the user's wallet gets the permission); this line states them,
 * and the model only has to put it in plain words.
 */
export function meaning(result, host) {
  const s = result.subject || {};
  const note = (label) => (result.facts.find((f) => f.label === label) || {}).note;
  const symbol = (s.token && s.token.symbol) || 'this token';
  if (s.action === 'approve') {
    const who = s.spenderName
      ? `${s.spenderName}, a well-known service,`
      : `an unknown address${note('Spender') ? ` (a ${note('Spender')})` : ''}, not you,`;
    const what = s.amount === 'Unlimited' ? `any amount of ${symbol}` : `up to ${s.amount}`;
    return `If you confirm, ${who} gets permission to take ${what} out of your wallet, at any time, without asking you again, until you revoke it.`;
  }
  if (s.action === 'approveAll') {
    const who = s.operatorName ? `${s.operatorName}, a well-known service,` : 'an unknown address, not you,';
    return `If you confirm, ${who} gets permission to move every item you own in this collection, now or later, until you revoke it.`;
  }
  if (s.action === 'revoke' || s.action === 'revokeAll') {
    return 'If you confirm, an existing permission is removed. Nothing leaves your wallet.';
  }
  if (s.action === 'transfer' || s.action === 'nativeTransfer') {
    return `If you confirm, ${s.amount} leaves your wallet and goes to ${s.to}.`;
  }
  if (s.action === 'signIn') {
    return s.mismatch
      ? `If you confirm, you sign a sign-in message for ${s.domain}, but the request comes from ${host}, a different site.`
      : `If you confirm, you sign in to ${s.domain}. Nothing leaves your wallet.`;
  }
  if (result.kind === 'blindSign') {
    return 'If you confirm, you sign data that cannot be read. Such a signature can authorise anything.';
  }
  return '';
}

const RISK_WORDS = {
  danger: 'high risk',
  caution: 'needs a careful look',
  info: 'no red flags found',
};

/** Short explanation, sized for the on-device model. */
export function explainPrompt(result, host) {
  return [
    'You are IBITI Guardian, a wallet safety assistant.',
    `The website ${host} asked the user's crypto wallet to confirm a request.`,
    'In 2 short sentences, tell a non-technical person what confirming would allow and what could go wrong.',
    'Use only the facts below. Do not add details that are not there. Do not tell them what to do.',
    'Speak to the user as "you". Plain words, no jargon, no lists, no markdown. Do not mention Guardian.',
    meaning(result, host)
      ? `Keep who does what exactly as in this sentence: ${meaning(result, host)}`
      : '',
    '',
    `Request: ${result.headline}`,
    `Assessment (already decided, do not change it): ${RISK_WORDS[result.risk]}`,
    'Facts:',
    factLines(result),
    result.reasons.length ? `Why it matters:\n${reasonLines(result)}` : '',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/** Deeper analysis for the cloud model, returned as structured JSON. */
export function deepPrompt(result, host) {
  return [
    'You are IBITI Guardian, a wallet safety analyst.',
    `The website ${host} asked the user's crypto wallet to confirm the request below.`,
    'A deterministic analyzer already decoded it; treat its facts and assessment as ground truth.',
    'Explain it for a non-technical person. Be specific and calm; do not exaggerate and do not invent facts.',
    meaning(result, host) ? `What it means (exact, keep who does what): ${meaning(result, host)}` : '',
    '',
    `Request: ${result.headline}`,
    `Assessment: ${RISK_WORDS[result.risk]}`,
    'Facts:',
    factLines(result),
    result.reasons.length ? `Analyzer notes:\n${reasonLines(result)}` : '',
    '',
    'Return JSON with:',
    '- summary: one sentence on what this request really is.',
    '- ifYouConfirm: one or two sentences on what would be possible after confirming.',
    '- pattern: if this matches a known scam pattern, name it in a few words; otherwise say it is a common, legitimate kind of request.',
    '- checks: two or three short things the user can verify before deciding.',
  ]
    .filter((line) => line !== '')
    .join('\n');
}
