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

// The user's one-time permission to use Gemini in the cloud when this
// computer has no on-device model. Off until the user turns it on. The
// extension keeps it (chrome.storage.local, which pages cannot reach); the
// hosted preview keeps it for this visit only.
const FALLBACK_KEY = 'cloudFallback';

export async function cloudFallbackAllowed() {
  if (inExtension) {
    const stored = await chrome.storage.local.get(FALLBACK_KEY);
    return stored[FALLBACK_KEY] === true;
  }
  try {
    return sessionStorage.getItem(`guardian:${FALLBACK_KEY}`) === '1';
  } catch {
    return false;
  }
}

/**
 * Calls `callback` when the user turns the permission off (in the toolbar
 * panel) while this window is open. Returns a function that stops listening.
 */
export function onCloudFallbackOff(callback) {
  if (!inExtension) return () => {};
  const listener = (changes, area) => {
    if (area === 'local' && changes[FALLBACK_KEY] && changes[FALLBACK_KEY].newValue !== true) callback();
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

/** The last explanation's timings and source, for the toolbar panel. */
export async function saveLastExplanation(stats) {
  if (!inExtension) return;
  try {
    await chrome.storage.local.set({ lastExplanation: { ...stats, at: Date.now() } });
  } catch {
    // only a display aid
  }
}

export async function allowCloudFallback() {
  if (inExtension) {
    await chrome.storage.local.set({ [FALLBACK_KEY]: true });
    return;
  }
  try {
    sessionStorage.setItem(`guardian:${FALLBACK_KEY}`, '1');
  } catch {
    // this visit only; nothing to keep
  }
}
