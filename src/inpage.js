// Runs in the page's own JavaScript world (MAIN) at document_start, before any
// page script. It wraps wallet providers so that requests which move funds or
// sign data wait for the user's decision in Guardian's own window.
//
// Limits (also in the README): a page that talks to a wallet through a private
// channel instead of the standard provider API is not covered. The wallet's
// own confirmation remains the last line of defense.

(() => {
  const MARK = '__ibitiGuardian';
  if (window[MARK]) return;
  try {
    Object.defineProperty(window, MARK, { value: true });
  } catch {
    return;
  }

  // Natives captured before the page can replace them.
  const apply = Reflect.apply;
  const addListener = EventTarget.prototype.addEventListener;
  const dispatch = EventTarget.prototype.dispatchEvent;
  const CustomEventCtor = CustomEvent;
  const getAttr = Element.prototype.getAttribute;
  const removeAttr = Element.prototype.removeAttribute;
  const stringify = JSON.stringify;
  const parse = JSON.parse;
  const PromiseCtor = Promise;
  const setTimer = setTimeout;
  const clearTimer = clearTimeout;
  const setRepeating = setInterval;
  const doc = document;

  const REVIEWED = new Set([
    'eth_sendTransaction',
    'eth_signTypedData',
    'eth_signTypedData_v1',
    'eth_signTypedData_v3',
    'eth_signTypedData_v4',
    'personal_sign',
    'eth_sign',
    'wallet_sendCalls',
  ]);

  // ── Private channel to the extension ───────────────────────────────────
  // The content script leaves a random name on <html>; both sides then talk
  // through events of that name. Page scripts have not run yet, so they never
  // see it, and they cannot listen for an event whose name they don't know.
  const ATTR = 'data-ibiti-guardian';
  let channel = null;
  const pending = new Map();
  let counter = 0;

  function takeChannel() {
    const root = doc.documentElement;
    if (!root) return null;
    const value = apply(getAttr, root, [ATTR]);
    if (value) apply(removeAttr, root, [ATTR]);
    return value || null;
  }

  function listen() {
    apply(addListener, doc, [
      `${channel}:in`,
      (event) => {
        let message;
        try {
          message = parse(event.detail);
        } catch {
          return;
        }
        const resolve = pending.get(message.id);
        if (!resolve) return;
        pending.delete(message.id);
        resolve(message.decision);
      },
    ]);
  }

  channel = takeChannel();
  if (channel) {
    listen();
  } else {
    apply(addListener, doc, [
      'ibiti-guardian:hello',
      () => {
        if (channel) return;
        channel = takeChannel();
        if (channel) listen();
      },
    ]);
  }

  function ask(payload) {
    return new PromiseCtor((resolve) => {
      if (!channel) {
        resolve('error');
        return;
      }
      const id = `${++counter}`;
      pending.set(id, resolve);
      apply(dispatch, doc, [
        new CustomEventCtor(`${channel}:out`, { detail: stringify({ id, ...payload }) }),
      ]);
    });
  }

  // ── Read-only context, fetched through the user's own wallet ───────────
  function withTimeout(promise, ms) {
    return new PromiseCtor((resolve) => {
      const timer = setTimer(() => resolve(undefined), ms);
      PromiseCtor.resolve(promise).then(
        (value) => {
          clearTimer(timer);
          resolve(value);
        },
        () => {
          clearTimer(timer);
          resolve(undefined);
        },
      );
    });
  }

  function decodeString(hex) {
    if (typeof hex !== 'string' || !hex.startsWith('0x')) return null;
    const h = hex.slice(2);
    const toText = (bytesHex) => {
      let out = '';
      for (let i = 0; i + 1 < bytesHex.length; i += 2) {
        const code = parseInt(bytesHex.slice(i, i + 2), 16);
        if (code === 0) break;
        if (code < 32 || code > 126) return null;
        out += String.fromCharCode(code);
      }
      return out || null;
    };
    if (h.length === 64) return toText(h); // bytes32 symbol (old tokens)
    if (h.length >= 128) {
      const length = parseInt(h.slice(64, 128), 16);
      if (Number.isFinite(length) && length > 0 && length <= 64) {
        return toText(h.slice(128, 128 + length * 2));
      }
    }
    return null;
  }

  const TOKEN_CALLS = new Set(['0x095ea7b3', '0x39509351', '0xa22cb465', '0xa9059cbb', '0x23b872dd']);

  function targets(method, params) {
    try {
      if (method === 'eth_sendTransaction') {
        const tx = params && params[0];
        const data = tx && (tx.data || tx.input);
        if (tx && typeof tx.to === 'string' && typeof data === 'string' && data.length >= 74) {
          const selector = data.slice(0, 10).toLowerCase();
          if (TOKEN_CALLS.has(selector)) {
            return {
              token: tx.to,
              spender: `0x${data.slice(34, 74)}`,
              isNft: selector === '0xa22cb465',
              owner: tx.from,
              // Plain transfer: how much of this token the wallet holds.
              wantsTokenBalance: selector === '0xa9059cbb',
            };
          }
        }
        if (tx && (typeof data !== 'string' || data.length <= 2)) {
          // Plain payment: how much of the wallet's coins it sends.
          return { token: null, spender: null, owner: tx.from, wantsBalance: true };
        }
      } else if (method === 'eth_signTypedData_v4' || method === 'eth_signTypedData_v3') {
        const raw = params && params[1];
        const typed = typeof raw === 'string' ? parse(raw) : raw;
        if (typed && typed.primaryType === 'Permit' && typed.domain && typed.message) {
          return { token: typed.domain.verifyingContract, spender: typed.message.spender };
        }
        if (typed && typed.message && typeof typed.message.spender === 'string') {
          return { token: null, spender: typed.message.spender };
        }
      }
    } catch {
      // Unreadable request: the analyzer reports that; no extra context here.
    }
    return null;
  }

  async function gatherContext(call, method, params) {
    const context = { chainId: null, enrich: {} };
    const target = targets(method, params);
    const isAddress = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
    const jobs = [
      withTimeout(call({ method: 'eth_chainId' }), 1500).then((v) => {
        const n = typeof v === 'string' ? parseInt(v, 16) : typeof v === 'number' ? v : NaN;
        if (Number.isFinite(n)) context.chainId = n;
      }),
    ];
    if (target && isAddress(target.spender)) {
      jobs.push(
        withTimeout(call({ method: 'eth_getCode', params: [target.spender, 'latest'] }), 1500).then((code) => {
          if (typeof code === 'string') context.enrich.spenderIsContract = code.length > 2;
        }),
      );
    }
    if (target && target.wantsBalance && isAddress(target.owner)) {
      jobs.push(
        withTimeout(call({ method: 'eth_getBalance', params: [target.owner, 'latest'] }), 1500).then((v) => {
          if (typeof v === 'string' && /^0x[0-9a-fA-F]+$/.test(v)) context.enrich.balance = v;
        }),
      );
    }
    if (target && target.wantsTokenBalance && isAddress(target.owner) && isAddress(target.token)) {
      const data = `0x70a08231${'0'.repeat(24)}${target.owner.slice(2).toLowerCase()}`;
      jobs.push(
        withTimeout(call({ method: 'eth_call', params: [{ to: target.token, data }, 'latest'] }), 1500).then((v) => {
          if (typeof v === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(v)) context.enrich.tokenBalance = v;
        }),
      );
    }
    if (target && isAddress(target.token) && !target.isNft) {
      const token = {};
      jobs.push(
        withTimeout(call({ method: 'eth_call', params: [{ to: target.token, data: '0x95d89b41' }, 'latest'] }), 1500).then(
          (v) => {
            const symbol = decodeString(v);
            if (symbol) token.symbol = symbol;
          },
        ),
        withTimeout(call({ method: 'eth_call', params: [{ to: target.token, data: '0x313ce567' }, 'latest'] }), 1500).then(
          (v) => {
            const n = typeof v === 'string' && v.length > 2 ? parseInt(v, 16) : NaN;
            if (Number.isInteger(n) && n >= 0 && n <= 36) token.decimals = n;
          },
        ),
      );
      context.enrich.token = token;
    }
    await PromiseCtor.all(jobs);
    return context;
  }

  // ── Review ─────────────────────────────────────────────────────────────
  function rejection(decision) {
    const error = new Error(
      decision === 'reject'
        ? 'IBITI Guardian: the user rejected this request.'
        : 'IBITI Guardian could not review this request, so it was not sent to the wallet. Reload the page and try again.',
    );
    error.code = 4001; // EIP-1193 userRejectedRequest
    return error;
  }

  async function review(call, method, params) {
    const context = await gatherContext(call, method, params);
    return ask({ method, params: params === undefined ? [] : params, ...context });
  }

  // ── Wrapping providers ─────────────────────────────────────────────────
  const guarded = new WeakSet();

  function guard(provider) {
    if (!provider || (typeof provider !== 'object' && typeof provider !== 'function')) return;
    if (guarded.has(provider)) return;
    const original = provider.request;
    if (typeof original !== 'function') return;
    guarded.add(provider);

    const call = (args) => apply(original, provider, [args]);

    const request = function request(args) {
      const method = args && typeof args === 'object' ? args.method : undefined;
      if (typeof method !== 'string' || !REVIEWED.has(method)) {
        return apply(original, this === undefined ? provider : this, arguments);
      }
      const self = this === undefined ? provider : this;
      const rawArgs = arguments;
      return review(call, method, args.params).then((decision) => {
        if (decision === 'allow') return apply(original, self, rawArgs);
        throw rejection(decision);
      });
    };

    const legacy = (name) => {
      const originalLegacy = provider[name];
      if (typeof originalLegacy !== 'function') return;
      const wrapper = function (first, second) {
        const self = this === undefined ? provider : this;
        const rawArgs = arguments;
        // send(method, params) → Promise
        if (typeof first === 'string') {
          if (!REVIEWED.has(first)) return apply(originalLegacy, self, rawArgs);
          return review(call, first, second).then((decision) => {
            if (decision === 'allow') return apply(originalLegacy, self, rawArgs);
            throw rejection(decision);
          });
        }
        // send(payload, callback) / sendAsync(payload, callback)
        if (first && typeof first === 'object' && !Array.isArray(first) && REVIEWED.has(first.method)) {
          if (typeof second !== 'function') {
            throw rejection('error'); // synchronous signing is not reviewable
          }
          review(call, first.method, first.params).then((decision) => {
            if (decision === 'allow') apply(originalLegacy, self, rawArgs);
            else second(rejection(decision), null);
          });
          return undefined;
        }
        return apply(originalLegacy, self, rawArgs);
      };
      define(provider, name, wrapper);
    };

    define(provider, 'request', request);
    legacy('send');
    legacy('sendAsync');
  }

  function define(target, name, value) {
    try {
      Object.defineProperty(target, name, { value, configurable: true, writable: true });
    } catch {
      try {
        target[name] = value;
      } catch {
        // Frozen provider: cannot be wrapped.
      }
    }
  }

  function guardGlobal() {
    try {
      const provider = window.ethereum;
      if (!provider) return;
      guard(provider);
      if (Array.isArray(provider.providers)) provider.providers.forEach(guard);
    } catch {
      // A hostile getter on window.ethereum must not break the page.
    }
  }

  // EIP-6963: wallets announce themselves through events. Listening in the
  // capture phase, registered first, wraps a provider before the page sees it.
  apply(addListener, window, [
    'eip6963:announceProvider',
    (event) => {
      try {
        guard(event.detail && event.detail.provider);
      } catch {
        // ignore malformed announcements
      }
    },
    true,
  ]);

  // window.ethereum: a wallet that injects after this script is wrapped the
  // moment it assigns itself. If no wallet shows up, the placeholder is removed
  // so pages that check `'ethereum' in window` still see "no wallet".
  let trapped = false;
  if (!('ethereum' in window)) {
    let current;
    try {
      Object.defineProperty(window, 'ethereum', {
        configurable: true,
        enumerable: true,
        get() {
          return current;
        },
        set(value) {
          current = value;
          guard(value);
        },
      });
      trapped = true;
      const release = () => {
        if (!trapped || current !== undefined) return;
        const descriptor = Object.getOwnPropertyDescriptor(window, 'ethereum');
        if (descriptor && descriptor.get && descriptor.configurable) {
          delete window.ethereum;
          trapped = false;
        }
      };
      apply(addListener, window, ['load', () => setTimer(release, 3000)]);
    } catch {
      trapped = false;
    }
  }

  guardGlobal();
  apply(addListener, window, ['ethereum#initialized', guardGlobal]);
  apply(addListener, doc, ['DOMContentLoaded', guardGlobal]);
  apply(addListener, window, ['load', guardGlobal]);
  for (const delay of [0, 50, 150, 400, 1000, 2500, 5000]) setTimer(guardGlobal, delay);
  setRepeating(guardGlobal, 2000);
})();
