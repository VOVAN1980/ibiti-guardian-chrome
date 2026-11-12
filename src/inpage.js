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

  // Where a guarded provider keeps its read-only call helper.
  const CALL = Symbol('ibitiGuardianCall');

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
  // Some wallets replace their own request() after they are created
  // (TronLink does), which would silently drop a one-time wrapper. Each
  // guarded method is therefore an accessor: reading it always gives the
  // wrapper, and assigning a new function only changes what the wrapper
  // calls. Known providers are also re-checked, in case a wallet redefines
  // the property outright.
  const wrappers = new WeakSet();
  const known = [];

  /**
   * Calls the wallet's current implementation. If that implementation leads
   * straight back into the wrapper (a wallet re-binding the method it just
   * read, i.e. the wrapper itself), the inner call goes to the last
   * implementation known not to loop.
   */
  function through(state, self, args) {
    if (state.depth > 0) {
      state.reentered = true;
      return apply(state.base, self, args);
    }
    state.depth++;
    state.reentered = false;
    try {
      return apply(state.target, self, args);
    } finally {
      state.depth--;
      if (!state.reentered) state.base = state.target;
    }
  }

  /**
   * A private copy of what the page passed. The page keeps its own object and
   * could change it while the user is reading the review, or use a getter
   * that answers differently each time. Guardian reviews the copy and the
   * wallet receives a copy, so what was reviewed is what gets signed.
   * Returns null for anything that is not plain JSON data.
   */
  function snapshotOf(value) {
    try {
      const text = stringify(value);
      if (typeof text !== 'string') return null;
      return { text, value: parse(text) };
    } catch {
      return null;
    }
  }

  // Requests the user has just allowed, while they travel down to the wallet.
  // If another wrapper sits in between and hands the same request to an inner
  // Guardian wrapper, it is not reviewed a second time. Entries live only for
  // the synchronous call and match by exact content.
  const allowedNow = new Map();

  function passAllowed(text, run) {
    allowedNow.set(text, (allowedNow.get(text) || 0) + 1);
    try {
      return run();
    } finally {
      const left = (allowedNow.get(text) || 1) - 1;
      if (left > 0) allowedNow.set(text, left);
      else allowedNow.delete(text);
    }
  }

  function invalidRequest() {
    const error = new Error('IBITI Guardian: this request is not plain data, so it could not be reviewed.');
    error.code = -32600; // JSON-RPC invalid request
    return error;
  }

  function guard(provider) {
    if (!provider || (typeof provider !== 'object' && typeof provider !== 'function')) return;
    let current;
    try {
      current = provider.request;
    } catch {
      return;
    }
    if (typeof current !== 'function') return;
    if (known.indexOf(provider) === -1) known.push(provider);

    if (!wrappers.has(current)) {
      const state = { target: current, base: current, depth: 0, reentered: false };
      // Read-only calls for context use the wallet's own request().
      const call = (args) => through(state, provider, [args]);
      const wrapper = function request(args) {
        const self = this === undefined ? provider : this;
        if (state.depth > 0) return through(state, self, arguments);

        const snap = snapshotOf(args);
        if (!snap || !snap.value || typeof snap.value !== 'object') {
          return PromiseCtor.reject(invalidRequest());
        }
        const method = snap.value.method;
        if (typeof method !== 'string' || !REVIEWED.has(method)) {
          return through(state, self, [snap.value]);
        }
        if (allowedNow.has(snap.text)) return through(state, self, [snap.value]);

        return review(call, method, snap.value.params).then((decision) => {
          if (decision !== 'allow') throw rejection(decision);
          // A fresh copy for the wallet: the reviewed one was shown to the user.
          return passAllowed(snap.text, () => through(state, self, [parse(snap.text)]));
        });
      };
      install(provider, 'request', wrapper, state);
      provider[CALL] = call;
    }

    const call = provider[CALL];
    if (typeof call !== 'function') return;

    for (const name of ['send', 'sendAsync']) {
      let legacy;
      try {
        legacy = provider[name];
      } catch {
        continue;
      }
      if (typeof legacy !== 'function' || wrappers.has(legacy)) continue;
      const state = { target: legacy, base: legacy, depth: 0, reentered: false };
      const wrapper = function (first, second) {
        const self = this === undefined ? provider : this;
        if (state.depth > 0) return through(state, self, arguments);

        // send(method, params) → Promise
        if (typeof first === 'string') {
          if (!REVIEWED.has(first)) return through(state, self, arguments);
          const snap = snapshotOf(second === undefined ? [] : second);
          if (!snap) return PromiseCtor.reject(invalidRequest());
          const text = `${first}:${snap.text}`;
          if (allowedNow.has(text)) return through(state, self, [first, snap.value]);
          return review(call, first, snap.value).then((decision) => {
            if (decision !== 'allow') throw rejection(decision);
            return passAllowed(text, () => through(state, self, [first, parse(snap.text)]));
          });
        }

        // send(payload, callback) / sendAsync(payload, callback)
        const snap = snapshotOf(first);
        if (!snap || !snap.value || typeof snap.value !== 'object') {
          return through(state, self, arguments);
        }
        const batch = Array.isArray(snap.value) ? snap.value : null;
        const reviewed = batch
          ? batch.some((item) => item && REVIEWED.has(item.method))
          : REVIEWED.has(snap.value.method);
        if (!reviewed) {
          return typeof second === 'function'
            ? through(state, self, [snap.value, second])
            : through(state, self, [snap.value]);
        }
        // Batches and synchronous signing cannot be shown one by one: refuse.
        if (batch || typeof second !== 'function') {
          if (typeof second === 'function') {
            second(rejection('error'), null);
            return undefined;
          }
          throw rejection('error');
        }
        if (allowedNow.has(snap.text)) return through(state, self, [snap.value, second]);
        review(call, snap.value.method, snap.value.params).then((decision) => {
          if (decision !== 'allow') {
            second(rejection(decision), null);
            return;
          }
          passAllowed(snap.text, () => through(state, self, [parse(snap.text), second]));
        });
        return undefined;
      };
      install(provider, name, wrapper, state);
    }
  }

  function install(provider, name, wrapper, state) {
    wrappers.add(wrapper);
    try {
      Object.defineProperty(provider, name, {
        configurable: true,
        enumerable: true,
        get() {
          return wrapper;
        },
        set(next) {
          // The wallet swapped its implementation: keep guarding the new one.
          if (typeof next === 'function' && !wrappers.has(next)) state.target = next;
        },
      });
    } catch {
      try {
        provider[name] = wrapper;
      } catch {
        // Frozen provider: cannot be wrapped.
      }
    }
  }

  function guardKnown() {
    for (let i = 0; i < known.length; i++) guard(known[i]);
  }

  function guardGlobal() {
    try {
      const provider = window.ethereum;
      if (provider) {
        guard(provider);
        if (Array.isArray(provider.providers)) provider.providers.forEach(guard);
      }
    } catch {
      // A hostile getter on window.ethereum must not break the page.
    }
    try {
      guardKnown();
    } catch {
      // keep the page working
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
  setRepeating(guardGlobal, 1000);
})();
