// The no-install preview for the hosted demo.
//
// On a page where the extension is not installed, this script plays the
// extension's part: it gives the in-page guard (the very same inpage.js the
// extension injects) its channel, and shows the same review window in a panel
// inside the page instead of in a separate browser window.
//
// It is a preview, not protection: a panel that lives inside a page can be
// removed by that page. The extension's window is outside the page's reach.

(() => {
  if (window.__ibitiGuardian) return; // the extension is here and does the real thing

  const base = document.currentScript ? document.currentScript.src : location.href;
  const uuid = () =>
    crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

  const channel = `ig-${uuid()}`;
  document.documentElement.setAttribute('data-ibiti-guardian', channel);
  window.__ibitiGuardianPreview = true;

  const queue = [];
  let open = null; // { id, pageId, root, frame }

  document.addEventListener(`${channel}:out`, (event) => {
    let payload;
    try {
      payload = JSON.parse(event.detail);
    } catch {
      return;
    }
    queue.push(payload);
    next();
  });

  window.addEventListener('message', (event) => {
    if (!open || event.origin !== location.origin || event.source !== open.frame.contentWindow) return;
    const data = event.data;
    if (!data || data.type !== 'guardian:decide' || data.id !== open.id) return;
    settle(data.decision === 'allow' ? 'allow' : 'reject');
  });

  function next() {
    if (open || queue.length === 0) return;
    const payload = queue.shift();
    const id = uuid();
    const record = {
      id,
      pageId: String(payload.id),
      origin: location.origin,
      method: String(payload.method),
      params: payload.params,
      chainId: typeof payload.chainId === 'number' ? payload.chainId : null,
      enrich: payload.enrich && typeof payload.enrich === 'object' ? payload.enrich : {},
      createdAt: Date.now(),
    };
    try {
      sessionStorage.setItem(`review:${id}`, JSON.stringify(record));
    } catch {
      reply(record.pageId, 'error'); // cannot show it: refuse, never pass
      next();
      return;
    }
    open = { id, pageId: record.pageId, ...build(id) };
  }

  function settle(decision) {
    if (!open) return;
    const { id, pageId, root } = open;
    open = null;
    root.remove();
    try {
      sessionStorage.removeItem(`review:${id}`);
    } catch {
      // nothing to clean up
    }
    reply(pageId, decision);
    next();
  }

  function reply(pageId, decision) {
    document.dispatchEvent(
      new CustomEvent(`${channel}:in`, { detail: JSON.stringify({ id: pageId, decision }) }),
    );
  }

  function build(id) {
    const root = document.createElement('div');
    root.id = 'ibiti-guardian-preview';
    const shadow = root.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; }
      .backdrop {
        position: fixed; inset: 0; z-index: 2147483646;
        background: rgba(3, 6, 10, 0.62); backdrop-filter: blur(3px);
        animation: fade 0.16s ease-out;
      }
      .window {
        position: fixed; z-index: 2147483647;
        top: 24px; right: 24px; width: 420px; height: min(760px, calc(100vh - 48px));
        display: flex; flex-direction: column; overflow: hidden;
        background: #06090e; border: 1px solid #263042; border-radius: 14px;
        box-shadow: 0 24px 70px rgba(0, 0, 0, 0.6);
        font: 12px/1.3 'Segoe UI', system-ui, -apple-system, Roboto, sans-serif;
        animation: slide 0.2s ease-out;
      }
      .bar {
        flex: none; display: flex; align-items: center; gap: 8px;
        padding: 7px 8px 7px 12px; background: #121924; color: #8d99ab;
        border-bottom: 1px solid #1f2836;
      }
      .bar span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .bar button {
        all: unset; cursor: pointer; width: 24px; height: 24px; border-radius: 6px;
        display: grid; place-items: center; color: #a9b4c4; font-size: 16px; line-height: 1;
      }
      .bar button:hover { background: #1f2836; color: #fff; }
      .bar button:focus-visible { outline: 2px solid #19d3e6; }
      iframe { flex: 1; width: 100%; border: 0; background: #06090e; }
      @media (max-width: 520px) {
        .window { inset: 0; width: auto; height: auto; border-radius: 0; border: 0; }
      }
      @keyframes fade { from { opacity: 0; } }
      @keyframes slide { from { opacity: 0; transform: translateY(-8px); } }
      @media (prefers-reduced-motion: reduce) { .backdrop, .window { animation: none; } }
    `;

    const backdrop = document.createElement('div');
    backdrop.className = 'backdrop';

    const frameWindow = document.createElement('div');
    frameWindow.className = 'window';
    frameWindow.setAttribute('role', 'dialog');
    frameWindow.setAttribute('aria-label', 'IBITI Guardian review');

    const bar = document.createElement('div');
    bar.className = 'bar';
    const label = document.createElement('span');
    label.textContent = 'Preview inside this page. The extension opens this as its own window.';
    const close = document.createElement('button');
    close.type = 'button';
    close.title = 'Close (counts as Reject)';
    close.setAttribute('aria-label', 'Close and reject');
    close.textContent = '×';
    close.addEventListener('click', () => settle('reject'));
    bar.append(label, close);

    const frame = document.createElement('iframe');
    frame.title = 'IBITI Guardian';
    frame.src = new URL(`review.html?id=${encodeURIComponent(id)}`, base).href;

    frameWindow.append(bar, frame);
    shadow.append(style, backdrop, frameWindow);
    document.documentElement.append(root);
    return { root, frame };
  }
})();
