// Content script (isolated world), document_start, listed before inpage.js.
// Relays review requests from the page-world script to the extension and the
// user's decision back. The page cannot reach chrome.runtime, and it does not
// know the event name used on this channel.

(() => {
  const ATTR = 'data-ibiti-guardian';
  const root = document.documentElement;
  if (!root || root.hasAttribute(ATTR)) return;

  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const channel = `ig-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;

  const reply = (id, decision) => {
    document.dispatchEvent(
      new CustomEvent(`${channel}:in`, { detail: JSON.stringify({ id, decision }) }),
    );
  };

  document.addEventListener(`${channel}:out`, (event) => {
    let payload;
    try {
      payload = JSON.parse(event.detail);
    } catch {
      return;
    }
    try {
      chrome.runtime.sendMessage({ type: 'guardian:review', payload }, (response) => {
        if (chrome.runtime.lastError || !response || !response.ok) reply(payload.id, 'error');
      });
    } catch {
      // Extension was reloaded or removed while this page stayed open.
      reply(payload.id, 'error');
    }
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === 'guardian:decision') {
      reply(message.pageId, message.decision === 'allow' ? 'allow' : 'reject');
    }
  });

  // Hand the channel name to inpage.js: it reads and removes the attribute.
  // Both run before any page script, so the page never sees it.
  root.setAttribute(ATTR, channel);
  document.dispatchEvent(new CustomEvent('ibiti-guardian:hello'));
})();
