// Content script (isolated world), document_start, listed before inpage.js.
// Relays review requests from the page-world script to the extension and the
// user's decision back. The page cannot reach chrome.runtime, and it does not
// know the event name used on this channel.

(() => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const channel = `ig-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;

  const reply = (id, decision) => {
    document.dispatchEvent(
      new CustomEvent(`${channel}:in`, { detail: JSON.stringify({ id, decision }) }),
    );
  };

  // The payload is parsed here, in this content script's own world, whose
  // built-ins the page cannot touch. payload.request is the exact request the
  // page-world script will forward if the user allows it. Cancelling the
  // event tells inpage.js the request was taken: one no one takes is refused
  // there at once.
  const onOut = (event) => {
    let payload;
    try {
      payload = JSON.parse(event.detail);
    } catch {
      return;
    }
    if (!payload || typeof payload !== 'object') return;
    event.preventDefault();
    try {
      chrome.runtime.sendMessage({ type: 'guardian:review', payload }, (response) => {
        if (chrome.runtime.lastError || !response || !response.ok) reply(payload.id, 'error');
      });
    } catch {
      // Extension was reloaded or removed while this page stayed open.
      reply(payload.id, 'error');
    }
  };
  // document.open() (a page that rewrites itself after load) takes every
  // listener off the document, this one too. An observer of the document
  // outlives that and puts it back; adding the same function again adds it
  // once.
  const listenOut = () => document.addEventListener(`${channel}:out`, onOut);
  listenOut();
  new MutationObserver(listenOut).observe(document, { childList: true });

  // Background sends each decision to this document only (by its documentId),
  // and asks whether the document is still here before it drops old reviews.
  // Both are answered, so background knows the answer arrived.
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message) return false;
    if (message.type === 'guardian:decision') {
      reply(message.pageId, message.decision === 'allow' ? 'allow' : 'reject');
      sendResponse({ ok: true });
    } else if (message.type === 'guardian:alive') {
      sendResponse({ ok: true });
    }
    return false;
  });

  // A page kept in the back/forward cache gets no message while it is there.
  // Shown again, it asks for the answers the user gave meanwhile; inpage.js
  // takes each one once, and only for a request still waiting.
  window.addEventListener('pageshow', (event) => {
    if (!event.isTrusted || !event.persisted) return;
    try {
      chrome.runtime.sendMessage({ type: 'guardian:missed' }, (response) => {
        if (chrome.runtime.lastError || !response || !Array.isArray(response.decisions)) return;
        for (const missed of response.decisions) reply(missed.pageId, missed.decision === 'allow' ? 'allow' : 'reject');
      });
    } catch {
      // Extension was reloaded or removed while this page was away.
    }
  });

  // Hand the channel name to inpage.js, once, in the detail of a 'hello'
  // event. Both scripts run at document_start, before any page script, in
  // either order: if inpage.js is already listening it takes the name now;
  // if not, it asks for it as it starts. It cancels the event when it takes
  // the name, and from then on the name is given to no one. The name never
  // goes into the page's DOM, and nothing the page's own markup holds (a
  // data-ibiti-guardian attribute on <html>, say) plays any part.
  let handed = false;
  const hand = () => {
    if (handed) return;
    handed = !document.dispatchEvent(
      new CustomEvent('ibiti-guardian:hello', { detail: channel, cancelable: true }),
    );
  };
  hand();
  if (!handed) {
    // The first ask only: inpage.js asks as it starts, before the page can.
    const asked = () => {
      document.removeEventListener('ibiti-guardian:ask', asked);
      hand();
    };
    document.addEventListener('ibiti-guardian:ask', asked);
  }
})();
