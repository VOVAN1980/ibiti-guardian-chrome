// Service worker. Opens Guardian's own review window for each held request
// and routes the decision back to the tab that asked. Pending reviews live in
// chrome.storage.session, so nothing depends on this worker staying awake.

const REVIEW_WIDTH = 420;
const REVIEW_HEIGHT = 680;

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

async function openReview(payload, sender) {
  if (!sender.tab || typeof sender.tab.id !== 'number') throw new Error('no tab');
  const id = crypto.randomUUID();
  const record = {
    id,
    pageId: String(payload.id),
    tabId: sender.tab.id,
    frameId: sender.frameId ?? 0,
    // Origin comes from the browser, not from the page's own claim.
    origin: sender.origin || new URL(sender.url).origin,
    method: String(payload.method),
    params: payload.params,
    chainId: typeof payload.chainId === 'number' ? payload.chainId : null,
    enrich: payload.enrich && typeof payload.enrich === 'object' ? payload.enrich : {},
    createdAt: Date.now(),
  };
  await chrome.storage.session.set({ [reviewKey(id)]: record });

  const position = {};
  try {
    const host = await chrome.windows.get(sender.tab.windowId);
    if (typeof host.left === 'number' && typeof host.width === 'number') {
      position.left = Math.max(0, host.left + host.width - REVIEW_WIDTH - 24);
      position.top = Math.max(0, (host.top ?? 0) + 88);
    }
  } catch {
    // Default placement is fine.
  }

  const created = await chrome.windows.create({
    url: chrome.runtime.getURL(`review.html?id=${id}`),
    type: 'popup',
    width: REVIEW_WIDTH,
    height: REVIEW_HEIGHT,
    focused: true,
    ...position,
  });
  await chrome.storage.session.set({ [windowKey(created.id)]: id });
}

async function settle(id, decision, { closeWindow = true } = {}) {
  const key = reviewKey(id);
  const stored = await chrome.storage.session.get(key);
  const record = stored[key];
  if (!record) return;
  await chrome.storage.session.remove(key);

  try {
    await chrome.tabs.sendMessage(
      record.tabId,
      { type: 'guardian:decision', pageId: record.pageId, decision },
      { frameId: record.frameId },
    );
  } catch {
    // The tab or frame is gone; nothing is waiting for the answer.
  }

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

// A closed tab cannot receive an answer: drop its reviews and their windows.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const all = await chrome.storage.session.get(null);
  for (const [k, value] of Object.entries(all)) {
    if (k.startsWith('review:') && value && value.tabId === tabId) {
      await settle(value.id, 'reject');
    }
  }
});
