// Runs in the page's own JavaScript world (MAIN) at document_start, before any
// page script. It wraps wallet providers so that requests which move funds,
// sign data or grant permissions wait for the user's decision in Guardian's
// own window.
//
// This world is shared with the page, and so are its built-ins. Everything
// used after page scripts start is captured first, the user's decision
// travels by plain callbacks (no promise, Map or Set the page could replace),
// and the request is reviewed as the exact text the wallet will get.
//
// Limits (also in the README): only requests made through the provider's
// request(), send() and sendAsync() are held. A page written to get around
// Guardian can reach the wallet another way (the wallet's prototype or
// internal methods, or its own channel to its extension), and can answer the
// context reads falsely. A page that opens or frames another page of its own
// site can prepare that page's JavaScript before Guardian starts there. The
// wallet's own confirmation remains the last line of defense.

(() => {
  // Natives captured before the page can replace them.
  const apply = Reflect.apply;
  const defineProp = Object.defineProperty;
  const ownDescriptor = Object.getOwnPropertyDescriptor;
  const objectKeys = Object.keys;
  const ownKeys = Reflect.ownKeys;
  const protoOf = Object.getPrototypeOf;
  const isArray = Array.isArray;
  const hasOwn = Object.prototype.hasOwnProperty;
  const ObjectProto = Object.prototype;
  const ArrayProto = Array.prototype;
  const addListener = EventTarget.prototype.addEventListener;
  const dispatch = EventTarget.prototype.dispatchEvent;
  const cancelEvent = Event.prototype.preventDefault;
  const CustomEventCtor = CustomEvent;
  const detailOf = ownDescriptor(CustomEvent.prototype, 'detail').get;
  const rootOf = ownDescriptor(Document.prototype, 'documentElement').get;
  const viewOf = ownDescriptor(Document.prototype, 'defaultView').get;
  const firstChildOf = ownDescriptor(Node.prototype, 'firstChild').get;
  const ObserverCtor = MutationObserver;
  const observe = MutationObserver.prototype.observe;
  const unobserve = MutationObserver.prototype.disconnect;
  const getAttr = Element.prototype.getAttribute;
  const stringify = JSON.stringify;
  const parse = JSON.parse;
  const PromiseCtor = Promise;
  const promiseThen = Promise.prototype.then;
  const ErrorCtor = Error;
  const WeakMapCtor = WeakMap;
  const mapGet = WeakMap.prototype.get;
  const mapSet = WeakMap.prototype.set;
  const mapDelete = WeakMap.prototype.delete;
  const WeakSetCtor = WeakSet;
  const setHas = WeakSet.prototype.has;
  const setAdd = WeakSet.prototype.add;
  const sliceOf = String.prototype.slice;
  const lowerOf = String.prototype.toLowerCase;
  const toInt = parseInt;
  const charOf = String.fromCharCode;
  const isFiniteNumber = Number.isFinite;
  const isWholeNumber = Number.isInteger;
  const setTimer = setTimeout;
  const clearTimer = clearTimeout;
  const setRepeating = setInterval;
  const doc = document;
  const ElementCtor = Element;

  /** A dictionary with no prototype: no key the page defines can show through. */
  const dict = () => ({ __proto__: null });
  /** An own property of parsed data, never one inherited from a prototype. */
  const own = (value, key) =>
    value !== null && typeof value === 'object' && apply(hasOwn, value, [key]) ? value[key] : undefined;
  const slice = (text, start, end) => apply(sliceOf, text, [start, end]);
  const lower = (text) => apply(lowerOf, text, []);

  // ── Guardian is here ───────────────────────────────────────────────────
  // Nothing found on the window or the document when this script starts is
  // trusted: a page that opens or frames this one can put anything there
  // first. Guardian therefore never stops because it seems to be here already.
  // It only leaves two signs. window.__ibitiGuardian tells pages and tests that
  // it runs. The document's mark answers, for another Guardian (in a
  // same-origin frame given this page's provider, or the other way round),
  // whether a function is one of this document's wrappers, so the two do not
  // wrap each other again and again.
  const wrappers = new WeakSetCtor();
  const isWrapper = (fn) => apply(setHas, wrappers, [fn]);
  const MARK = Symbol.for('ibiti.guardian');
  const BRAND = Symbol.for('ibiti.guardian.wrapper');
  try {
    defineProp(doc, MARK, { __proto__: null, value: isWrapper });
  } catch {
    // Already taken: Guardian runs all the same.
  }
  try {
    defineProp(window, '__ibitiGuardian', { __proto__: null, value: true });
  } catch {
    // Already defined by someone else: only a sign, never trusted.
  }

  // Requests that sign, send or grant something. Connection requests
  // (eth_requestAccounts) and read-only calls go straight to the wallet.
  const REVIEWED = dict();
  for (const name of [
    'eth_sendTransaction',
    'eth_signTransaction',
    'eth_signTypedData',
    'eth_signTypedData_v1',
    'eth_signTypedData_v3',
    'eth_signTypedData_v4',
    'personal_sign',
    'eth_sign',
    'wallet_sendCalls',
    'wallet_sendPreparedCalls',
    'wallet_grantPermissions',
    'wallet_requestExecutionPermissions',
    'wallet_invokeSnap',
    'wallet_snap',
    'wallet_invokeKeyring',
    'wallet_sign',
  ]) {
    REVIEWED[name] = true;
  }
  const isReviewed = (method) => typeof method === 'string' && REVIEWED[method] === true;

  // ── JSON text, written by hand ─────────────────────────────────────────
  // JSON.stringify asks every object for a toJSON, which the page can put on
  // Object.prototype. Only strings and numbers go through it here: those it
  // never asks.
  const jsonText = (value) => (typeof value === 'string' ? stringify(value) : '""');
  const jsonNumber = (value) => (typeof value === 'number' && isFiniteNumber(value) ? stringify(value) : 'null');

  /** JSON text of parsed JSON data, from its own keys only. */
  function jsonOf(value) {
    if (value === null) return 'null';
    if (typeof value === 'string') return stringify(value);
    if (typeof value === 'number') return jsonNumber(value);
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value !== 'object') return 'null';
    let out = '';
    if (isArray(value)) {
      for (let i = 0; i < value.length; i++) out += `${i ? ',' : ''}${jsonOf(own(value, i))}`;
      return `[${out}]`;
    }
    const keys = objectKeys(value);
    for (let i = 0; i < keys.length; i++) out += `${i ? ',' : ''}${stringify(keys[i])}:${jsonOf(own(value, keys[i]))}`;
    return `{${out}}`;
  }

  // ── Private channel to the extension ───────────────────────────────────
  // The content script (bridge.js) makes up a random name; both sides then
  // talk through events of that name. The name comes once, in the detail of
  // an 'ibiti-guardian:hello' event, while both scripts start and before any
  // page script runs: this script asks for it as it starts, and takes a hello
  // it did not ask for only until the page has content of its own (the bridge
  // may start just after this script). The observer below notices the first
  // node the page's parser adds, and it runs before any script of the page
  // does. Nothing the page wrote beforehand (an attribute in its markup, say)
  // or sends later is ever taken as the name, and the page cannot listen for
  // events whose name it doesn't know.
  let channel = null;
  // Requests waiting for the user, by id: the callback that takes the answer.
  const pending = dict();
  let counter = 0;
  let asking = false;
  let starting = true;

  const onIn = (event) => {
    let message;
    try {
      message = parse(apply(detailOf, event, []));
    } catch {
      return;
    }
    const id = own(message, 'id');
    if (typeof id !== 'string') return;
    const decided = pending[id];
    if (typeof decided !== 'function') return;
    delete pending[id];
    decided(own(message, 'decision'));
  };
  // Adding the same function again adds it once.
  function listen() {
    apply(addListener, doc, [`${channel}:in`, onIn]);
  }
  // document.open() (a page that rewrites itself after load) takes every
  // listener off the document, in both worlds. An observer of the document
  // outlives that and puts this side's back, so a request already waiting
  // still gets its answer; the bridge does the same for its own.
  try {
    const keeper = new ObserverCtor(() => {
      if (channel) listen();
    });
    apply(observe, keeper, [doc, { __proto__: null, childList: true }]);
  } catch {
    // ask() puts it back before every request all the same.
  }

  apply(addListener, doc, [
    'ibiti-guardian:hello',
    (event) => {
      if (channel) return;
      if (!asking) {
        const root = apply(rootOf, doc, []);
        if (!starting || !root || apply(firstChildOf, root, []) !== null) return;
      }
      const name = apply(detailOf, event, []);
      if (typeof name !== 'string' || !name) return;
      channel = name;
      // Tells the bridge the name was taken: it never gives it out again.
      apply(cancelEvent, event, []);
      listen();
    },
  ]);
  const started = () => {
    starting = false;
  };
  try {
    const watcher = new ObserverCtor(() => {
      started();
      apply(unobserve, watcher, []);
    });
    apply(observe, watcher, [doc, { __proto__: null, childList: true, subtree: true }]);
  } catch {
    started();
  }
  setTimer(started, 0);
  asking = true;
  try {
    apply(dispatch, doc, [new CustomEventCtor('ibiti-guardian:ask')]);
  } catch {
    // No channel: every held request is refused.
  } finally {
    asking = false;
  }

  /**
   * Opens Guardian's window. `fields` is JSON text written by hand around the
   * exact request text; `decided` is called once, with the user's answer.
   */
  function ask(fields, decided) {
    if (!channel) {
      decided('error');
      return;
    }
    const id = `${++counter}`;
    pending[id] = decided;
    listen();
    // The bridge cancels the event when it takes the request. One no one
    // took (its listener gone with a document.open(), say) is refused now,
    // never left waiting.
    const taken = !apply(dispatch, doc, [
      new CustomEventCtor(`${channel}:out`, { __proto__: null, cancelable: true, detail: `{"id":"${id}",${fields}}` }),
    ]);
    if (!taken && pending[id] === decided) {
      delete pending[id];
      decided('error');
    }
  }

  // ── The page's promise: the button the user pressed just before ────────
  // Only what the button said, the page title and the nearest heading: no
  // form fields, no page text. A click the page makes itself (isTrusted
  // false) does not count. Natives are taken now, before page scripts run.
  const closest = Element.prototype.closest;
  const queryAll = Element.prototype.querySelectorAll;
  const docQuery = Document.prototype.querySelector;
  const position = Node.prototype.compareDocumentPosition;
  const FOLLOWING = 4; // Node.DOCUMENT_POSITION_FOLLOWING
  const innerTextOf = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'innerText').get;
  const titleOf = Object.getOwnPropertyDescriptor(Document.prototype, 'title').get;
  const parentOf = Object.getOwnPropertyDescriptor(Node.prototype, 'parentElement').get;
  const now = Date.now;
  const PRESSABLE = 'button, a, [role="button"], input[type="submit"], input[type="button"], summary';
  // Any address in the site's words, whole or shortened ("0x71C7…976F"), is
  // taken out before the words are cut short: a cut address could no longer
  // be recognised later, and the user's own may be among them.
  const ADDRESS = /0x[0-9a-fA-F]{2,}(?:[.…·•⋯‥*]+|-{2,})[0-9a-fA-F]{2,}|0x[0-9a-fA-F]{4,}|\b[0-9a-fA-F]{40}\b/g;
  const words = (value) =>
    typeof value === 'string'
      ? value
          .slice(0, 2000)
          .replace(ADDRESS, 'an address')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 80)
      : '';
  let lastPress = null;

  /** What a trusted click pressed: its words and where, or null. */
  function pressOf(target) {
    if (!(target instanceof ElementCtor)) return null;
    const el = apply(closest, target, [PRESSABLE]);
    if (!el) return null;
    const button =
      words(apply(innerTextOf, el, [])) ||
      words(el.value) ||
      words(apply(getAttr, el, ['aria-label'])) ||
      words(apply(getAttr, el, ['title']));
    if (!button) return null;
    // The nearest heading above the button: in the closest ancestor that has
    // one before it in the page.
    let heading = '';
    for (let node = apply(parentOf, el, []), depth = 0; node && depth < 6 && !heading; node = apply(parentOf, node, []), depth++) {
      const found = apply(queryAll, node, ['h1, h2, h3']);
      for (let i = found.length - 1; i >= 0; i--) {
        if (apply(position, found[i], [el]) & FOLLOWING) {
          heading = words(apply(innerTextOf, found[i], []));
          break;
        }
      }
    }
    if (!heading) {
      const h1 = apply(docQuery, doc, ['h1']);
      if (h1) heading = words(apply(innerTextOf, h1, []));
    }
    return { button, title: words(apply(titleOf, doc, [])), heading, at: now() };
  }

  function pressed(event) {
    // The second click of a double click is the same press (the button may
    // already show a spinner instead of its words).
    if (!event.isTrusted || event.detail > 1) return;
    // Every real click replaces the last press, so an earlier button is never
    // shown for a request that followed a click on something else.
    lastPress = null;
    try {
      lastPress = pressOf(event.target);
    } catch {
      // Whatever the page did to its own DOM, the review goes on without it.
    }
  }
  apply(addListener, doc, ['click', pressed, true]);

  /** The press, if it came just before this request (15 s). */
  function promiseNow() {
    if (!lastPress) return undefined;
    const ageMs = now() - lastPress.at;
    if (ageMs < 0 || ageMs > 15000) return undefined;
    return { button: lastPress.button, title: lastPress.title, heading: lastPress.heading, ageMs };
  }

  // ── Read-only context, fetched through the user's own wallet ───────────
  // Through the provider's request() as Guardian first found it. When the
  // provider has been given another request() since (a wallet that put a
  // placeholder first, or builds a new one for each network it switches to;
  // or a function the page assigned), that one is asked too, at once, and
  // neither is taken on its word: an answer both give is used; where they
  // differ there is none (the network is then unknown), except a balance,
  // where the smaller counts, since it can only raise the risk. Only where
  // one fails, or gives no answer within half a second, does the other's
  // answer count alone. So a function the page assigns later can set the
  // context only where the wallet's own fails or is slow. A provider the
  // page builds itself (assigned to window.ethereum or announced through
  // EIP-6963) is read the same way, so such a provider can hand the review
  // its own balance, accounts or network (the README says so under Limits);
  // the analyzer lets that context only raise the risk. Answers are read
  // with the then() captured above, and one that is not a native promise
  // through the Promise captured above.
  // provider → { first: its request() as first found, state: its guard's state }
  const origins = new WeakMapCtor();
  const READ_ONLY = dict();
  for (const name of ['eth_chainId', 'eth_accounts', 'eth_getCode', 'eth_getBalance', 'eth_call']) READ_ONLY[name] = true;

  const isHexDigit = (c) => (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
  /** "0x" and then between min and max hex digits. */
  function isHex(value, min, max) {
    if (typeof value !== 'string' || value.length < 2 + min || value.length > 2 + max) return false;
    if (value[0] !== '0' || value[1] !== 'x') return false;
    for (let i = 2; i < value.length; i++) if (!isHexDigit(value[i])) return false;
    return true;
  }
  const isAddress = (value) => isHex(value, 40, 40);

  /** Whether two answers are the same JSON data. */
  function agree(a, b) {
    try {
      return jsonOf(a) === jsonOf(b);
    } catch {
      return false;
    }
  }

  /** Of two balances (hex), the smaller (or the only one that is a balance): it can only raise the risk. */
  function smaller(a, b) {
    const aIs = isHex(a, 1, Infinity);
    const bIs = isHex(b, 1, Infinity);
    if (!aIs || !bIs) return aIs ? a : bIs ? b : undefined;
    const digits = (value) => {
      let i = 2;
      while (i < value.length - 1 && value[i] === '0') i++;
      return lower(slice(value, i));
    };
    const x = digits(a);
    const y = digits(b);
    if (x.length !== y.length) return x.length < y.length ? a : b;
    return x <= y ? a : b;
  }

  /**
   * Calls done once: with the wallet's answer, or undefined when there is
   * none (an error, nothing within 1.5 s, or two answers that differ; see
   * above). `merge`, if given, picks the one to use when they differ.
   */
  function readFromWallet(provider, method, params, done, merge) {
    let finished = false;
    let timer = null;
    let slow = null;
    const finish = (value) => {
      if (finished) return;
      finished = true;
      if (timer !== null) clearTimer(timer);
      if (slow !== null) clearTimer(slow);
      done(value);
    };
    const found = apply(mapGet, origins, [provider]);
    if (READ_ONLY[method] !== true || found === undefined) {
      finish(undefined);
      return;
    }
    // Each call gets a copy of its own: one side cannot change what the other reads.
    const paramsText = params === undefined ? null : jsonOf(params);
    const call = () => (paramsText === null ? { method } : { method, params: parse(paramsText) });
    // Each side: 0 waiting, 1 answered, 2 failed (or, for the request() put
    // in place since, not asked).
    let first = 0;
    let firstValue;
    let since = 2;
    let sinceValue;
    let asked = false;
    let late = false;
    const decide = () => {
      if (finished) return;
      if (first === 1 && since === 1) {
        finish(agree(firstValue, sinceValue) ? firstValue : merge ? merge(firstValue, sinceValue) : undefined);
      } else if (first === 1 || since === 1) {
        // The other failed, or is still silent after half a second.
        if ((first === 1 ? since : first) === 2 || late) finish(first === 1 ? firstValue : sinceValue);
      } else if (first === 2 && since === 2) {
        finish(undefined);
      }
    };
    const attempt = (ask, take) => {
      const answered = (value) => take(1, value);
      const failed = () => take(2);
      let answer;
      try {
        answer = ask();
      } catch {
        failed();
        return;
      }
      if (answer === null || (typeof answer !== 'object' && typeof answer !== 'function')) {
        answered(answer);
        return;
      }
      try {
        apply(promiseThen, answer, [answered, failed]);
      } catch {
        // Not a native promise: a wallet may answer with the page's own Promise,
        // and a page may have replaced it (zone.js does, in Angular apps). It is
        // taken in through the Promise captured above, as any thenable; like any
        // context, what it gives is only the page's word (README, Limits).
        try {
          apply(promiseThen, new PromiseCtor((resolve) => resolve(answer)), [answered, failed]);
        } catch {
          failed();
        }
      }
    };
    /** Asks the request() the provider was given since, once, if it has one. */
    const askSince = () => {
      const state = found.state;
      if (finished || asked || state.target === found.first) return;
      asked = true;
      since = 0;
      attempt(
        () => handOn(state, provider, call(), null),
        (status, value) => {
          if (since !== 0) return;
          since = status;
          sinceValue = value;
          decide();
        },
      );
    };
    timer = setTimer(() => finish(undefined), 1500);
    slow = setTimer(() => {
      late = true;
      askSince();
      decide();
    }, 500);
    askSince();
    attempt(
      () => apply(found.first, provider, [call()]),
      (status, value) => {
        if (first !== 0) return;
        first = status;
        firstValue = value;
        // A placeholder that refuses: ask the one put in place since, if any.
        if (status === 2) askSince();
        decide();
      },
    );
  }

  function decodeString(hex) {
    if (!isHex(hex, 0, Infinity)) return null;
    const h = slice(hex, 2);
    const toText = (bytesHex) => {
      let out = '';
      for (let i = 0; i + 1 < bytesHex.length; i += 2) {
        const code = toInt(slice(bytesHex, i, i + 2), 16);
        if (code === 0) break;
        if (code < 32 || code > 126) return null;
        out += charOf(code);
      }
      return out || null;
    };
    if (h.length === 64) return toText(h); // bytes32 symbol (old tokens)
    if (h.length >= 128) {
      const length = toInt(slice(h, 64, 128), 16);
      if (isFiniteNumber(length) && length > 0 && length <= 64) {
        return toText(slice(h, 128, 128 + length * 2));
      }
    }
    return null;
  }

  const TOKEN_CALLS = dict();
  for (const selector of ['0x095ea7b3', '0x39509351', '0xa22cb465', '0xa9059cbb', '0x23b872dd']) TOKEN_CALLS[selector] = true;

  function targets(method, params) {
    try {
      if (method === 'eth_sendTransaction' || method === 'eth_signTransaction') {
        const tx = own(params, 0);
        const to = own(tx, 'to');
        const data = own(tx, 'data') || own(tx, 'input');
        if (tx && typeof to === 'string' && typeof data === 'string' && data.length >= 74) {
          const selector = lower(slice(data, 0, 10));
          if (TOKEN_CALLS[selector] === true) {
            return {
              token: to,
              spender: `0x${slice(data, 34, 74)}`,
              isNft: selector === '0xa22cb465',
              owner: own(tx, 'from'),
              // Plain transfer: how much of this token the wallet holds.
              wantsTokenBalance: selector === '0xa9059cbb',
            };
          }
        }
        if (tx && (typeof data !== 'string' || data.length <= 2)) {
          // Plain payment: how much of the wallet's coins it sends.
          return { token: null, spender: null, owner: own(tx, 'from'), wantsBalance: true };
        }
      } else if (method === 'eth_signTypedData_v4' || method === 'eth_signTypedData_v3') {
        const raw = own(params, 1);
        const typed = typeof raw === 'string' ? parse(raw) : raw;
        const domain = own(typed, 'domain');
        const message = own(typed, 'message');
        if (own(typed, 'primaryType') === 'Permit' && domain && message) {
          return { token: own(domain, 'verifyingContract'), spender: own(message, 'spender') };
        }
        if (message && typeof own(message, 'spender') === 'string') {
          return { token: null, spender: own(message, 'spender') };
        }
      }
    } catch {
      // Unreadable request: the analyzer reports that; no extra context here.
    }
    return null;
  }

  /** Reads the context, then calls done once with its JSON members as text. */
  function gatherContext(provider, method, params, done) {
    const target = targets(method, params);
    const wantsToken = !!(target && isAddress(target.token) && !target.isNft);
    let chainId = null;
    let accounts = null;
    let spenderIsContract = null;
    let balance = null;
    let tokenBalance = null;
    let symbol = null;
    let decimals = null;
    let waiting = 1;
    const settle = () => {
      waiting -= 1;
      if (waiting !== 0) return;
      let enrich = '';
      const add = (member) => {
        enrich += `${enrich ? ',' : ''}${member}`;
      };
      if (accounts !== null) add(`"accounts":${accounts}`);
      if (spenderIsContract !== null) add(`"spenderIsContract":${spenderIsContract ? 'true' : 'false'}`);
      if (balance !== null) add(`"balance":${jsonText(balance)}`);
      if (tokenBalance !== null) add(`"tokenBalance":${jsonText(tokenBalance)}`);
      if (wantsToken) {
        let token = symbol !== null ? `"symbol":${jsonText(symbol)}` : '';
        if (decimals !== null) token += `${token ? ',' : ''}"decimals":${jsonNumber(decimals)}`;
        add(`"token":{${token}}`);
      }
      done(`"chainId":${jsonNumber(chainId)},"enrich":{${enrich}}`);
    };
    const read = (readMethod, readParams, use, merge) => {
      waiting += 1;
      readFromWallet(
        provider,
        readMethod,
        readParams,
        (value) => {
          try {
            use(value);
          } catch {
            // An odd answer adds nothing.
          }
          settle();
        },
        merge,
      );
    };

    read('eth_chainId', undefined, (v) => {
      const n = typeof v === 'string' ? toInt(v, 16) : typeof v === 'number' ? v : NaN;
      if (isFiniteNumber(n)) chainId = n;
    });
    // The user's own accounts, so Guardian can keep them out of anything
    // that may go to the cloud. Read-only; the wallet does not ask.
    read('eth_accounts', undefined, (v) => {
      if (!isArray(v)) return;
      let list = '';
      for (let i = 0, count = 0; i < v.length && count < 10; i++) {
        const account = own(v, i);
        if (!isAddress(account)) continue;
        list += `${count ? ',' : ''}${jsonText(account)}`;
        count++;
      }
      accounts = `[${list}]`;
    });
    if (target && isAddress(target.spender)) {
      read('eth_getCode', [target.spender, 'latest'], (code) => {
        if (typeof code === 'string') spenderIsContract = code.length > 2;
      });
    }
    if (target && target.wantsBalance && isAddress(target.owner)) {
      read(
        'eth_getBalance',
        [target.owner, 'latest'],
        (v) => {
          if (isHex(v, 1, Infinity)) balance = v;
        },
        smaller,
      );
    }
    if (target && target.wantsTokenBalance && isAddress(target.owner) && isAddress(target.token)) {
      const data = `0x70a08231000000000000000000000000${lower(slice(target.owner, 2))}`;
      read(
        'eth_call',
        [{ to: target.token, data }, 'latest'],
        (v) => {
          if (isHex(v, 1, 64)) tokenBalance = v;
        },
        smaller,
      );
    }
    if (wantsToken) {
      read('eth_call', [{ to: target.token, data: '0x95d89b41' }, 'latest'], (v) => {
        const found = decodeString(v);
        if (found) symbol = found;
      });
      read('eth_call', [{ to: target.token, data: '0x313ce567' }, 'latest'], (v) => {
        const n = typeof v === 'string' && v.length > 2 ? toInt(v, 16) : NaN;
        if (isWholeNumber(n) && n >= 0 && n <= 36) decimals = n;
      });
    }
    settle();
  }

  // ── Review ─────────────────────────────────────────────────────────────
  function rejection(decision) {
    const error = new ErrorCtor(
      decision === 'reject'
        ? 'IBITI Guardian: the user rejected this request.'
        : 'IBITI Guardian could not review this request, so it was not sent to the wallet. Reload the page and try again.',
    );
    // EIP-1193 userRejectedRequest
    defineProp(error, 'code', { __proto__: null, value: 4001, writable: true, enumerable: true, configurable: true });
    return error;
  }

  function invalidRequest() {
    const error = new ErrorCtor('IBITI Guardian: this request is not plain data, so it could not be reviewed.');
    // JSON-RPC invalid request
    defineProp(error, 'code', { __proto__: null, value: -32600, writable: true, enumerable: true, configurable: true });
    return error;
  }

  const refused = (error) => new PromiseCtor((resolve, reject) => reject(error));

  /**
   * Shows one request to the user and calls decided once: 'allow', 'reject'
   * or 'error'. `request` is the exact JSON text the wallet will receive;
   * Guardian's window reads the method and params from it.
   */
  function review(provider, method, params, request, decided) {
    // The press that led to this request, taken before anything is awaited.
    const press = promiseNow();
    let answered = false;
    const answer = (decision) => {
      if (answered) return;
      answered = true;
      decided(decision);
    };
    let asked = false;
    const go = (context) => {
      if (asked) return;
      asked = true;
      try {
        // method and params again, for the preview on the hosted demo.
        let fields = `"request":${request},"method":${jsonText(method)},"params":${jsonOf(params)},${context}`;
        if (press) {
          fields += `,"promise":{"button":${jsonText(press.button)},"title":${jsonText(press.title)},"heading":${jsonText(press.heading)},"ageMs":${jsonNumber(press.ageMs)}}`;
        }
        ask(fields, answer);
      } catch {
        answer('error');
      }
    };
    try {
      gatherContext(provider, method, params, go);
    } catch {
      go('"chainId":null,"enrich":{}');
    }
  }

  // ── Wrapping providers ─────────────────────────────────────────────────
  // Some wallets replace their own request() after they are created
  // (TronLink does), which would silently drop a one-time wrapper. Each
  // guarded method is therefore an accessor: reading it always gives the
  // wrapper, and assigning a new function only changes what the wrapper
  // calls. Known providers are also re-checked, in case a wallet redefines
  // the property outright.
  const known = dict();
  let knownCount = 0;
  const LEGACY = ['send', 'sendAsync'];

  /**
   * Whether `fn` is a wrapper of another Guardian (in a same-origin frame
   * given this page's provider, or the other way round): such a provider is
   * guarded there already and is not wrapped again here. Each wrapper is
   * branded with its own document; it counts only if that document is shown
   * in a window and its mark, set by Guardian there before any script of
   * that page ran, says the function is one of its wrappers. A brand a page
   * puts on a function of its own does not count: the page cannot change the
   * mark of a document where Guardian runs.
   */
  function isOtherGuardian(fn) {
    try {
      const issuer = own(ownDescriptor(fn, BRAND), 'value');
      const view = apply(viewOf, issuer, []);
      if (!view || view.document !== issuer) return false;
      const mark = ownDescriptor(issuer, MARK);
      const vouch = own(mark, 'value');
      if (typeof vouch !== 'function' || own(mark, 'configurable') !== false) return false;
      return apply(vouch, undefined, [fn]) === true;
    } catch {
      return false;
    }
  }
  const isGuarded = (fn) => isWrapper(fn) || isOtherGuardian(fn);

  // A provider that is a Proxy may hand out every function it holds bound
  // anew (v.bind(target)): reading the method then never gives the wrapper
  // itself, though Guardian's accessor is in place, and each re-check would
  // wrap it once more, until the stack overflows. The accessor Guardian put
  // there is known by its getter, kept here, which no page can add to. A
  // getter a page copies elsewhere still hands out only Guardian's wrapper.
  const getters = new WeakSetCtor();
  function installedOn(provider, name) {
    try {
      return apply(setHas, getters, [own(ownDescriptor(provider, name), 'get')]);
    } catch {
      return false;
    }
  }

  /**
   * Calls the wallet's current implementation. If that implementation leads
   * straight back into the wrapper (a wallet re-binding the method it just
   * read, i.e. the wrapper itself), the inner call goes to the last
   * implementation known not to loop (base; the one before it is kept as
   * below, for one found to call back later, see handOn).
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
      if (!state.reentered && state.base !== state.target && !isLooper(state.target)) {
        state.below = state.base;
        state.base = state.target;
      }
    }
  }

  // ── A call back from a forward that has not settled yet ────────────────
  // through() catches a call back made at once. A function in the wallet's
  // place (an analytics wrapper or a request queue a page assigns) may call
  // the method it read earlier, i.e. the wrapper, after an await: past that
  // check, so it would be handed to the same function again, for ever.
  // While what such a function returned has not settled (read with the
  // then() captured above), the object Guardian handed it is remembered.
  // That very object coming back into the same wrapper is such a call: it
  // goes to the implementation below that function, never to it again, and
  // that function is not again taken for one that does not loop. A request
  // the user allowed is delivered there: once, without a second review, and
  // only if nothing delivered it on the way down already. Anything else (a
  // second time, another request, one changed on the way) is reviewed as
  // usual. Only a function other than the one Guardian first found is
  // watched: the wallet's own does not call back.
  const handed = new WeakMapCtor();
  const loopers = new WeakSetCtor();
  const isLooper = (fn) => apply(setHas, loopers, [fn]);

  /**
   * Forwards one call made at the top of the wrapper (none of its own is
   * running) with `value`, the call's own copy. `key` is set for a request
   * the user allowed.
   */
  function handOn(state, self, value, key) {
    const run = () => through(state, self, [value]);
    if (state.depth > 0 || state.target === state.root) return key === null ? run() : passAllowed(key, run);
    const record = { __proto__: null, state, from: state.target, key, pass: key !== null };
    const result = key === null ? run() : passAllowed(key, run, record);
    if (result !== null && (typeof result === 'object' || typeof result === 'function')) {
      apply(mapSet, handed, [value, record]);
      const settled = () => {
        apply(mapDelete, handed, [value]);
      };
      try {
        apply(promiseThen, result, [settled, settled]);
      } catch {
        try {
          apply(promiseThen, new PromiseCtor((resolve) => resolve(result)), [settled, settled]);
        } catch {
          settled();
        }
      }
    }
    return result;
  }

  /** The record of a forward of this wrapper `arg` was handed by, if it is still running. */
  function cameBack(state, arg) {
    if (arg === null || typeof arg !== 'object') return null;
    const record = apply(mapGet, handed, [arg]);
    if (record === undefined || record.state !== state) return null;
    apply(setAdd, loopers, [record.from]);
    if (isLooper(state.base)) state.base = state.below;
    return record;
  }

  /** Calls the implementation below the one `record` was handed to. */
  function below(state, record, self, args) {
    const to = state.base !== record.from ? state.base : state.root;
    state.depth++;
    try {
      return apply(to, self, args);
    } finally {
      state.depth--;
    }
  }

  /**
   * A private copy of what the page passed. The page keeps its own object and
   * could change it while the user is reading the review, or use a getter
   * that answers differently each time. Guardian reviews the copy's text and
   * the wallet receives a copy of that same text, so what was reviewed is
   * what gets signed. Returns null for anything that is not plain JSON data.
   */
  function snapshotOf(value) {
    try {
      const text = stringify(value);
      if (typeof text !== 'string') return null;
      return { __proto__: null, text, value: parse(text) };
    } catch {
      return null;
    }
  }

  // ── What the wallet's copy inherits ────────────────────────────────────
  // The wallet gets a fresh copy of the reviewed text. Its objects inherit
  // from the page's Object.prototype and its arrays from Array.prototype, so
  // a key the page adds there (a getter named data, a toJSON) would change
  // what a wallet that reads fields by name, or serializes in the page, gets.
  // No such key is there when Guardian starts; while one is, a request is
  // neither shown nor passed on.
  const startObjectKeys = ownKeys(ObjectProto);
  const startArrayKeys = ownKeys(ArrayProto);
  const listed = (list, key) => {
    for (let i = 0; i < list.length; i++) if (list[i] === key) return true;
    return false;
  };
  const isDigits = (key) => {
    if (typeof key !== 'string' || key.length === 0) return false;
    for (let i = 0; i < key.length; i++) if (key[i] < '0' || key[i] > '9') return false;
    return true;
  };
  function inheritedChanged() {
    try {
      if (protoOf(ArrayProto) !== ObjectProto) return true;
      const objectKeysNow = ownKeys(ObjectProto);
      for (let i = 0; i < objectKeysNow.length; i++) if (!listed(startObjectKeys, objectKeysNow[i])) return true;
      // Array.prototype may gain helpers; only a toJSON or an index is read as data.
      const arrayKeysNow = ownKeys(ArrayProto);
      for (let i = 0; i < arrayKeysNow.length; i++) {
        const key = arrayKeysNow[i];
        if ((key === 'toJSON' || isDigits(key)) && !listed(startArrayKeys, key)) return true;
      }
      return false;
    } catch {
      return true;
    }
  }

  // Requests the user has just allowed, while they travel down to the wallet.
  // If the wallet's own implementation (or another wrapper in between) hands
  // the same request back to a Guardian wrapper, it is not reviewed a second
  // time. An entry lives only for the synchronous call (one made after an
  // await is handOn's) and matches the exact request (all but its JSON-RPC id
  // and version, which a wallet may add on the way down, and a top-level
  // from). It lets the request through once; the wrapper that takes
  // it passes it on once more, to calls made from inside its own forward
  // (send calling sendAsync calling request), so a chain of wrappers sees it
  // once but a second call alongside the first is reviewed again. A call the
  // page makes from inside the wallet's own handling (through a built-in the
  // wallet uses) cannot be told from the wallet's own: a wallet that runs in
  // the page can be made to get the allowed request more than once (README,
  // Limits).
  const allowed = dict();
  const SKIPPED = dict();
  // A top-level from (sendAsync({ method, params, from }), as old MetaMask
  // docs wrote it) is ignored by wallets, and dropped on the way down by some
  // (Rabby's sendAsync calls its request() without it): the signer is in params.
  for (const name of ['method', 'params', 'id', 'jsonrpc', 'from']) SKIPPED[name] = true;

  /** The exact text of a request, method and params first, without id, jsonrpc and a top-level from. */
  function allowKey(request) {
    let key = `{"method":${jsonText(own(request, 'method'))},"params":${jsonOf(own(request, 'params'))}`;
    const keys = objectKeys(request);
    for (let i = 0; i < keys.length; i++) {
      if (SKIPPED[keys[i]] !== true) key += `,${stringify(keys[i])}:${jsonOf(own(request, keys[i]))}`;
    }
    return `${key}}`;
  }

  /** `record` (see handOn), if given, learns whether a call on the way down took the pass. */
  function passAllowed(key, run, record) {
    const before = allowed[key] || 0;
    allowed[key] = before + 1;
    try {
      return run();
    } finally {
      if (record && !((allowed[key] || 0) > before)) record.pass = false;
      if (before > 0) allowed[key] = before;
      else delete allowed[key];
    }
  }

  function takeAllowed(key) {
    const left = allowed[key];
    if (!(left > 0)) return false;
    if (left > 1) allowed[key] = left - 1;
    else delete allowed[key];
    return true;
  }

  /** Forwards an allowed request, which calls nested in this one may pass once. */
  const passOn = (key, state, self, args) => passAllowed(key, () => through(state, self, args));

  function requestWrapper(provider, state) {
    return function request(args) {
      const self = this === undefined ? provider : this;
      // Called back from inside the implementation: it loops, so it never
      // becomes the one re-entered calls go to.
      if (state.depth > 0) state.reentered = true;
      // Called back later, with the very object a forward of this wrapper
      // handed down and that has not settled yet (see handOn).
      const back = state.depth > 0 ? null : cameBack(state, args);
      // Every call, also one made from inside the wallet's implementation (or
      // from a function the page put in its place), is read from a copy.
      const snap = snapshotOf(args);
      const method = snap ? own(snap.value, 'method') : undefined;
      if (typeof method !== 'string') return refused(invalidRequest());
      if (!isReviewed(method)) {
        if (back !== null) return below(state, back, self, [snap.value]);
        return handOn(state, self, snap.value, null);
      }

      // Every request held here carries params; one that leaves them out
      // could have them filled in from a prototype when the wallet reads it.
      const params = own(snap.value, 'params');
      if (params === undefined) return refused(invalidRequest());
      let key;
      try {
        key = allowKey(snap.value);
      } catch {
        return refused(invalidRequest());
      }
      if (inheritedChanged()) return refused(rejection('error'));
      if (takeAllowed(key)) return handOn(state, self, snap.value, key);
      // Allowed, and back unchanged from the function it was handed to.
      if (back !== null && back.pass && back.key === key) {
        back.pass = false;
        return passAllowed(key, () => below(state, back, self, [snap.value]));
      }

      return new PromiseCtor((resolve, reject) => {
        review(provider, method, params, snap.text, (decision) => {
          if (decision !== 'allow') {
            reject(rejection(decision));
            return;
          }
          // Again: the page may have added a key while the user was reading.
          if (inheritedChanged()) {
            reject(rejection('error'));
            return;
          }
          try {
            // A fresh copy for the wallet: the reviewed one was shown to the user.
            resolve(handOn(state, self, parse(snap.text), key));
          } catch (error) {
            reject(error);
          }
        });
      });
    };
  }

  function refuseLegacy(callback, error) {
    if (typeof callback === 'function') {
      callback(error, null);
      return undefined;
    }
    throw error;
  }

  function legacyWrapper(provider, state) {
    return function (first, second) {
      const self = this === undefined ? provider : this;
      if (state.depth > 0) state.reentered = true;

      // send(method, params) → Promise
      if (typeof first === 'string') {
        if (!isReviewed(first)) return through(state, self, arguments);
        const snap = snapshotOf(second === undefined ? [] : second);
        if (!snap) return refused(invalidRequest());
        let key;
        try {
          key = allowKey({ __proto__: null, method: first, params: snap.value });
        } catch {
          return refused(invalidRequest());
        }
        if (inheritedChanged()) return refused(rejection('error'));
        if (takeAllowed(key)) return passOn(key, state, self, [first, snap.value]);
        const request = `{"method":${jsonText(first)},"params":${snap.text}}`;
        return new PromiseCtor((resolve, reject) => {
          review(provider, first, snap.value, request, (decision) => {
            if (decision !== 'allow') {
              reject(rejection(decision));
              return;
            }
            if (inheritedChanged()) {
              reject(rejection('error'));
              return;
            }
            try {
              resolve(passOn(key, state, self, [first, parse(snap.text)]));
            } catch (error) {
              reject(error);
            }
          });
        });
      }

      // send(payload, callback) / sendAsync(payload, callback)
      // A payload that is not plain data cannot be reviewed: refused, never
      // passed, as request() does.
      const snap = snapshotOf(first);
      const payload = snap ? snap.value : null;
      if (payload === null || typeof payload !== 'object') return refuseLegacy(second, invalidRequest());
      // Each request names its method itself; one the page could hide on a
      // prototype cannot be checked.
      let reviewed = false;
      if (isArray(payload)) {
        for (let i = 0; i < payload.length; i++) {
          const method = own(own(payload, i), 'method');
          if (typeof method !== 'string') return refuseLegacy(second, invalidRequest());
          if (isReviewed(method)) reviewed = true;
        }
      } else {
        const method = own(payload, 'method');
        if (typeof method !== 'string') return refuseLegacy(second, invalidRequest());
        reviewed = isReviewed(method);
      }
      if (!reviewed) {
        return typeof second === 'function'
          ? through(state, self, [payload, second])
          : through(state, self, [payload]);
      }
      // Batches and synchronous signing cannot be shown one by one: refuse.
      if (isArray(payload) || typeof second !== 'function') return refuseLegacy(second, rejection('error'));

      const method = own(payload, 'method');
      const params = own(payload, 'params');
      if (params === undefined) return refuseLegacy(second, invalidRequest());
      let key;
      try {
        key = allowKey(payload);
      } catch {
        return refuseLegacy(second, invalidRequest());
      }
      if (inheritedChanged()) return refuseLegacy(second, rejection('error'));
      if (takeAllowed(key)) return passOn(key, state, self, [payload, second]);
      review(provider, method, params, snap.text, (decision) => {
        if (decision !== 'allow') {
          second(rejection(decision), null);
          return;
        }
        if (inheritedChanged()) {
          second(rejection('error'), null);
          return;
        }
        try {
          passOn(key, state, self, [parse(snap.text), second]);
        } catch (error) {
          second(error, null);
        }
      });
      return undefined;
    };
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
    let seen = false;
    for (let i = 0; i < knownCount && !seen; i++) seen = known[i] === provider;
    if (!seen) known[knownCount++] = provider;

    if (!isGuarded(current) && !installedOn(provider, 'request')) {
      // root: the implementation this guard started with (see handOn).
      const state = { __proto__: null, target: current, base: current, below: current, root: current, depth: 0, reentered: false };
      // The wallet's own request(), as first found: context is read with it,
      // and with the newest guard's state, which follows what replaced it.
      const found = apply(mapGet, origins, [provider]);
      if (found === undefined) apply(mapSet, origins, [provider, { __proto__: null, first: current, state }]);
      else found.state = state;
      install(provider, 'request', requestWrapper(provider, state), state);
    }
    if (apply(mapGet, origins, [provider]) === undefined) return;

    for (let i = 0; i < LEGACY.length; i++) {
      const name = LEGACY[i];
      let legacy;
      try {
        legacy = provider[name];
      } catch {
        continue;
      }
      if (typeof legacy !== 'function' || isGuarded(legacy) || installedOn(provider, name)) continue;
      const state = { __proto__: null, target: legacy, base: legacy, below: legacy, root: legacy, depth: 0, reentered: false };
      install(provider, name, legacyWrapper(provider, state), state);
    }
  }

  function install(provider, name, wrapper, state) {
    apply(setAdd, wrappers, [wrapper]);
    // Another Guardian reads this to ask this document's mark (isOtherGuardian).
    defineProp(wrapper, BRAND, { __proto__: null, value: doc });
    const accessor = {
      __proto__: null,
      configurable: true,
      enumerable: true,
      get() {
        return wrapper;
      },
      set(next) {
        // The wallet swapped its implementation: keep guarding the new one.
        if (typeof next === 'function' && !isWrapper(next)) state.target = next;
      },
    };
    apply(setAdd, getters, [accessor.get]);
    try {
      defineProp(provider, name, accessor);
    } catch {
      try {
        provider[name] = wrapper;
      } catch {
        // Frozen provider: cannot be wrapped.
      }
    }
  }

  function guardKnown() {
    for (let i = 0; i < knownCount; i++) guard(known[i]);
  }

  function guardGlobal() {
    try {
      const provider = window.ethereum;
      if (provider) {
        guard(provider);
        const list = provider.providers;
        if (isArray(list)) for (let i = 0; i < list.length; i++) guard(list[i]);
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
        const detail = apply(detailOf, event, []);
        guard(detail && detail.provider);
      } catch {
        // ignore malformed announcements
      }
    },
    true,
  ]);

  // window.ethereum: a wallet that injects after this script is wrapped the
  // moment it assigns itself. If no wallet shows up, the placeholder is removed
  // so pages that check `'ethereum' in window` still see "no wallet". Only a
  // property of the window itself counts as a wallet already there: the page's
  // markup (<html id="ethereum">) also shows up as window.ethereum, and must
  // not keep the trap away.
  let trapped = false;
  if (!apply(hasOwn, window, ['ethereum'])) {
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
        const descriptor = ownDescriptor(window, 'ethereum');
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
