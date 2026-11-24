// Service worker. Opens Guardian's own review window for each held request
// and routes the decision back to the document that asked. Pending reviews live in
// chrome.storage.session, so nothing depends on this worker staying awake.

const REVIEW_WIDTH = 420;
const REVIEW_HEIGHT = 760;

const reviewKey = (id) => `review:${id}`;
const windowKey = (windowId) => `window:${windowId}`;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;

  if (message.type === 'guardian:review') {
    openReview(message.payload, sender).then(
      () => sendResponse({ ok: true }),
      (error) => {
        console.error('[Guardian] could not open review', error);
        sendResponse({ ok: false });
      },
    );
    return true;
  }

  if (message.type === 'guardian:missed') {
    // A page back from the back/forward cache: the answers it missed meanwhile.
    if (!sender.tab || typeof sender.documentId !== 'string') return false;
    missed(sender.documentId).then(
      (decisions) => sendResponse({ decisions }),
      () => sendResponse({ decisions: [] }),
    );
    return true;
  }

  if (message.type === 'guardian:decide') {
    // Only Guardian's own review page may decide.
    const fromReviewPage =
      sender.id === chrome.runtime.id &&
      typeof sender.url === 'string' &&
      sender.url.startsWith(chrome.runtime.getURL('review.html'));
    if (!fromReviewPage) return false;
    settle(message.id, message.decision === 'allow' ? 'allow' : 'reject').then(() =>
      sendResponse({ ok: true }),
    );
    return true;
  }

  return false;
});

/** The page's promise, kept short: the analyzer reads it as the site's words. */
function promiseOf(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const text = (value) => (typeof value === 'string' ? value.slice(0, 200) : '');
  return { button: text(raw.button), title: text(raw.title), heading: text(raw.heading), ageMs: Number(raw.ageMs) };
}

async function openReview(payload, sender) {
  if (!sender.tab || typeof sender.tab.id !== 'number') throw new Error('no tab');
  // What the user reviews is read from payload.request: the exact text the
  // page-world script forwards if the user allows it, parsed outside the page.
  const request = payload.request;
  if (!request || typeof request !== 'object' || Array.isArray(request) || typeof request.method !== 'string') {
    throw new Error('unreadable request');
  }
  const id = crypto.randomUUID();
  const record = {
    id,
    pageId: String(payload.id),
    tabId: sender.tab.id,
    frameId: sender.frameId ?? 0,
    // The document that asked. Its decision goes to it and to no other, so a
    // window left from before a reload cannot release the next page's request.
    documentId: typeof sender.documentId === 'string' ? sender.documentId : null,
    // Origin comes from the browser, not from the page's own claim.
    origin: sender.origin || new URL(sender.url).origin,
    method: request.method,
    params: request.params === undefined ? [] : request.params,
    chainId: typeof payload.chainId === 'number' ? payload.chainId : null,
    enrich: payload.enrich && typeof payload.enrich === 'object' ? payload.enrich : {},
    // The button the user pressed just before; the analyzer checks it again.
    promise: promiseOf(payload.promise),
    createdAt: Date.now(),
  };
  await chrome.storage.session.set({ [reviewKey(id)]: record });

  const shape = {
    url: chrome.runtime.getURL(`review.html?id=${id}`),
    type: 'popup',
    width: REVIEW_WIDTH,
    height: REVIEW_HEIGHT,
    focused: true,
  };
  let created;
  try {
    created = await chrome.windows.create({ ...shape, ...(await placeFor(sender.tab)) });
  } catch {
    // Chrome refuses a spot that is not mostly on screen (a browser window
    // low on the screen or past its edge): let Chrome place the window.
    created = await chrome.windows.create(shape);
  }
  await chrome.storage.session.set({ [windowKey(created.id)]: id });
  // Reviews for an earlier document of this tab (reloaded, navigated away)
  // can never be answered: close them.
  dropGone(record.tabId, record.documentId).catch(() => {});
}

/**
 * Where a review window opens. Never worked out from a window the page can
 * place or size itself (a popup it opened with window.open, then moved or
 * resized), so a page cannot put a new window's Continue where an open
 * window's Reject is. Over the newest review window still open for the same
 * tab, exactly, so Continue covers Continue and Reject covers Reject;
 * otherwise at the right of the browser window the user works in. Never over
 * a window for another tab: there, a click meant for that site's window
 * would land on this request.
 */
async function placeFor(tab) {
  try {
    const all = await chrome.storage.session.get(null);
    let newest = null;
    for (const [k, id] of Object.entries(all)) {
      if (!k.startsWith('window:')) continue;
      const record = all[reviewKey(id)];
      if (!record || record.tabId !== tab.id) continue;
      try {
        const open = await chrome.windows.get(Number(k.slice('window:'.length)));
        if (open.state === 'normal' && (!newest || open.id > newest.id)) newest = open;
      } catch {
        // closed meanwhile
      }
    }
    if (newest) return { left: newest.left, top: newest.top, width: newest.width, height: newest.height };
  } catch {
    // Placed as below.
  }
  try {
    let host = await chrome.windows.get(tab.windowId);
    if (host.type !== 'normal') host = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    if (typeof host.left === 'number' && typeof host.width === 'number') {
      return { left: Math.max(0, host.left + host.width - REVIEW_WIDTH - 24), top: Math.max(0, (host.top ?? 0) + 88) };
    }
  } catch {
    // Default placement is fine.
  }
  return {};
}

