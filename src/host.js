// Where the review window is running:
//   in the extension      its own browser window, which the site cannot touch
//   in the hosted preview a frame inside the demo page, so the review can be
//                         tried without installing anything
// Everything else in the review window is the same code in both places.

const inExtension = typeof chrome !== 'undefined' && Boolean(chrome.runtime && chrome.runtime.id);

export const isPreview = !inExtension;

/** The held request this window is about, or undefined if it is gone. */
export async function loadReview(id) {
  const key = `review:${id}`;
  if (inExtension) {
    const stored = await chrome.storage.session.get(key);
    return stored[key];
  }
  try {
    return JSON.parse(sessionStorage.getItem(key)) || undefined;
  } catch {
    return undefined;
  }
}

export async function sendDecision(id, decision) {
  if (inExtension) {
    await chrome.runtime.sendMessage({ type: 'guardian:decide', id, decision });
    return;
  }
  window.parent.postMessage({ type: 'guardian:decide', id, decision }, location.origin);
}

export function closeReview() {
  if (inExtension) window.close();
}
