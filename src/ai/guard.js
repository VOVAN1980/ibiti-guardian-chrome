// What Guardian keeps away from its AI.
//
//   - Requests the analyzer could not decode are not given to any AI: with
//     no facts, a model could only guess what they do.
//   - The user's own wallet address never goes into a prompt.
//
// Nothing a model writes is shown to the user as text: Gemini answers a form
// (src/ai/reading.js) that code checks, and the window shows only words
// written by code.

import { ownAddresses } from '../analyzer/index.js';

// Requests the analyzer could not decode.
export const UNDECODED = new Set(['contractCall', 'typedData', 'unknown', 'blindSign', 'deploy']);

export const isUndecoded = (result) =>
  UNDECODED.has(result.kind) ||
  (result.kind === 'message' && Boolean(result.subject) && result.subject.readable === false) ||
  // A batch is only as decoded as its least decoded call.
  (result.kind === 'batch' && (!Array.isArray(result.parts) || result.parts.length === 0 || result.parts.some(isUndecoded)));

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

/** The sentence on what confirming does: written by code, from meaning(). */
export function codeSentence(result, meaningSentence) {
  if (meaningSentence) return meaningSentence;
  if (isUndecoded(result)) return 'Guardian could not decode what this request does.';
  return `${result.headline}. The facts below are all Guardian can confirm.`;
}