// How long a decision may take to reach its page before the window closes
// anyway. A page kept in the back/forward cache gets no message while it is
// there (Chrome holds it, unanswered), and must not hold the window open.
const DELIVERY_MS = 1000;
// A message to a document that is not there fails at once (within a few ms).
const AT_ONCE_MS = 200;
const missedKey = (documentId, pageId) => `missed:${documentId}:${pageId}`;

/** Sends `message` to one document of a tab: true once it says it has it, false if it is not there. */
function deliver(tabId, message, target) {
  try {
    return chrome.tabs.sendMessage(tabId, message, target).then(
      (response) => Boolean(response && response.ok),
      () => false,
    );
  } catch {
    return Promise.resolve(false);
  }
}

/** What `promise` gives, or `late` if it gives nothing within DELIVERY_MS. */
function inTime(promise, late) {
  let timer;
  return Promise.race([promise, new Promise((resolve) => (timer = setTimeout(() => resolve(late), DELIVERY_MS)))]).finally(
    () => clearTimeout(timer),
  );
}

/** Settles the tab's reviews whose document is gone, except `current`'s. */
async function dropGone(tabId, current = null) {
  const all = await chrome.storage.session.get(null);
  const old = Object.entries(all).filter(
    ([k, value]) => k.startsWith('review:') && value && value.tabId === tabId && value.documentId && value.documentId !== current,
  );
  // A document that does not answer in time is kept in the back/forward
  // cache and may come back: its review stays, and checking it holds up no other.
  await Promise.all(
    old.map(async ([, value]) => {
      const alive = () => inTime(deliver(tabId, { type: 'guardian:alive' }, { documentId: value.documentId }), 'late');
      if ((await alive()) !== false) return;
      // One failed check is no proof: a message Chrome held for a page in the
      // cache fails later, once the page, back meanwhile, goes into the cache
      // again. Gone only if a second check, a moment later, fails at once.
      await new Promise((resolve) => setTimeout(resolve, DELIVERY_MS));
      const asked = Date.now();
      if ((await alive()) === false && Date.now() - asked < AT_ONCE_MS) await settle(value.id, 'reject'); // no such document any more
    }),
  );
}

/** The answers a document missed while it was in the back/forward cache, each given once. */
async function missed(documentId) {
  const all = await chrome.storage.session.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith(`missed:${documentId}:`));
  if (keys.length === 0) return [];
  await chrome.storage.session.remove(keys);
  return keys.map((k) => ({ pageId: all[k].pageId, decision: all[k].decision }));
}

async function settle(id, decision, { closeWindow = true } = {}) {
  const key = reviewKey(id);
  const stored = await chrome.storage.session.get(key);
  const record = stored[key];
  if (!record) return;
  await chrome.storage.session.remove(key);

  // The answer waits in storage until the document says it has it: a page
  // in the back/forward cache asks for it when it is shown again (bridge.js).
  const later = record.documentId ? missedKey(record.documentId, record.pageId) : null;
  if (later) await chrome.storage.session.set({ [later]: { tabId: record.tabId, pageId: record.pageId, decision } });
  const delivered = deliver(
    record.tabId,
    { type: 'guardian:decision', pageId: record.pageId, decision },
    // Only the document that asked: ids restart at 1 in every new document.
    record.documentId ? { documentId: record.documentId } : { frameId: record.frameId },
  );
  if (later) delivered.then((got) => (got ? chrome.storage.session.remove(later) : null)).catch(() => {});
  // Delivery never holds the window open.
  await inTime(delivered, 'late');

  if (closeWindow) {
    const all = await chrome.storage.session.get(null);
    for (const [k, value] of Object.entries(all)) {
      if (k.startsWith('window:') && value === id) {
        await chrome.storage.session.remove(k);
        try {
          await chrome.windows.remove(Number(k.slice('window:'.length)));
        } catch {
          // already closed
        }
      }
    }
  }
}

// Closing the review window without choosing means "no".
chrome.windows.onRemoved.addListener(async (windowId) => {
  const key = windowKey(windowId);
  const stored = await chrome.storage.session.get(key);
  const id = stored[key];
  if (!id) return;
  await chrome.storage.session.remove(key);
  await settle(id, 'reject', { closeWindow: false });
});

// A tab that loaded another page (or the same one again): reviews for the
// document it had can never be answered, so their windows close.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete') dropGone(tabId).catch(() => {});
});

// A closed tab cannot receive an answer: drop its reviews and their windows,
// and the answers its pages missed.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const all = await chrome.storage.session.get(null);
  for (const [k, value] of Object.entries(all)) {
    if (k.startsWith('review:') && value && value.tabId === tabId) {
      await settle(value.id, 'reject');
    }
  }
  const left = await chrome.storage.session.get(null);
  const gone = Object.keys(left).filter((k) => k.startsWith('missed:') && left[k] && left[k].tabId === tabId);
  if (gone.length > 0) await chrome.storage.session.remove(gone);
});
