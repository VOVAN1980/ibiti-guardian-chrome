// Prompts are built only from the analyzer's facts. The model explains; it
// never decides what the request is or how risky it is, and the user's own
// wallet address is never part of a prompt.

function factLines(result) {
  return result.facts
    .filter((f) => f.label !== 'From') // may be the user's own address
    .map((f) => `- ${f.label}: ${f.value}${f.note ? ` (${f.note})` : ''}`)
    .join('\n');
}

function reasonLines(result) {
  return result.reasons.map((r) => `- ${r}`).join('\n');
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
    'Plain words, no jargon, no lists, no markdown.',
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
